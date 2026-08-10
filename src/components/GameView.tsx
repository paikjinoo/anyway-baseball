'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { GameScene, zoneFlippedOnScreen, type CameraMode } from './three/GameScene';
import { CountDisplay, Scoreboard } from './hud/Scoreboard';
import { PitchClock } from './hud/PitchClock';
import { PitchPanel } from './hud/PitchPanel';
import { BatPanel } from './hud/BatPanel';
import { SubPanel } from './hud/SubPanel';
import { RewardNote } from './hud/RewardNote';
import { useMatchReward } from '@/lib/store/matchReward';
import {
  controlsBatter,
  controlsPitcher,
  currentControllerUid,
  INNING_BREAK_MS,
  isPartyMode,
  isPlayerBatting,
  isSameSide,
  selectHudState,
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
  // 결과가 공개되기 전까지 HUD는 투구 직전 상태를 그린다 (카운트·아웃·점수 감춤)
  const hud = useMatchStore(selectHudState);
  const phase = useMatchStore((s) => s.phase);
  const lastResult = useMatchStore((s) => s.lastResult);
  const revealed = useMatchStore((s) => s.revealed);
  const log = useMatchStore((s) => s.log);
  const advance = useMatchStore((s) => s.advance);
  const playerSide = useMatchStore((s) => s.playerSide);
  const batting = useMatchStore((s) => isPlayerBatting(s));
  const waiting = useMatchStore((s) => s.waitingRemote);
  // 2대2에서는 "우리 팀 차례"가 아니라 "내 선수 차례"여야 조작할 수 있다
  const canBat = useMatchStore(controlsBatter);
  const canPitch = useMatchStore(controlsPitcher);
  const party = useMatchStore((s) => isPartyMode(s.mode));
  // 공수 교대를 건너뛰는 건 혼자 하는 경기에서만. 온라인에서 한 명만 먼저 넘어가면
  // 그 사람의 투구 명령을 아직 교대 중인 호스트가 버리거나(무한 대기 -> 피치 클락 위반),
  // 반대로 호스트가 먼저 넘어가면 남은 사람의 연출이 잘리고 시계만 깎인다.
  const canSkipBreak = useMatchStore((s) => s.mode === 'CPU');
  // 대타·대주자·대수비는 아직 CPU·리그 전용이다 (온라인은 SUB_* 프로토콜이 필요).
  const canSubstitute = useMatchStore((s) => s.mode === 'CPU');
  const controllerUid = useMatchStore(currentControllerUid);
  const controllerName = useMatchStore((s) =>
    controllerUid ? (s.seatNames[controllerUid] ?? '상대') : '',
  );
  const controllerIsTeammate = useMatchStore(
    (s) => !!controllerUid && controllerUid !== s.myUid && isSameSide(s, controllerUid),
  );
  // 모든 모드가 이 훅으로 보상을 받는다 (골드 + 선수별 경험치)
  const reward = useMatchReward();
  const spectating = party && !canBat && !canPitch;
  const [cameraMode, setCameraMode] = useState<CameraMode>('DRAMATIC');
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const breakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // 공수 교대 안내가 끝나면 다음 이닝을 시작한다.
  // (advance()를 한 번 더 부르면 엔진 상태가 INNING_BREAK -> SETUP으로 넘어간다)
  useEffect(() => {
    if (phase !== 'INNING_BREAK') return;
    const ms = Math.max(0, useMatchStore.getState().inningBreakEndsAt - performance.now());
    breakTimerRef.current = setTimeout(() => advance(), ms);
    return () => {
      if (breakTimerRef.current) clearTimeout(breakTimerRef.current);
    };
  }, [phase, advance]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log.length]);

  if (!state || !hud) {
    return (
      <div className="grid min-h-dvh place-items-center text-slate-500">경기를 준비하는 중…</div>
    );
  }

  const batter = currentBatter(hud);
  const pitcher = currentPitcher(hud);
  // 끝내기 상황에서 종료 화면이 먼저 뜨면 마지막 플레이를 볼 수 없다.
  // 연출이 끝나고 advance()가 돌아야 띄운다.
  const over = state.phase === 'GAME_OVER' && phase !== 'RESULT';
  // 공수 교대 중에는 조작 패널을 접어 스카이뷰를 가리지 않는다
  const inningBreak = phase === 'INNING_BREAK';

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
            <Scoreboard state={hud} />
          </div>
          <CountDisplay state={hud} />
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
      {!over && !inningBreak && spectating && (
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
      {!over && !inningBreak && (
        <div className="game-control-panel absolute bottom-3 right-3 z-20 w-[300px] max-w-[calc(100vw-24px)]">
          {canBat ? (
            <>
              <BatPanel state={hud} batter={batter} />
              {canSubstitute && phase === 'SETUP' && (
                <SubPanel state={state} playerSide={playerSide as Side} batting />
              )}
            </>
          ) : canPitch && phase === 'SETUP' ? (
            <>
              <PitchPanel
                state={state}
                pitcher={pitcher}
                playerSide={playerSide as Side}
                mirrored={zoneFlippedOnScreen(cameraMode, batting)}
              />
              {canSubstitute && (
                <SubPanel state={state} playerSide={playerSide as Side} batting={false} />
              )}
            </>
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
            {revealed ? (
              <div className="pop-in">
                <div className="text-base font-bold">{lastResult.description}</div>
                {lastResult.battedBall && lastResult.contact && (
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    타구속도 {Math.round(lastResult.battedBall.exitVelocity)}km/h · 발사각{' '}
                    {Math.round(lastResult.battedBall.launchAngle)}° · 비거리{' '}
                    {Math.round(lastResult.battedBall.distance)}m
                  </div>
                )}
              </div>
            ) : lastResult.contact ? (
              // 아직 승부가 끝나지 않았다. 타구 데이터도 답을 알려 주므로 함께 감춘다.
              <div className="text-base font-bold text-amber-300 flash">타구!</div>
            ) : lastResult.stealResults.length > 0 ? (
              // 주자가 뛰는 건 어차피 화면에 보인다. 세이프/아웃만 감춘다.
              <div className="text-base font-bold text-amber-300 flash">주자 스타트!</div>
            ) : (
              // 공이 미트에 닿기 직전 (CPU 타자는 판정이 먼저 확정된다)
              <div className="text-base font-bold text-slate-500">…</div>
            )}
          </div>
        </div>
      )}

      {/* 공수 교대 안내 */}
      {inningBreak && (
        <InningBreakOverlay state={state} onSkip={canSkipBreak ? advance : null} />
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
            {reward && (
              <div className="mb-6">
                <RewardNote reward={reward} />
              </div>
            )}
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

/**
 * 공수 교대 안내.
 * 3아웃 직후 스카이뷰(카메라는 GameScene이 잡는다) 위에 몇 회 초/말인지를
 * 띄워 두는 화면. INNING_BREAK_MS가 지나면 GameView가 다음 이닝을 시작한다.
 *
 * onSkip이 null이면 건너뛰기 버튼을 내린다. 여럿이 하는 경기에서는 한 명만
 * 먼저 넘어가면 나머지와 단계가 어긋나므로 다 같이 기다린다.
 */
function InningBreakOverlay({
  state,
  onSkip,
}: {
  state: GameState;
  onSkip: (() => void) | null;
}) {
  const top = state.half === 'TOP';
  const offense = top ? state.away : state.home;
  const defense = top ? state.home : state.away;

  return (
    <div className="inning-break pointer-events-none absolute inset-0 z-30 grid place-items-center">
      <div className="inning-break-card text-center">
        <div className="inning-break-kicker">공수 교대</div>
        <div className="inning-break-title tabular">
          {state.inning}회 {top ? '초' : '말'}
        </div>
        <div className="inning-break-sides">
          <span>
            <i style={{ background: offense.primaryColor }} />
            {offense.name} 공격
          </span>
          <span className="inning-break-dot">·</span>
          <span>
            <i style={{ background: defense.primaryColor }} />
            {defense.name} 수비
          </span>
        </div>
        <div className="inning-break-score tabular">
          {state.away.abbr} {state.away.runs} : {state.home.runs} {state.home.abbr}
        </div>
        <div className="inning-break-progress">
          <i style={{ animationDuration: `${INNING_BREAK_MS}ms` }} />
        </div>
      </div>
      {onSkip && (
        <button className="inning-break-skip pointer-events-auto" onClick={onSkip}>
          건너뛰기 ›
        </button>
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
