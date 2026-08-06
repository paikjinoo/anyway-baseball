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
} from 'firebase/firestore';
import { getDb, iceServers, firebaseConfigured } from '../firebase/client';
import { decode, encode, type NetMessage } from './protocol';
import type { ConnState, RoomInfo } from './webrtc';
import type { MatchRules } from '../game/types';

/**
 * 2대2 대전용 P2P 연결 (별 구조).
 *
 *        게스트A
 *          |
 * 게스트C─호스트─게스트B      게스트끼리는 직접 연결하지 않는다.
 *
 * 호스트가 판정과 중계를 모두 맡으므로 1:1과 같은 host-authoritative 모델이
 * 그대로 유지된다. 게스트가 3명이라 offer/answer 쌍도 3개 필요한데,
 * 1:1처럼 방 문서에 offer 하나를 두면 확장이 안 되므로
 * `rooms/{roomId}/peers/{uid}` 문서를 게스트마다 하나씩 만들고
 * **게스트가 offer를, 호스트가 answer를** 쓰는 방향으로 뒤집었다.
 * 덕분에 호스트는 몇 명이 들어올지 미리 알 필요가 없다.
 *
 * Firestore 사용량은 1:1과 같은 수준이다 (방 1 + 게스트당 answer 1 + ICE 몇 개).
 * 경기 트래픽은 전부 DataChannel로만 흐른다.
 */

const CHANNEL_LABEL = 'game';
/** 호스트를 제외한 최대 인원 */
export const MAX_GUESTS = 3;

/** setRemoteDescription 전에 도착한 ICE 후보를 담아 두었다가 나중에 흘려보낸다 */
class CandidateQueue {
  private pending: RTCIceCandidateInit[] = [];
  private ready = false;

  constructor(private pc: RTCPeerConnection) {}

  add(init: RTCIceCandidateInit) {
    if (this.ready) {
      void this.pc.addIceCandidate(new RTCIceCandidate(init)).catch(() => {});
    } else {
      this.pending.push(init);
    }
  }

  flush() {
    this.ready = true;
    const q = this.pending.splice(0);
    for (const c of q) void this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
}

export interface PartyHostHandlers {
  /** 게스트에게서 온 메시지. fromUid로 보낸 사람을 구분한다. */
  onMessage: (msg: NetMessage, fromUid: string) => void;
  /** 게스트 연결 상태 변화 */
  onPeer: (uid: string, state: ConnState) => void;
  onError?: (err: string) => void;
}

interface PeerSlot {
  uid: string;
  offerSdp?: string;
  pc: RTCPeerConnection;
  ch: RTCDataChannel | null;
  unsubs: (() => void)[];
}

// ---------------------------------------------------------------------------
// 호스트
// ---------------------------------------------------------------------------

export class PartyHost {
  private peers = new Map<string, PeerSlot>();
  private unsubs: (() => void)[] = [];
  private handlers: PartyHostHandlers;
  private roomId: string | null = null;

  constructor(handlers: PartyHostHandlers) {
    this.handlers = handlers;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  /** 실제로 데이터채널이 열려 있는 게스트 uid */
  get connectedUids(): string[] {
    return [...this.peers.values()].filter((p) => p.ch?.readyState === 'open').map((p) => p.uid);
  }

  async open(opts: {
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

    const roomRef = doc(collection(db, 'rooms'));
    this.roomId = roomRef.id;

    const info: RoomInfo = {
      id: roomRef.id,
      hostUid: opts.hostUid,
      hostName: opts.hostName,
      teamName: opts.teamName,
      status: 'waiting',
      createdAt: Date.now(),
      isPrivate: opts.isPrivate ?? false,
      mode: '2v2',
      playerCount: 1,
      rules: opts.rules,
    };
    await setDoc(roomRef, { ...info, createdAtServer: serverTimestamp() });

    // 게스트가 만든 peer 문서를 감시한다
    this.unsubs.push(
      onSnapshot(collection(roomRef, 'peers'), (snap) => {
        snap.docChanges().forEach((c) => {
          const data = c.doc.data() as { uid?: string; offer?: RTCSessionDescriptionInit };
          const uid = data.uid ?? c.doc.id;
          if (c.type === 'removed') {
            this.releasePeer(uid, 'closed');
            return;
          }
          if (!data.offer) return;
          const existing = this.peers.get(uid);
          // 새로고침한 게스트가 같은 문서에 새 offer를 쓰면 기존 슬롯을 교체한다.
          if (existing && existing.offerSdp !== data.offer.sdp) this.releasePeer(uid, 'closed');
          if (this.peers.has(uid)) return;
          void this.accept(uid, data.offer).catch((e) =>
            this.handlers.onError?.(String((e as Error)?.message ?? e)),
          );
        });
      }),
    );

    return roomRef.id;
  }

  /** 게스트의 offer를 받아 answer를 돌려준다 */
  private async accept(uid: string, offer: RTCSessionDescriptionInit) {
    const db = getDb();
    if (!db || !this.roomId) return;

    if (this.peers.size >= MAX_GUESTS) {
      // 정원 초과. 아직 데이터채널이 없으니 문서로 거절 사유를 알린다.
      // (그냥 지우면 상대는 "연결 중…"에서 영영 멈춘다)
      await updateDoc(doc(db, 'rooms', this.roomId, 'peers', uid), {
        rejected: '방이 가득 찼습니다 (4명).',
      }).catch(() => {});
      return;
    }

    const peerRef = doc(db, 'rooms', this.roomId, 'peers', uid);
    const pc = new RTCPeerConnection({ iceServers: iceServers(), iceCandidatePoolSize: 4 });
    const slot: PeerSlot = { uid, offerSdp: offer.sdp, pc, ch: null, unsubs: [] };
    this.peers.set(uid, slot);

    const queue = new CandidateQueue(pc);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.handlers.onPeer(uid, 'connected');
      else if (s === 'failed') this.releasePeer(uid, 'failed', slot);
      else if (s === 'disconnected' || s === 'closed') this.releasePeer(uid, 'closed', slot);
    };

    pc.ondatachannel = (e) => {
      if (e.channel.label !== CHANNEL_LABEL) return;
      const ch = e.channel;
      slot.ch = ch;
      ch.onopen = () => this.handlers.onPeer(uid, 'connected');
      ch.onclose = () => this.releasePeer(uid, 'closed', slot);
      ch.onmessage = (ev) => {
        const msg = decode(typeof ev.data === 'string' ? ev.data : '');
        if (msg) this.handlers.onMessage(msg, uid);
      };
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) void addDoc(collection(peerRef, 'hostCandidates'), e.candidate.toJSON());
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      queue.flush();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.peers.get(uid) !== slot) return;
      await updateDoc(peerRef, { answer: { type: answer.type, sdp: answer.sdp } });

      slot.unsubs.push(
        onSnapshot(collection(peerRef, 'guestCandidates'), (snap) => {
          snap.docChanges().forEach((c) => {
            if (c.type === 'added') queue.add(c.doc.data() as RTCIceCandidateInit);
          });
        }),
      );
    } catch (error) {
      this.releasePeer(uid, 'failed', slot);
      throw error;
    }

    void this.syncPlayerCount();
  }

  /** 종료된 연결을 내부 목록에서도 제거해 같은 uid나 새 게스트가 들어올 자리를 만든다. */
  private releasePeer(uid: string, state: 'closed' | 'failed', expected?: PeerSlot) {
    const slot = this.peers.get(uid);
    if (!slot || (expected && slot !== expected)) return;
    this.peers.delete(uid);
    for (const unsub of slot.unsubs) unsub();
    try {
      slot.ch?.close();
      slot.pc.close();
    } catch {
      /* noop */
    }
    this.handlers.onPeer(uid, state);
    void this.syncPlayerCount();
  }

  private async syncPlayerCount() {
    const db = getDb();
    if (!db || !this.roomId) return;
    await updateDoc(doc(db, 'rooms', this.roomId), {
      playerCount: 1 + this.peers.size,
    }).catch(() => {});
  }

  broadcast(msg: NetMessage, exceptUid?: string) {
    const raw = encode(msg);
    for (const p of this.peers.values()) {
      if (p.uid === exceptUid) continue;
      if (p.ch?.readyState === 'open') p.ch.send(raw);
    }
  }

  sendTo(uid: string, msg: NetMessage) {
    const p = this.peers.get(uid);
    if (p?.ch?.readyState === 'open') p.ch.send(encode(msg));
  }

  /** 방장이 규칙을 바꿨을 때 방 목록에도 반영한다 */
  async updateRoomRules(rules: MatchRules) {
    const db = getDb();
    if (!db || !this.roomId) return;
    await updateDoc(doc(db, 'rooms', this.roomId), { rules }).catch(() => {});
  }

  async setStatus(status: RoomInfo['status']) {
    const db = getDb();
    if (!db || !this.roomId) return;
    await updateDoc(doc(db, 'rooms', this.roomId), { status }).catch(() => {});
  }

  /** 연결이 성립한 뒤 ICE 후보 문서를 정리한다 */
  async cleanupSignaling() {
    const db = getDb();
    if (!db || !this.roomId) return;
    try {
      for (const uid of this.peers.keys()) {
        const peerRef = doc(db, 'rooms', this.roomId, 'peers', uid);
        for (const sub of ['hostCandidates', 'guestCandidates']) {
          const s = await getDocs(collection(peerRef, sub));
          await Promise.all(s.docs.map((d) => deleteDoc(d.ref)));
        }
      }
    } catch {
      // 실패해도 경기 진행에는 영향이 없다
    }
  }

  async close() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const p of this.peers.values()) {
      for (const u of p.unsubs) u();
      try {
        p.ch?.close();
        p.pc.close();
      } catch {
        /* noop */
      }
    }
    this.peers.clear();

    const db = getDb();
    if (db && this.roomId) {
      const roomId = this.roomId;
      try {
        const peers = await getDocs(collection(db, 'rooms', roomId, 'peers'));
        for (const p of peers.docs) {
          for (const sub of ['hostCandidates', 'guestCandidates']) {
            const s = await getDocs(collection(p.ref, sub));
            await Promise.all(s.docs.map((d) => deleteDoc(d.ref)));
          }
          await deleteDoc(p.ref);
        }
        await deleteDoc(doc(db, 'rooms', roomId));
      } catch {
        /* noop */
      }
    }
    this.roomId = null;
  }
}

// ---------------------------------------------------------------------------
// 게스트
// ---------------------------------------------------------------------------

export interface PartyGuestHandlers {
  onMessage: (msg: NetMessage) => void;
  onState: (state: ConnState) => void;
  onError?: (err: string) => void;
}

export class PartyGuest {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private unsubs: (() => void)[] = [];
  private handlers: PartyGuestHandlers;
  private roomId: string | null = null;
  private uid: string | null = null;
  private outbox: NetMessage[] = [];

  constructor(handlers: PartyGuestHandlers) {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.channel?.readyState === 'open';
  }

  async join(roomId: string, me: { uid: string; name: string }): Promise<void> {
    const db = getDb();
    if (!firebaseConfigured || !db) {
      throw new Error('온라인 대전에는 Firebase 설정이 필요합니다.');
    }
    this.roomId = roomId;
    this.uid = me.uid;
    this.handlers.onState('connecting');

    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) throw new Error('방을 찾을 수 없습니다.');
    const room = snap.data() as RoomInfo;
    if (room.mode !== '2v2') throw new Error('2대2 방이 아닙니다.');
    if (room.status !== 'waiting') throw new Error('이미 시작되었거나 종료된 방입니다.');

    const peerRef = doc(roomRef, 'peers', me.uid);
    const priorPeer = await getDoc(peerRef);
    if ((room.playerCount ?? 1) >= 4 && !priorPeer.exists()) {
      throw new Error('방이 가득 찼습니다 (4명).');
    }

    const pc = new RTCPeerConnection({ iceServers: iceServers(), iceCandidatePoolSize: 4 });
    this.pc = pc;
    const queue = new CandidateQueue(pc);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.handlers.onState('connected');
      else if (s === 'failed') {
        this.handlers.onState('failed');
        this.handlers.onError?.(
          'P2P 연결에 실패했습니다. 네트워크(NAT) 환경에 따라 TURN 서버가 필요할 수 있습니다.',
        );
      } else if (s === 'disconnected' || s === 'closed') {
        this.handlers.onState('closed');
      }
    };

    // 게스트가 offer를 만들므로 데이터채널도 게스트가 연다
    const ch = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    this.channel = ch;
    ch.onopen = () => {
      this.handlers.onState('connected');
      const pending = this.outbox.splice(0);
      for (const m of pending) ch.send(encode(m));
    };
    ch.onclose = () => this.handlers.onState('closed');
    ch.onmessage = (e) => {
      const msg = decode(typeof e.data === 'string' ? e.data : '');
      if (msg) this.handlers.onMessage(msg);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) void addDoc(collection(peerRef, 'guestCandidates'), e.candidate.toJSON());
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await setDoc(peerRef, {
      uid: me.uid,
      name: me.name,
      joinedAt: Date.now(),
      offer: { type: offer.type, sdp: offer.sdp },
    });

    // 호스트의 answer 대기
    this.unsubs.push(
      onSnapshot(peerRef, (s) => {
        const data = s.data();
        if (data?.rejected) {
          this.handlers.onError?.(String(data.rejected));
          this.handlers.onState('failed');
          return;
        }
        if (!data?.answer || pc.currentRemoteDescription) return;
        void pc
          .setRemoteDescription(new RTCSessionDescription(data.answer))
          .then(() => queue.flush())
          .catch(() => {});
      }),
    );

    this.unsubs.push(
      onSnapshot(collection(peerRef, 'hostCandidates'), (s) => {
        s.docChanges().forEach((c) => {
          if (c.type === 'added') queue.add(c.doc.data() as RTCIceCandidateInit);
        });
      }),
    );
  }

  send(msg: NetMessage) {
    if (this.channel?.readyState === 'open') this.channel.send(encode(msg));
    else this.outbox.push(msg);
  }

  async close() {
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
    if (db && this.roomId && this.uid) {
      try {
        const peerRef = doc(db, 'rooms', this.roomId, 'peers', this.uid);
        for (const sub of ['hostCandidates', 'guestCandidates']) {
          const s = await getDocs(collection(peerRef, sub));
          await Promise.all(s.docs.map((d) => deleteDoc(d.ref)));
        }
        await deleteDoc(peerRef);
      } catch {
        /* noop */
      }
    }
    this.roomId = null;
    this.handlers.onState('closed');
  }
}
