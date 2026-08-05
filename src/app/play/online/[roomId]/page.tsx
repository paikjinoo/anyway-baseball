'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { PeerConnection, type ConnState } from '@/lib/net/webrtc';
import type { NetMessage } from '@/lib/net/protocol';
import { GameView } from '@/components/GameView';
import { useMatchStore } from '@/lib/store/matchStore';
import { changePitcher } from '@/lib/game/engine';
import type { Team } from '@/lib/game/types';

export default function GuestRoomPage() {
  const router = useRouter();
  const { roomId } = useParams<{ roomId: string }>();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();

  const peerRef = useRef<PeerConnection | null>(null);
  const [conn, setConn] = useState<ConnState>('idle');
  const [hostTeam, setHostTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const initOnlineGame = useMatchStore((s) => s.initOnlineGame);
  const applyRemoteResult = useMatchStore((s) => s.applyRemoteResult);
  const applyRemoteState = useMatchStore((s) => s.applyRemoteState);
  const startRemotePitch = useMatchStore((s) => s.startRemotePitch);
  const reset = useMatchStore((s) => s.reset);

  useEffect(() => {
    if (!user || !team || !roomId || peerRef.current) return;

    const peer = new PeerConnection({
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

    void peer.join(roomId).catch((e) => setError(String(e?.message ?? e)));

    return () => {
      void peer.close(false);
      peerRef.current = null;
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, team?.id, roomId]);

  function handleMessage(msg: NetMessage, peer: PeerConnection) {
    switch (msg.t) {
      case 'HELLO':
        setHostTeam(msg.team);
        break;
      case 'START':
        initOnlineGame({
          state: msg.state,
          mode: 'ONLINE_GUEST',
          playerSide: msg.guestSide,
          sendFn: (m) => peer.send(m as NetMessage),
        });
        setStarted(true);
        break;
      case 'PITCH_GO':
        startRemotePitch(msg.cmd);
        break;
      case 'RESULT':
        applyRemoteResult(msg.result);
        break;
      case 'RESYNC':
        applyRemoteState(msg.state);
        break;
      case 'SUB_PITCHER': {
        const st = useMatchStore.getState();
        if (!st.state) break;
        const next = changePitcher(structuredClone(st.state), msg.side, msg.pitcherId);
        if (next[msg.side].pitcherId !== st.state[msg.side].pitcherId) applyRemoteState(next);
        break;
      }
      case 'LEAVE':
        setError('상대가 경기를 떠났습니다.');
        break;
      default:
        break;
    }
  }

  if (!team || !user) {
    return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;
  }

  if (started) {
    return (
      <GameView
        onExit={() => {
          peerRef.current?.send({ t: 'LEAVE', reason: '상대가 나갔습니다.' });
          void peerRef.current?.close(false);
          reset();
          router.push('/play/online');
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-5 py-6">
      <h1 className="text-2xl font-black">방 입장</h1>

      <section className="panel p-5">
        <div className="mb-3 flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              conn === 'connected' ? 'bg-emerald-400' : conn === 'failed' ? 'bg-rose-400' : 'bg-amber-400 flash'
            }`}
          />
          <span className="text-sm font-semibold">
            {conn === 'connecting' && '연결 중…'}
            {conn === 'connected' && '연결됨 — 방장이 경기를 시작하기를 기다리는 중'}
            {conn === 'failed' && '연결 실패'}
            {conn === 'closed' && '연결 종료'}
            {conn === 'idle' && '준비 중…'}
          </span>
        </div>
        <p className="text-xs text-slate-500">방 코드: {roomId}</p>
        {error && (
          <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
        )}
      </section>

      {hostTeam && (
        <section className="panel p-5">
          <h2 className="mb-3 font-bold">매치업</h2>
          <div className="flex items-center justify-around text-center">
            <div>
              <div className="text-[11px] text-slate-500">원정 (나)</div>
              <div className="font-bold">{team.name}</div>
            </div>
            <span className="font-black text-slate-600">VS</span>
            <div>
              <div className="text-[11px] text-slate-500">홈 (방장)</div>
              <div className="font-bold">{hostTeam.name}</div>
            </div>
          </div>
        </section>
      )}

      <button
        className="btn w-full"
        onClick={() => {
          void peerRef.current?.close(false);
          router.push('/play/online');
        }}
      >
        나가기
      </button>
    </div>
  );
}
