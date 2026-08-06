'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { PeerConnection, type ConnState } from '@/lib/net/webrtc';
import type { NetMessage } from '@/lib/net/protocol';
import { changePitcher, createGame } from '@/lib/game/engine';
import { GameView } from '@/components/GameView';
import { RuleSettings } from '@/components/settings/RuleSettings';
import { hostResolveWithSwing, hostStartPitch, useMatchStore } from '@/lib/store/matchStore';
import { pickRules, type MatchRules, type Team } from '@/lib/game/types';

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
  /**
   * 이 방의 경기 규칙. 내 설정값에서 출발하되 여기서 바꾼 값이 경기에 들어간다.
   * (설정 화면의 값을 건드리지는 않는다 — 방마다 다르게 열 수 있어야 한다)
   */
  const [rules, setRules] = useState<MatchRules>(() => pickRules(settings));
  // 방을 만드는 effect는 한 번만 도는데, 그 안에서 최신 규칙을 읽어야 한다
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

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
        rules: rulesRef.current,
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

  // 규칙이 바뀌면 들어와 있는 상대와 방 목록 양쪽에 알린다.
  // 방 문서 쓰기는 슬라이더를 놓은 뒤에만 일어나도록 조금 늦춘다.
  useEffect(() => {
    if (started) return;
    peerRef.current?.send({ t: 'ROOM_RULES', rules });
    const id = setTimeout(() => void peerRef.current?.updateRoomRules(rules), 600);
    return () => clearTimeout(id);
  }, [rules, started]);

  function handleMessage(msg: NetMessage) {
    const peer = peerRef.current;
    if (!peer || !team) return;

    switch (msg.t) {
      case 'HELLO': {
        setGuestTeam(msg.team);
        // 호스트 팀 정보와 이 방의 규칙을 회신
        peer.send({ t: 'HELLO', uid: user!.uid, name: user!.displayName, team });
        peer.send({ t: 'ROOM_RULES', rules: rulesRef.current });
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
    // 사운드·카메라는 각자 자기 설정을 쓰고, 승부 조건만 방 규칙으로 덮는다
    const gameSettings = { ...settings, ...rules };
    const state = createGame(guestTeam, team, gameSettings, seed);
    peer.send({ t: 'START', state, settings: gameSettings, guestSide: 'away' });
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

      <section className="panel p-5">
        <h2 className="mb-1 font-bold">이 경기의 규칙</h2>
        <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
          방장이 정한 규칙이 이 경기에만 적용됩니다. 상대 화면에도 그대로 반영되며, 내 기본 설정은
          바뀌지 않습니다.
        </p>
        <RuleSettings value={rules} onChange={(p) => setRules((r) => ({ ...r, ...p }))} compact />
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
