'use client';

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
} from 'firebase/firestore';
import { getDb, iceServers, firebaseConfigured } from '../firebase/client';
import { decode, encode, type NetMessage } from './protocol';
import type { MatchRules } from '../game/types';
import type { RelayRoomRules } from '../game/relay';

/**
 * Firestore를 시그널링에만 쓰는 P2P 연결.
 *
 * Firestore 사용량:
 *   방 생성      쓰기 1 (offer 포함)
 *   ICE 후보     쓰기 n (보통 5~15개, 연결 후 정리)
 *   입장         쓰기 1 (answer)
 *   경기 진행    쓰기 0  <- 모든 게임 트래픽은 DataChannel로만 흐른다
 */

export type ConnState = 'idle' | 'creating' | 'waiting' | 'connecting' | 'connected' | 'failed' | 'closed';

export type RoomMode = '1v1' | '2v2' | 'relay';

export interface RoomInfo {
  id: string;
  hostUid: string;
  hostName: string;
  teamName: string;
  status: 'waiting' | 'playing' | 'closed';
  createdAt: number;
  isPrivate: boolean;
  /** 없으면 1:1 (mode 필드가 생기기 전에 만들어진 방) */
  mode?: RoomMode;
  /** 다인 방에서 현재 들어와 있는 인원 (호스트 포함) */
  playerCount?: number;
  /** 다인 방 정원. 이전 2대2 방은 없으며 4명으로 간주한다. */
  maxPlayers?: number;
  /**
   * 이 방의 경기 규칙. 목록에서 들어가기 전에 확인할 수 있도록 함께 적어 둔다.
   * (연결된 게스트에게는 ROOM_RULES 메시지로 실시간 반영된다)
   * 없으면 규칙 기능이 생기기 전에 만들어진 방이다.
   */
  rules?: MatchRules;
  /** 릴레이 타격 대결의 대기실 규칙. */
  relayRules?: RelayRoomRules;
}

export interface PeerHandlers {
  onMessage: (msg: NetMessage) => void;
  onState: (state: ConnState) => void;
  onError?: (err: string) => void;
}

const CHANNEL_LABEL = 'game';

export class PeerConnection {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private unsubs: (() => void)[] = [];
  private handlers: PeerHandlers;
  private roomId: string | null = null;
  private isHost = false;
  /** 채널이 열리기 전에 보낸 메시지를 담아둔다 */
  private outbox: NetMessage[] = [];

  constructor(handlers: PeerHandlers) {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.channel?.readyState === 'open';
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  // -------------------------------------------------------------------------

  private createPc(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers(), iceCandidatePoolSize: 4 });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.handlers.onState('connected');
      else if (s === 'failed') {
        this.handlers.onState('failed');
        this.handlers.onError?.('P2P 연결에 실패했습니다. 네트워크(NAT) 환경에 따라 TURN 서버가 필요할 수 있습니다.');
      } else if (s === 'disconnected' || s === 'closed') {
        this.handlers.onState('closed');
      }
    };
    return pc;
  }

  private bindChannel(ch: RTCDataChannel) {
    this.channel = ch;
    ch.onopen = () => {
      this.handlers.onState('connected');
      // 대기 중이던 메시지 전송
      const pending = this.outbox.splice(0);
      for (const m of pending) ch.send(encode(m));
    };
    ch.onclose = () => this.handlers.onState('closed');
    ch.onmessage = (e) => {
      const msg = decode(typeof e.data === 'string' ? e.data : '');
      if (msg) this.handlers.onMessage(msg);
    };
  }

  // -------------------------------------------------------------------------
  // 호스트: 방 생성
  // -------------------------------------------------------------------------

  async host(opts: {
    hostUid: string;
    hostName: string;
    teamName: string;
    isPrivate?: boolean;
    rules: MatchRules;
  }): Promise<string> {
    const db = getDb();
    if (!firebaseConfigured || !db) {
      throw new Error('온라인 대전에는 Firebase 설정이 필요합니다. .env.local을 확인하세요.');
    }
    this.isHost = true;
    this.handlers.onState('creating');

    const pc = this.createPc();
    this.pc = pc;

    // 호스트가 채널을 만든다
    const ch = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    this.bindChannel(ch);

    const roomRef = doc(collection(db, 'rooms'));
    this.roomId = roomRef.id;
    const hostCandidates = collection(roomRef, 'hostCandidates');
    const guestCandidates = collection(roomRef, 'guestCandidates');

    pc.onicecandidate = (e) => {
      if (e.candidate) void addDoc(hostCandidates, e.candidate.toJSON());
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const info: RoomInfo = {
      id: roomRef.id,
      hostUid: opts.hostUid,
      hostName: opts.hostName,
      teamName: opts.teamName,
      status: 'waiting',
      createdAt: Date.now(),
      isPrivate: opts.isPrivate ?? false,
      mode: '1v1',
      playerCount: 1,
      rules: opts.rules,
    };

    await setDoc(roomRef, {
      ...info,
      createdAtServer: serverTimestamp(),
      offer: { type: offer.type, sdp: offer.sdp },
    });

    this.handlers.onState('waiting');

    // answer 수신 대기
    this.unsubs.push(
      onSnapshot(roomRef, (snap) => {
        const data = snap.data();
        if (!data) return;
        if (data.answer && !pc.currentRemoteDescription) {
          this.handlers.onState('connecting');
          void pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
      }),
    );

    // 게스트 ICE 후보 수신
    this.unsubs.push(
      onSnapshot(guestCandidates, (snap) => {
        snap.docChanges().forEach((c) => {
          if (c.type === 'added') {
            void pc.addIceCandidate(new RTCIceCandidate(c.doc.data() as RTCIceCandidateInit));
          }
        });
      }),
    );

    return roomRef.id;
  }

  // -------------------------------------------------------------------------
  // 게스트: 방 입장
  // -------------------------------------------------------------------------

  async join(roomId: string): Promise<void> {
    const db = getDb();
    if (!firebaseConfigured || !db) {
      throw new Error('온라인 대전에는 Firebase 설정이 필요합니다.');
    }
    this.isHost = false;
    this.handlers.onState('connecting');
    this.roomId = roomId;

    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) throw new Error('방을 찾을 수 없습니다.');
    const data = snap.data();
    if (data.mode === '2v2') throw new Error('2대2 방입니다. 2대2 로비에서 입장하세요.');
    if (data.status !== 'waiting') throw new Error('이미 시작되었거나 종료된 방입니다.');
    if (!data.offer) throw new Error('방 정보가 올바르지 않습니다.');

    const pc = this.createPc();
    this.pc = pc;

    pc.ondatachannel = (e) => {
      if (e.channel.label === CHANNEL_LABEL) this.bindChannel(e.channel);
    };

    const hostCandidates = collection(roomRef, 'hostCandidates');
    const guestCandidates = collection(roomRef, 'guestCandidates');

    pc.onicecandidate = (e) => {
      if (e.candidate) void addDoc(guestCandidates, e.candidate.toJSON());
    };

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await updateDoc(roomRef, {
      answer: { type: answer.type, sdp: answer.sdp },
      status: 'playing',
    });

    this.unsubs.push(
      onSnapshot(hostCandidates, (s) => {
        s.docChanges().forEach((c) => {
          if (c.type === 'added') {
            void pc.addIceCandidate(new RTCIceCandidate(c.doc.data() as RTCIceCandidateInit));
          }
        });
      }),
    );
  }

  // -------------------------------------------------------------------------

  send(msg: NetMessage) {
    if (this.channel?.readyState === 'open') {
      this.channel.send(encode(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  /** 방장이 규칙을 바꿨을 때 방 목록에도 반영한다 */
  async updateRoomRules(rules: MatchRules) {
    const db = getDb();
    if (!db || !this.roomId) return;
    await updateDoc(doc(db, 'rooms', this.roomId), { rules }).catch(() => {});
  }

  /** 연결이 성립한 뒤 시그널링 문서를 정리해 Firestore 용량을 아낀다 */
  async cleanupSignaling() {
    const db = getDb();
    if (!db || !this.roomId) return;
    try {
      const roomRef = doc(db, 'rooms', this.roomId);
      for (const sub of ['hostCandidates', 'guestCandidates']) {
        const s = await getDocs(collection(roomRef, sub));
        await Promise.all(s.docs.map((d) => deleteDoc(d.ref)));
      }
    } catch {
      // 권한/네트워크 문제로 실패해도 게임 진행에는 영향이 없다
    }
  }

  async close(removeRoom = false) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    try {
      this.channel?.close();
      this.pc?.close();
    } catch {
      /* noop */
    }
    this.channel = null;
    this.pc = null;

    const db = getDb();
    if (db && this.roomId && (removeRoom || this.isHost)) {
      try {
        const roomRef = doc(db, 'rooms', this.roomId);
        for (const sub of ['hostCandidates', 'guestCandidates']) {
          const s = await getDocs(collection(roomRef, sub));
          await Promise.all(s.docs.map((d) => deleteDoc(d.ref)));
        }
        await deleteDoc(roomRef);
      } catch {
        /* noop */
      }
    }
    this.roomId = null;
    this.handlers.onState('closed');
  }
}

// ---------------------------------------------------------------------------
// 방 목록
// ---------------------------------------------------------------------------

/**
 * mode는 쿼리가 아니라 클라이언트에서 거른다.
 * where 절을 하나 더 붙이면 Firestore 복합 색인을 새로 만들어야 하고,
 * mode 필드가 없던 시절의 방(=1:1)이 아예 조회되지 않기 때문이다.
 */
function openRoomFilter(mode: RoomMode) {
  const now = Date.now();
  return (r: RoomInfo) =>
    // 30분 넘게 방치된 방은 숨긴다
    now - (r.createdAt ?? 0) < 30 * 60 * 1000 &&
    (r.mode ?? '1v1') === mode &&
    // 다인 방은 정원이 차면 더 받지 않는다
    (mode === '1v1' || (r.playerCount ?? 1) < (r.maxPlayers ?? (mode === '2v2' ? 4 : 7)));
}

export async function listOpenRooms(mode: RoomMode = '1v1', max = 20): Promise<RoomInfo[]> {
  const db = getDb();
  if (!firebaseConfigured || !db) return [];
  const q = query(
    collection(db, 'rooms'),
    where('status', '==', 'waiting'),
    where('isPrivate', '==', false),
    orderBy('createdAtServer', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as RoomInfo).filter(openRoomFilter(mode));
}

export function watchOpenRooms(
  cb: (rooms: RoomInfo[]) => void,
  mode: RoomMode = '1v1',
  max = 20,
): () => void {
  const db = getDb();
  if (!firebaseConfigured || !db) {
    cb([]);
    return () => {};
  }
  const q = query(
    collection(db, 'rooms'),
    where('status', '==', 'waiting'),
    where('isPrivate', '==', false),
    orderBy('createdAtServer', 'desc'),
    limit(max),
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as RoomInfo).filter(openRoomFilter(mode))),
    () => cb([]),
  );
}
