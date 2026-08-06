'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { PartyGuest } from '@/lib/net/party';
import type { ConnState } from '@/lib/net/webrtc';
import type { NetMessage, PartyPicks, PartySeat } from '@/lib/net/protocol';
import { suggestPicks } from '@/lib/game/allstar';
import { changePitcher } from '@/lib/game/engine';
import { GameView } from '@/components/GameView';
import { PartyRoomView } from '@/components/party/PartyRoomView';
import { useMatchStore } from '@/lib/store/matchStore';
import type { MatchRules } from '@/lib/game/types';

export default function PartyGuestPage() {
  const router = useRouter();
  const { roomId } = useParams<{ roomId: string }>();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();

  const peerRef = useRef<PartyGuest | null>(null);
  const [conn, setConn] = useState<ConnState>('idle');
  const [seats, setSeats] = useState<PartySeat[]>([]);
  const [hostUid, setHostUid] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [myPicks, setMyPicks] = useState<PartyPicks>({ batters: [], pitchers: [] });
  const [myReady, setMyReady] = useState(false);
  const [rules, setRules] = useState<MatchRules | null>(null);

  const uid = user?.uid ?? '';

  useEffect(() => {
    if (!user || !team || !roomId || peerRef.current) return;

    setMyPicks(suggestPicks(team, 0));

    const peer = new PartyGuest({
      onState: (s) => {
        setConn(s);
        if (s === 'connected') {
          peer.send({ t: 'HELLO', uid: user.uid, name: user.displayName, team });
        }
      },
      onError: setError,
      onMessage: (msg) => handleMessage(msg, peer),
    });
    peerRef.current = peer;

    void peer
      .join(roomId, { uid: user.uid, name: user.displayName })
      .catch((e) => setError(String((e as Error)?.message ?? e)));

    return () => {
      void peer.close();
      peerRef.current = null;
      useMatchStore.getState().reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, team?.id, roomId]);

  function handleMessage(msg: NetMessage, peer: PartyGuest) {
    const store = useMatchStore.getState();
    switch (msg.t) {
      case 'PARTY_SEATS':
        setSeats(msg.seats);
        setHostUid(msg.hostUid);
        break;

      case 'ROOM_RULES':
        setRules(msg.rules);
        break;

      case 'PARTY_START': {
        const mySide = msg.seats.find((s) => s.uid === uid)?.side ?? 'away';
        store.initPartyGame({
          state: msg.state,
          mode: 'PARTY_GUEST',
          playerSide: mySide,
          myUid: uid,
          owners: msg.owners,
          seatNames: Object.fromEntries(msg.seats.map((s) => [s.uid, s.name])),
          sendFn: (m) => peer.send(m as NetMessage),
        });
        setStarted(true);
        break;
      }

      case 'PARTY_OWNERS':
        store.setOwners(msg.owners);
        if (msg.notice) store.pushLog(msg.notice, 'info');
        break;

      case 'PITCH_GO':
        store.startRemotePitch(msg.cmd);
        break;
      case 'RESULT':
        store.applyRemoteResult(msg.result);
        break;
      case 'RESYNC':
        store.applyRemoteState(msg.state);
        break;
      case 'SUB_PITCHER': {
        if (!store.state) break;
        const beforePitcherId = store.state[msg.side].pitcherId;
        const next = changePitcher(structuredClone(store.state), msg.side, msg.pitcherId);
        if (next[msg.side].pitcherId !== beforePitcherId) {
          store.applyRemoteState(next);
          store.pushLog(
            `${next[msg.side].name} 투수 교체: ${next[msg.side].roster[msg.pitcherId].name}`,
            'info',
          );
        }
        break;
      }
      case 'LEAVE':
        setError(msg.reason || '상대가 경기를 떠났습니다.');
        break;
      default:
        break;
    }
  }

  const mySeat = seats.find((s) => s.uid === uid);

  // 방장이 자리를 옮기면 맡는 타순 수가 달라지므로 추천 픽을 다시 잡는다
  useEffect(() => {
    if (!team || !mySeat) return;
    setMyPicks(suggestPicks(team, mySeat.slot));
    setMyReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mySeat?.slot, team?.id]);

  function sendPicks(picks: PartyPicks, ready: boolean) {
    peerRef.current?.send({ t: 'PARTY_PICK', uid, picks, ready });
  }

  if (!team || !user) {
    return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;
  }

  if (started) {
    return (
      <GameView
        onExit={() => {
          peerRef.current?.send({ t: 'LEAVE', reason: '한 명이 나갔습니다.' });
          void peerRef.current?.close();
          useMatchStore.getState().reset();
          router.push('/play/party');
        }}
      />
    );
  }

  return (
    <PartyRoomView
      roomId={roomId}
      conn={conn}
      seats={seats}
      myUid={uid}
      hostUid={hostUid}
      myTeam={team}
      picks={myPicks}
      onPicksChange={(p) => {
        setMyPicks(p);
        setMyReady(false);
        sendPicks(p, false);
      }}
      ready={myReady}
      onReadyChange={(v) => {
        setMyReady(v);
        sendPicks(myPicks, v);
      }}
      error={error}
      rules={rules}
      isHost={false}
      onLeave={() => {
        peerRef.current?.send({ t: 'LEAVE', reason: '한 명이 나갔습니다.' });
        void peerRef.current?.close();
        router.push('/play/party');
      }}
    />
  );
}
