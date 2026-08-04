'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { GameScene, type CameraMode } from './three/GameScene';
import { CountDisplay, Scoreboard } from './hud/Scoreboard';
import { PitchClock } from './hud/PitchClock';
import { PitchPanel } from './hud/PitchPanel';
import { BatPanel } from './hud/BatPanel';
import {
  controlsBatter,
  controlsPitcher,
  currentControllerUid,
  isPartyMode,
  isPlayerBatting,
  isSameSide,
  useMatchStore,
} from '@/lib/store/matchStore';
import { bullpenCandidates, currentBatter, currentPitcher } from '@/lib/game/engine';
import { PITCH_DEFS } from '@/lib/game/constants';
import type { GameState, Side } from '@/lib/game/types';

export function GameView({
  onExit,
  exitHref = '/play',
}: {
  onExit?: () => void;
  exitHref?: string;
}) {
  const state = useMatchStore((s) => s.state);
  const phase = useMatchStore((s) => s.phase);
  const lastResult = useMatchStore((s) => s.lastResult);
  const log = useMatchStore((s) => s.log);
  const advance = useMatchStore((s) => s.advance);
  const playerSide = useMatchStore((s) => s.playerSide);
  const batting = useMatchStore((s) => isPlayerBatting(s));
  const waiting = useMatchStore((s) => s.waitingRemote);
  // 2대2에서는 "우리 팀 차례"가 아니라 "내 선수 차례"여야 조작할 수 있다
  const canBat = useMatchStore(controlsBatter);
  const canPitch = useMatchStore(controlsPitcher);
  const party = useMatchStore((s) => isPartyMode(s.mode));
  const controllerUid = useMatchStore(currentControllerUid);
  const controllerName = useMatchStore((s) =>
    controllerUid ? (s.seatNames[controllerUid] ?? '상대') : '',
  );
  const controllerIsTeammate = useMatchStore(
    (s) => !!controllerUid && controllerUid !== s.myUid && isSameSide(s, controllerUid),
  );
  const spectating = party && !canBat && !canPitch;
  const [cameraMode, setCameraMode] = useState<CameraMode>('DRAMATIC');
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 결과 연출 후 자동 진행.
  // 연출 길이는 주루 타임라인에서 계산된다 (주자가 다 뛴 뒤에 다음 타석으로 넘어간다).
  useEffect(() => {
    if (phase !== 'RESULT' || !lastResult) return;
    const st = useMatchStore.getState();
    const ms = Math.max(700, st.resultMs - (performance.now() - st.resultStartAt));
    timerRef.current = setTimeout(() => advance(), ms);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, lastResult, advance]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log.length]);

  if (!state) {
    return (
      <div className="grid min-h-dvh place-items-center text-slate-500">경기를 준비하는 중…</div>
    );
  }

  const batter = currentBatter(state);
  const pitcher = currentPitcher(state);
  const over = state.phase === 'GAME_OVER';

  return (
    <div className="game-shell relative h-dvh w-full overflow-hidden bg-black">
      {/* 3D 뷰 */}
      <div className="absolute inset-0">
        <GameScene cameraMode={cameraMode} />
      </div>

      {/* 상단 HUD */}
      <div className="game-topbar pointer-events-none absolute inset-x-0 top-0 z-20 p-3">
        <div className="pointer-events-auto mx-auto flex w-full max-w-5xl flex-wrap items-start gap-2">
          <div className="w-full max-w-xs">
            <Scoreboard state={state} />
          </div>
          <CountDisplay state={state} />
          <PitchClock />
          <div className="flex-1" />
          <div className="flex gap-1.5">
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
            {onExit ? (
              <button className="btn btn-danger !px-2.5 !py-1.5 !text-xs" onClick={onExit}>
                나가기
              </button>
            ) : (
              <Link href={exitHref} className="btn btn-danger !px-2.5 !py-1.5 !text-xs">
                나가기
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* 실황 로그 */}
      {showLog && (
        <div
          ref={logRef}
          className="game-log panel absolute bottom-3 left-3 z-20 max-h-44 w-72 overflow-y-auto p-3 text-xs leading-relaxed"
        >
          {log.map((l) => (
            <p
              key={l.id}
              className={
                l.kind === 'score'
                  ? 'font-bold text-amber-300'
                  : l.kind === 'inning'
                    ? 'mt-1.5 font-bold text-lime-300'
                    : l.kind === 'info'
                      ? 'text-slate-400'
                      : 'text-slate-300'
              }
            >
              {l.text}
            </p>
          ))}
        </div>
      )}

      {/* 관전 안내 (2대2) */}
      {!over && spectating && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-20 flex justify-center">
          <div
            className={`panel px-4 py-2 text-center text-xs ${
              controllerIsTeammate ? 'text-lime-200' : 'text-slate-300'
            }`}
          >
            <span className="font-bold">관전 중</span>
            <span className="mx-1.5 text-slate-600">·</span>
            {controllerIsTeammate ? '팀원 ' : '상대 '}
            <b>{controllerName}</b>
            {batting ? '의 타석입니다' : ' 투구 중'}
          </div>
        </div>
      )}

      {/* 조작 패널 */}
      {!over && (
        <div className="game-control-panel absolute bottom-3 right-3 z-20 w-[300px] max-w-[calc(100vw-24px)]">
          {canBat ? (
            <BatPanel state={state} batter={batter} />
          ) : canPitch && phase === 'SETUP' ? (
            <PitchPanel state={state} pitcher={pitcher} playerSide={playerSide as Side} />
          ) : (
            <div className="panel p-4 text-center text-sm text-slate-400">
              {spectating ? (
                <SpectatorNote
                  batting={batting}
                  batterName={batter.name}
                  pitcherName={pitcher.name}
                  isTeammate={controllerIsTeammate}
                  bullpen={
                    !batting && phase === 'SETUP' ? (
                      <BullpenTakeover state={state} playerSide={playerSide as Side} />
                    ) : null
                  }
                />
              ) : waiting ? (
                '상대 입력 대기 중…'
              ) : (
                '진행 중…'
              )}
            </div>
          )}
        </div>
      )}

      {/* 투구 정보 배너 */}
      {phase !== 'SETUP' && lastResult && (
        <div className="result-banner pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2">
          <div className="panel pop-in px-5 py-2.5 text-center">
            <div className="text-xs text-slate-400">
              {lastResult.trajectory ? (
                <>
                  {PITCH_DEFS[lastResult.trajectory.type].ko}{' '}
                  {Math.round(lastResult.trajectory.velocity)}km/h
                </>
              ) : (
                // 던지지 않은 공 (피치 클락 위반)
                <span className="font-bold text-rose-300">피치 클락 위반</span>
              )}
            </div>
            <div className="text-base font-bold">{lastResult.description}</div>
            {lastResult.battedBall && lastResult.contact && (
              <div className="mt-0.5 text-[11px] text-slate-400">
                타구속도 {Math.round(lastResult.battedBall.exitVelocity)}km/h · 발사각{' '}
                {Math.round(lastResult.battedBall.launchAngle)}° · 비거리{' '}
                {Math.round(lastResult.battedBall.distance)}m
              </div>
            )}
          </div>
        </div>
      )}

      {/* 경기 종료 */}
      {over && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 backdrop-blur-sm">
          <div className="panel pop-in w-[min(92vw,440px)] p-7 text-center">
            <h2 className="text-3xl font-black">경기 종료</h2>
            {state.endedByMercy && (
              <p className="mt-1 text-sm text-amber-300">콜드게임</p>
            )}
            <div className="my-6 flex items-center justify-center gap-6">
              <TeamScore
                abbr={state.away.abbr}
                name={state.away.name}
                runs={state.away.runs}
                color={state.away.primaryColor}
                win={state.winner === 'away'}
              />
              <span className="text-2xl text-slate-600">:</span>
              <TeamScore
                abbr={state.home.abbr}
                name={state.home.name}
                runs={state.home.runs}
                color={state.home.primaryColor}
                win={state.winner === 'home'}
              />
            </div>
            <p className="mb-6 text-sm text-slate-400">
              {state.winner === 'TIE'
                ? '무승부입니다.'
                : `${state[state.winner as Side].name} 승리!`}
            </p>
            <div className="flex gap-2">
              {onExit ? (
                <button className="btn btn-primary flex-1" onClick={onExit}>
                  나가기
                </button>
              ) : (
                <Link href={exitHref} className="btn btn-primary flex-1">
                  나가기
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 2대2에서 내 선수 차례가 아닐 때 보여주는 안내 */
function SpectatorNote({
  batting,
  batterName,
  pitcherName,
  isTeammate,
  bullpen,
}: {
  batting: boolean;
  batterName: string;
  pitcherName: string;
  isTeammate: boolean;
  bullpen?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 text-left">
      <div className="text-center text-xs font-bold text-slate-300">
        {isTeammate ? '팀원이 조작 중입니다' : '상대 차례입니다'}
      </div>
      <div className="rounded-lg bg-white/5 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
        {batting ? (
          <>
            타석: <b className="text-slate-200">{batterName}</b>
            <br />내 선수의 타순이 오면 조작 패널이 나타납니다.
          </>
        ) : (
          <>
            마운드: <b className="text-slate-200">{pitcherName}</b>
            <br />내 투수를 마운드에 올리면 투구를 맡을 수 있습니다.
          </>
        )}
      </div>
      {bullpen}
    </div>
  );
}

/**
 * 팀원이 던지는 동안 내 불펜 투수를 올려 조작권을 가져오는 버튼.
 * 2대2에서 수비를 한 사람이 독점하지 않도록 하는 유일한 통로다.
 */
function BullpenTakeover({ state, playerSide }: { state: GameState; playerSide: Side }) {
  const owners = useMatchStore((s) => s.owners);
  const myUid = useMatchStore((s) => s.myUid);
  const substitutePitcher = useMatchStore((s) => s.substitutePitcher);
  const [open, setOpen] = useState(false);

  const mine = bullpenCandidates(state, playerSide).filter((p) => owners[p.id] === myUid);
  if (!mine.length) return null;

  return (
    <div className="space-y-1">
      <button className="btn w-full !py-1.5 !text-xs" onClick={() => setOpen((v) => !v)}>
        내 투수 투입 {open ? '닫기' : `(${mine.length}명)`}
      </button>
      {open &&
        mine.map((p) => (
          <button
            key={p.id}
            className="flex w-full items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
            onClick={() => {
              substitutePitcher(p.id);
              setOpen(false);
            }}
          >
            <span className="font-semibold">{p.name}</span>
            <span className="text-slate-500">스태미나 {p.pitching?.stamina ?? 0}</span>
          </button>
        ))}
    </div>
  );
}

function TeamScore({
  abbr,
  name,
  runs,
  color,
  win,
}: {
  abbr: string;
  name: string;
  runs: number;
  color: string;
  win: boolean;
}) {
  return (
    <div className={win ? '' : 'opacity-60'}>
      <div
        className="mx-auto mb-1.5 h-2 w-12 rounded-full"
        style={{ background: color }}
      />
      <div className="text-4xl font-black tabular">{runs}</div>
      <div className="text-xs text-slate-400">{abbr}</div>
      <div className="max-w-24 truncate text-[10px] text-slate-600">{name}</div>
      {win && <div className="mt-1 text-[10px] font-bold text-amber-300">WIN</div>}
    </div>
  );
}
