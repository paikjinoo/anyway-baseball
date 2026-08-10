'use client';

import { useEffect, useRef, useState } from 'react';
import { BatPanel } from '@/components/hud/BatPanel';
import { PitchClock } from '@/components/hud/PitchClock';
import { PitchPanel } from '@/components/hud/PitchPanel';
import { RewardNote } from '@/components/hud/RewardNote';
import { useMatchReward } from '@/lib/store/matchReward';
import { GameScene, zoneFlippedOnScreen, type CameraMode } from '@/components/three/GameScene';
import { PITCH_DEFS } from '@/lib/game/constants';
import { currentBatter, currentPitcher } from '@/lib/game/engine';
import {
  currentRelayBatter,
  currentRelayPitcher,
  relayStandings,
} from '@/lib/game/relay';
import {
  controlsBatter,
  controlsPitcher,
  useMatchStore,
} from '@/lib/store/matchStore';

export function RelayGameView({ onExit }: { onExit: () => void }) {
  const state = useMatchStore((s) => s.state);
  const relay = useMatchStore((s) => s.relayState);
  const phase = useMatchStore((s) => s.phase);
  const mode = useMatchStore((s) => s.mode);
  const lastResult = useMatchStore((s) => s.lastResult);
  const prePitchState = useMatchStore((s) => s.prePitchState);
  const revealed = useMatchStore((s) => s.revealed);
  const resultMs = useMatchStore((s) => s.resultMs);
  const resultStartAt = useMatchStore((s) => s.resultStartAt);
  const waiting = useMatchStore((s) => s.waitingRemote);
  const canBat = useMatchStore(controlsBatter);
  const canPitch = useMatchStore(controlsPitcher);
  const advance = useMatchStore((s) => s.advance);
  const log = useMatchStore((s) => s.log);
  const reward = useMatchReward();
  const [cameraMode, setCameraMode] = useState<CameraMode>('DRAMATIC');
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase !== 'RESULT' || !lastResult || mode !== 'RELAY_HOST') return;
    const ms = Math.max(700, resultMs - (performance.now() - resultStartAt));
    const id = setTimeout(() => advance(), ms);
    return () => clearTimeout(id);
  }, [advance, lastResult, mode, phase, resultMs, resultStartAt]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log.length]);

  if (!state || !relay) {
    return <div className="grid min-h-dvh place-items-center text-slate-500">경기를 준비하는 중…</div>;
  }

  const hudState = phase === 'RESULT' && !revealed ? (prePitchState ?? state) : state;
  const batter = currentBatter(hudState);
  const pitcher = currentPitcher(hudState);
  const batterPlayer = currentRelayBatter(relay);
  const pitcherPlayer = currentRelayPitcher(relay);
  const standingState =
    phase === 'RESULT' && !revealed && lastResult?.atBatEnded && relay.roundEvents.length
      ? { ...relay, roundEvents: relay.roundEvents.slice(0, -1) }
      : relay;
  const standings = relayStandings(standingState);
  const over = relay.phase === 'GAME_OVER' || phase === 'GAME_OVER';

  return (
    <div className="game-shell relative h-dvh w-full overflow-hidden bg-black">
      <div className="absolute inset-0">
        <GameScene cameraMode={cameraMode} />
      </div>

      <div className="game-topbar pointer-events-none absolute inset-x-0 top-0 z-20 p-3">
        <div className="pointer-events-auto mx-auto flex w-full max-w-6xl flex-wrap items-start gap-2">
          <RelayScoreboard
            round={relay.roundIndex + 1}
            totalRounds={relay.rules.roundCount}
            pitcher={pitcherPlayer?.name ?? '-'}
            batter={batterPlayer?.name ?? '-'}
            batterNumber={relay.batterIndex + 1}
            batterTotal={relay.batterOrder.length}
            balls={hudState.balls}
            strikes={hudState.strikes}
          />
          <PitchClock />
          <div className="flex-1" />
          <button
            className="btn !px-2.5 !py-1.5 !text-xs"
            onClick={() =>
              setCameraMode((m) => (m === 'DRAMATIC' ? 'FIELD' : m === 'FIELD' ? 'BATTER' : 'DRAMATIC'))
            }
          >
            카메라: {cameraMode === 'DRAMATIC' ? '자동' : cameraMode === 'FIELD' ? '전체' : '타자'}
          </button>
          <button className="btn !px-2.5 !py-1.5 !text-xs" onClick={() => setShowLog((v) => !v)}>
            실황
          </button>
          <button className="btn btn-danger !px-2.5 !py-1.5 !text-xs" onClick={onExit}>
            나가기
          </button>
        </div>
      </div>

      <div className="panel absolute right-3 top-20 z-20 w-56 p-3">
        <div className="mb-2 flex items-center justify-between">
          <b className="text-xs">실시간 순위</b>
          <span className="text-[10px] text-slate-500">홈런 우선</span>
        </div>
        <div className="space-y-1">
          {standings.map((row) => (
            <div key={row.uid} className="flex items-center gap-2 rounded-md bg-white/5 px-2 py-1.5 text-xs">
              <span className="w-5 text-center font-black text-lime-300">{row.rank}</span>
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="font-black tabular-nums text-amber-300">{row.score}</span>
              <span className="text-[9px] text-slate-500">HR {row.homeRuns}</span>
            </div>
          ))}
        </div>
      </div>

      {showLog && (
        <div
          ref={logRef}
          className="game-log panel absolute bottom-3 left-3 z-20 max-h-44 w-72 overflow-y-auto p-3 text-xs leading-relaxed"
        >
          {log.map((entry) => (
            <p
              key={entry.id}
              className={
                entry.kind === 'inning'
                  ? 'mt-1.5 font-bold text-lime-300'
                  : entry.kind === 'info'
                    ? 'text-slate-400'
                    : 'text-slate-300'
              }
            >
              {entry.text}
            </p>
          ))}
        </div>
      )}

      {!over && phase !== 'RESULT' && !canBat && !canPitch && (
        <div className="pointer-events-none absolute inset-x-0 top-24 z-20 flex justify-center">
          <div className="panel px-4 py-2 text-center text-xs text-slate-300">
            <b>관전 중</b>
            <span className="mx-1.5 text-slate-600">·</span>
            {pitcherPlayer?.name} 투수 vs {batterPlayer?.name} 타자
          </div>
        </div>
      )}

      {!over && (
        <div className="game-control-panel absolute bottom-3 right-3 z-20 w-[300px] max-w-[calc(100vw-24px)]">
          {canBat ? (
            <BatPanel state={hudState} batter={batter} />
          ) : canPitch && phase === 'SETUP' ? (
            <PitchPanel
              state={state}
              pitcher={pitcher}
              playerSide="home"
              mirrored={zoneFlippedOnScreen(cameraMode, false)}
            />
          ) : (
            <div className="panel p-4 text-center text-sm text-slate-400">
              {waiting ? '호스트 응답 대기 중…' : phase === 'RESULT' ? '결과 확인 중…' : '다른 플레이어 차례입니다.'}
            </div>
          )}
        </div>
      )}

      {phase === 'RESULT' && lastResult && (
        <div className="result-banner pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2">
          <div className="panel pop-in px-5 py-2.5 text-center">
            <div className="text-xs text-slate-400">
              {lastResult.trajectory
                ? `${PITCH_DEFS[lastResult.trajectory.type].ko} ${Math.round(lastResult.trajectory.velocity)}km/h`
                : '피치 클락 위반'}
            </div>
            {revealed ? (
              <div className="pop-in">
                <div className="text-base font-bold">{lastResult.description}</div>
                {lastResult.battedBall && (
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    타구속도 {Math.round(lastResult.battedBall.exitVelocity)}km/h · 발사각{' '}
                    {Math.round(lastResult.battedBall.launchAngle)}° · 비거리{' '}
                    {Math.round(lastResult.battedBall.distance)}m
                  </div>
                )}
              </div>
            ) : lastResult.contact ? (
              <div className="text-base font-bold text-amber-300 flash">타구!</div>
            ) : (
              <div className="text-base font-bold text-slate-500">…</div>
            )}
          </div>
        </div>
      )}

      {over && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/75 backdrop-blur-sm">
          <div className="panel pop-in w-[min(92vw,520px)] p-7">
            <h2 className="text-center text-3xl font-black">릴레이 대결 종료</h2>
            <div className="mt-6 space-y-2">
              {standings.map((row) => (
                <div key={row.uid} className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3">
                  <span className="w-8 text-center text-xl font-black text-lime-300">{row.rank}</span>
                  <span className="min-w-0 flex-1 truncate font-bold">{row.name}</span>
                  <span className="text-lg font-black text-amber-300">{row.score}점</span>
                  <span className="text-xs text-slate-500">홈런 {row.homeRuns}</span>
                </div>
              ))}
            </div>
            {reward && (
              <div className="mt-5">
                <RewardNote reward={reward} />
              </div>
            )}
            <button className="btn btn-primary mt-6 w-full" onClick={onExit}>
              나가기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RelayScoreboard({
  round,
  totalRounds,
  pitcher,
  batter,
  batterNumber,
  batterTotal,
  balls,
  strikes,
}: {
  round: number;
  totalRounds: number;
  pitcher: string;
  batter: string;
  batterNumber: number;
  batterTotal: number;
  balls: number;
  strikes: number;
}) {
  return (
    <div className="panel flex min-w-80 items-center gap-3 px-4 py-2 text-xs">
      <div>
        <div className="font-black text-lime-300">{round}/{totalRounds} 라운드</div>
        <div className="text-[10px] text-slate-500">타자 {batterNumber}/{batterTotal}</div>
      </div>
      <div className="h-8 w-px bg-white/10" />
      <div className="min-w-0 flex-1">
        <div className="truncate"><span className="text-slate-500">투수</span> <b>{pitcher}</b></div>
        <div className="truncate"><span className="text-slate-500">타자</span> <b>{batter}</b></div>
      </div>
      <div className="flex gap-2 font-black tabular-nums">
        <span className="text-emerald-300">B {balls}</span>
        <span className="text-amber-300">S {strikes}</span>
      </div>
    </div>
  );
}
