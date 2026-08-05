'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { PeerConnection, type ConnState } from '@/lib/net/webrtc';
import type { NetMessage } from '@/lib/net/protocol';
import { changePitcher, createGame } from '@/lib/game/engine';
import { GameView } from '@/components/GameView';
import { hostResolveWithSwing, hostStartPitch, useMatchStore } from '@/lib/store/matchStore';
import type { Team } from '@/lib/game/types';

export default function HostRoomPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-slate-500">준비 중…</div>}>
      <HostRoomInner />
    </Suspense>
  );
}

function HostRoomInner() {
  const router = useRouter();
  const params = useSearchParams();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);

  const peerRef = useRef<PeerConnection | null>(null);
  const [conn, setConn] = useState<ConnState>('idle');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [guestTeam, setGuestTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [copied, setCopied] = useState(false);

  const initOnlineGame = useMatchStore((s) => s.initOnlineGame);
  const applyRemoteState = useMatchStore((s) => s.applyRemoteState);
  const reset = useMatchStore((s) => s.reset);

  // ---- 방 생성 -------------------------------------------------------------
  useEffect(() => {
    if (!user || !team || peerRef.current) return;

    const peer = new PeerConnection({
      onState: setConn,
      onError: setError,
      onMessage: (msg) => handleMessage(msg),
    });
    peerRef.current = peer;

    void peer
      .host({
        hostUid: user.uid,
        hostName: user.displayName,
        teamName: team.name,
        isPrivate: params.get('private') === '1',
      })
      .then(setRoomId)
      .catch((e) => setError(String(e?.message ?? e)));

    return () => {
      void peer.close(true);
      peerRef.current = null;
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, team?.id]);

  function handleMessage(msg: NetMessage) {
    const peer = peerRef.current;
    if (!peer || !team) return;

    switch (msg.t) {
      case 'HELLO': {
        setGuestTeam(msg.team);
        // 호스트 팀 정보를 회신
        peer.send({ t: 'HELLO', uid: user!.uid, name: user!.displayName, team });
        void peer.cleanupSignaling();
        break;
      }
      case 'PITCH': {
        // 게스트가 수비 중일 때 보낸 투구 명령.
        // 궤적을 만들면서 PITCH_GO를 브로드캐스트한다.
        hostStartPitch(msg.cmd);
        break;
      }
      case 'SWING': {
        hostResolveWithSwing(msg.cmd, msg.steal);
        break;
      }
      case 'SUB_PITCHER': {
        const st = useMatchStore.getState();
        if (!st.state || st.phase !== 'SETUP' || msg.side !== 'away') break;
        const next = changePitcher(structuredClone(st.state), msg.side, msg.pitcherId);
        if (next[msg.side].pitcherId === st.state[msg.side].pitcherId) break;
        applyRemoteState(next);
        break;
      }
      case 'RESYNC_REQ': {
        const st = useMatchStore.getState();
        if (st.state) peer.send({ t: 'RESYNC', state: st.state });
        break;
      }
      case 'LEAVE': {
        setError('상대가 경기를 떠났습니다.');
        break;
      }
      default:
        break;
    }
  }

  function startGame() {
    const peer = peerRef.current;
    if (!peer || !team || !guestTeam) return;
    // 호스트는 홈, 게스트는 원정
    const seed = `online-${roomId}-${Date.now()}`;
    const state = createGame(guestTeam, team, settings, seed);
    peer.send({ t: 'START', state, settings, guestSide: 'away' });
    initOnlineGame({
      state,
      mode: 'ONLINE_HOST',
      playerSide: 'home',
      sendFn: (m) => peer.send(m as NetMessage),
    });
    setStarted(true);
  }

  if (!team || !user) {
    return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;
  }

  if (started) {
    return (
      <GameView
        onExit={() => {
          peerRef.current?.send({ t: 'LEAVE', reason: '호스트가 나갔습니다.' });
          void peerRef.current?.close(true);
          reset();
          router.push('/play/online');
        }}
      />
    );
  }

  const link = roomId ?? '';

  return (
    <div className="mx-auto max-w-lg space-y-5 py-6">
      <h1 className="text-2xl font-black">방 만들기</h1>

      <section className="panel p-5">
        <div className="mb-3 flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              conn === 'connected'
                ? 'bg-emerald-400'
                : conn === 'failed'
                  ? 'bg-rose-400'
                  : 'bg-amber-400 flash'
            }`}
          />
          <span className="text-sm font-semibold">
            {conn === 'creating' && '방을 만드는 중…'}
            {conn === 'waiting' && '상대를 기다리는 중…'}
            {conn === 'connecting' && '연결 중…'}
            {conn === 'connected' && '연결됨'}
            {conn === 'failed' && '연결 실패'}
            {conn === 'closed' && '연결 종료'}
            {conn === 'idle' && '준비 중…'}
          </span>
        </div>

        {roomId && (
          <>
            <label className="field-label">방 코드 (상대에게 전달)</label>
            <div className="flex gap-2">
              <input type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <button
                className="btn shrink-0"
                onClick={() => {
                  void navigator.clipboard.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? '복사됨' : '복사'}
              </button>
            </div>
          </>
        )}

        {error && (
          <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
        )}
      </section>

      {guestTeam && (
        <section className="panel p-5">
          <h2 className="mb-3 font-bold">매치업</h2>
          <div className="flex items-center justify-around text-center">
            <div>
              <div className="text-[11px] text-slate-500">원정 (상대)</div>
              <div className="font-bold">{guestTeam.name}</div>
            </div>
            <span className="font-black text-slate-600">VS</span>
            <div>
              <div className="text-[11px] text-slate-500">홈 (나)</div>
              <div className="font-bold">{team.name}</div>
            </div>
          </div>
        </section>
      )}

      <button
        className="btn btn-primary w-full !py-3"
        disabled={conn !== 'connected' || !guestTeam}
        onClick={startGame}
      >
        {conn === 'connected' && guestTeam ? '경기 시작' : '상대 대기 중…'}
      </button>

      <button
        className="btn w-full"
        onClick={() => {
          void peerRef.current?.close(true);
          router.push('/play/online');
        }}
      >
        방 닫기
      </button>
    </div>
  );
}
