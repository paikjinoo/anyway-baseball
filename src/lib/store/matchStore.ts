'use client';

import { create } from 'zustand';
import { Rng, clamp, seedFromString } from '../game/rng';
import {
  bullpenCandidates,
  benchCandidates,
  changePitcher,
  createGame,
  currentBatter,
  currentCatcher,
  currentPitcher,
  defenseTeam,
  offense,
  pinchHit,
  pinchRun,
  preparePitch,
  resolvePitch,
  resolvePitchClockViolation,
  subFielder,
} from '../game/engine';
import { decidePitch, decideSteal, decideSwing, shouldChangePitcher, type Difficulty } from '../game/ai';
import type { MatchRewardContext } from '../game/matchReward';
import { PITCH_CLOCK_MS, PITCH_CLOCK_NET_GRACE_MS } from '../game/constants';
import { arsenalOf } from '../game/pitching';
import { buildTimeline, type PlayTimeline } from '../game/playback';
import {
  advanceRelayState,
  applyRelayPitchResult,
  currentRelayBatter,
  currentRelayPitcher,
  relayGameState,
  resolveRelayPitch,
  resolveRelayPitchClockViolation,
  type RelayState,
} from '../game/relay';
import type {
  GameSettings,
  GameState,
  PitchClockViolation,
  PitchCommand,
  PitchResult,
  PitchTrajectory,
  Player,
  Position,
  Side,
  SwingType,
  Team,
} from '../game/types';
import type { OwnerMap } from '../net/protocol';
import {
  playBatCrack,
  playCheer,
  playHitCheer,
  playHomeRunCelebration,
  playMitt,
  playPitchRelease,
  playUmpireCall,
  playWeakContact,
  playWhiff,
  startCrowd,
  stopCrowd,
} from '../audio/sfx';

export type MatchMode =
  | 'CPU'
  | 'ONLINE_HOST'
  | 'ONLINE_GUEST'
  | 'PARTY_HOST'
  | 'PARTY_GUEST'
  | 'RELAY_HOST'
  | 'RELAY_GUEST';

/** 야수 교체 종류. 대타 / 대주자 / 대수비. */
export type SubKind = 'HIT' | 'RUN' | 'FIELD';

/** 보상 산정 구분. matchReward가 이 값으로 배수와 시즌 기록 여부를 정한다. */
export type MatchRewardKind = MatchRewardContext['kind'];

/** 판정 권한을 가진 쪽인가 (호스트 권위 모델) */
export function isHostMode(m: MatchMode): boolean {
  return m === 'CPU' || m === 'ONLINE_HOST' || m === 'PARTY_HOST' || m === 'RELAY_HOST';
}
/** 2대2인가 */
export function isPartyMode(m: MatchMode): boolean {
  return m === 'PARTY_HOST' || m === 'PARTY_GUEST';
}
export function isRelayMode(m: MatchMode): boolean {
  return m === 'RELAY_HOST' || m === 'RELAY_GUEST';
}
function usesOwnerControls(m: MatchMode): boolean {
  return isPartyMode(m) || isRelayMode(m);
}
/** 입력을 호스트로 보내야 하는 쪽인가 */
export function isRemoteMode(m: MatchMode): boolean {
  return m === 'ONLINE_GUEST' || m === 'PARTY_GUEST' || m === 'RELAY_GUEST';
}

/** UI가 다루는 진행 단계 */
export type MatchPhase =
  | 'IDLE'
  /** 투구 전. 수비측은 구종/코스 선택, 공격측은 도루 지시 */
  | 'SETUP'
  /** 공이 날아가는 중 */
  | 'FLIGHT'
  /** 타구/판정 연출 중 */
  | 'RESULT'
  /** 공수 교대. 스카이뷰로 그라운드를 비추며 회차를 알린다 */
  | 'INNING_BREAK'
  | 'GAME_OVER';

export interface LogEntry {
  id: number;
  text: string;
  kind: 'play' | 'inning' | 'score' | 'info';
}

interface MatchStore {
  mode: MatchMode;
  difficulty: Difficulty;
  /** 보상 산정 구분. CPU와 리그는 같은 엔진 모드를 쓰지만 보상 근거가 다르다. */
  rewardKind: MatchRewardKind;
  state: GameState | null;
  /** 릴레이 모드의 순환표·점수 원장. 일반 경기에서는 null이다. */
  relayState: RelayState | null;
  /** 사람이 조종하는 팀 */
  playerSide: Side;
  phase: MatchPhase;

  // --- 2대2 전용 ---
  /** 내 uid. 내 선수인지 판별하는 기준. */
  myUid: string;
  /** 선수 id -> 조작 권한자 uid. 1:1/CPU에서는 비어 있다. */
  owners: OwnerMap;
  /** uid -> 표시 이름 (관전 안내에 쓴다) */
  seatNames: Record<string, string>;

  /**
   * 피치 클락 만료 시각 (performance.now() 기준). 0이면 시계가 멈춰 있다.
   * SETUP에 들어갈 때마다 다시 감긴다.
   */
  pitchClockEndsAt: number;

  /**
   * 공수 교대 안내가 끝나는 시각 (performance.now() 기준). 0이면 교대 중이 아니다.
   * 카메라(스카이뷰)와 안내 문구가 이 시각까지 유지된다.
   */
  inningBreakEndsAt: number;

  trajectory: PitchTrajectory | null;
  pitchCmd: PitchCommand | null;
  /**
   * 투구 전, 수비측이 패널에서 고르고 있는 구종과 코스.
   * 3D 화면이 예상 궤적을 그리는 데 쓴다.
   *
   * 스토어는 클라이언트마다 따로이고 이 값은 투구 패널만 채우므로,
   * 타자 쪽 화면에는 절대 전달되지 않는다(구종이 새면 게임이 성립하지 않는다).
   */
  pitchPreview: PitchCommand | null;
  /**
   * performance.now() 기준 "공을 놓는" 시각.
   * 투수 모션이 먼저 재생되므로 투구를 확정한 시점보다 WINDUP_MS 만큼 뒤다.
   */
  pitchStartAt: number;
  /** 와인드업이 시작된 시각 */
  deliveryStartAt: number;
  /** 화면상 공이 홈플레이트에 도달하기까지의 시간 (ms) */
  displayFlightMs: number;
  /** 이번 투구에 스윙 입력이 이미 들어갔는가 */
  swung: boolean;
  /** 스윙 모션 시작 시각 */
  swungAt: number;
  /**
   * 재생 중인 스윙 모션의 종류. 화면에 그릴 동작만 고르는 값이라
   * swungAt이 0이면 의미가 없다(= 방망이를 내지 않은 공).
   */
  swungType: SwingType;

  lastResult: PitchResult | null;
  /** 투구가 해석되기 직전의 상태. 결과 연출은 이 상태를 기준으로 그린다. */
  prePitchState: GameState | null;
  /** 이번 플레이의 주루 타임라인 */
  timeline: PlayTimeline | null;
  /** 결과 연출 기준 시각 (performance.now()) */
  resultStartAt: number;
  /** 결과 연출 배속 (엔진 초 / 화면 초) */
  playRate: number;
  /** 결과 연출 총 길이 (ms) */
  resultMs: number;
  /**
   * 결과가 화면에 공개되었는가.
   * 판정은 배트에 맞는 순간 이미 끝나 있지만, 화면(배너·로그·카운트·환호)은
   * 눈으로 승부가 끝날 때까지 기다린다. false인 동안은 투구 직전 상태를 그린다.
   */
  revealed: boolean;
  /** 결과가 공개되는 시각 (performance.now()) */
  revealAt: number;
  log: LogEntry[];
  stealOrders: number[];
  /** 타격 조준 커서 */
  aim: { x: number; y: number };
  swingType: SwingType;
  /** 온라인에서 상대 입력 대기 중 */
  waitingRemote: boolean;
  message: string | null;

  /** 온라인 전송 콜백. 호스트/게스트 페이지가 주입한다. */
  sendFn: ((m: unknown) => void) | null;

  // --- 액션 -----------------------------------------------------------------
  initCpuGame: (opts: {
    playerTeam: Team;
    cpuTeam: Team;
    playerSide: Side;
    settings: GameSettings;
    difficulty: Difficulty;
    seed?: string;
    /** 기본값 'CPU'. 리그 일정 경기는 'LEAGUE'를 넘긴다. */
    rewardKind?: MatchRewardKind;
  }) => void;
  initOnlineGame: (opts: {
    state: GameState;
    mode: 'ONLINE_HOST' | 'ONLINE_GUEST';
    playerSide: Side;
    sendFn: (m: unknown) => void;
  }) => void;
  initPartyGame: (opts: {
    state: GameState;
    mode: 'PARTY_HOST' | 'PARTY_GUEST';
    playerSide: Side;
    myUid: string;
    owners: OwnerMap;
    seatNames: Record<string, string>;
    sendFn: (m: unknown) => void;
  }) => void;
  initRelayGame: (opts: {
    relayState: RelayState;
    mode: 'RELAY_HOST' | 'RELAY_GUEST';
    myUid: string;
    settings: GameSettings;
    sendFn: (m: unknown) => void;
  }) => void;
  applyRelayState: (state: RelayState, notice?: string) => void;
  applyRelayResult: (result: PitchResult, state: RelayState) => void;
  setOwners: (owners: OwnerMap) => void;
  applyRemoteState: (s: GameState) => void;
  applyRemoteResult: (r: PitchResult) => void;
  startRemotePitch: (cmd: PitchCommand) => void;

  setAim: (x: number, y: number) => void;
  setSwingType: (t: SwingType) => void;
  /** 투구 패널이 선택 상태를 3D 화면에 알린다. 패널이 사라지면 null로 지운다. */
  setPitchPreview: (cmd: PitchCommand | null) => void;
  toggleSteal: (base: number) => void;
  /** 수비측(사람)이 투구를 확정 */
  throwPitch: (cmd: PitchCommand) => void;
  /** 공격측(사람)이 스윙 */
  swing: (type?: SwingType) => void;
  /** 사람이 타석에 있을 때, 준비가 끝나 상대(CPU) 투구를 요청 */
  requestPitch: () => void;
  /**
   * 애니메이션 프레임에서 호출.
   * SETUP이면 피치 클락을, FLIGHT면 미트를 지난 공을 자동으로 처리한다.
   */
  tick: (now: number) => void;
  /** 결과 연출이 끝나고 다음 투구로 */
  advance: () => void;
  substitutePitcher: (pitcherId: string) => void;
  /**
   * 야수 교체. arg는 대주자면 베이스 인덱스(0=1루), 대수비면 포지션이다.
   * 대타에는 쓰지 않는다.
   */
  substituteFielder: (kind: SubKind, playerId: string, arg?: number | Position) => void;
  reset: () => void;
  pushLog: (text: string, kind?: LogEntry['kind']) => void;
}

let logId = 0;
/** AI 판단 전용 난수. 게임 RNG를 소비하면 온라인 재현성이 깨지므로 분리한다. */
let aiRng = new Rng(1);

/**
 * 투구를 확정한 뒤 실제로 공을 놓기까지의 시간 (ms).
 * 이 리드타임이 있어야 와인드업 -> 스트라이드 -> 릴리스가 순서대로 보인다.
 */
export const WINDUP_MS = 520;
/** 스윙 모션 길이 (ms). 임팩트는 모션의 45% 지점. */
export const SWING_MS = 340;
/**
 * 번트 모션 길이 (ms). 스퀘어(30%)가 끝난 직후가 임팩트라
 * SWING_LEAD_MS / BUNT_MS ≈ 0.34에 공이 닿는다.
 */
export const BUNT_MS = 440;
/** 타자가 공 도달 전에 스윙을 시작하는 시간 (ms). 임팩트를 모션 중간에 맞춘다. */
const SWING_LEAD_MS = 150;

/**
 * 공수 교대 안내를 띄워 두는 시간 (ms).
 * 3아웃이 나온 직후 곧바로 다음 이닝이 시작되면 공격/수비가 뜬금없이 뒤바뀐 것처럼
 * 보이므로, 그 사이에 스카이뷰로 그라운드를 비추며 회차를 알린다.
 */
export const INNING_BREAK_MS = 5000;

/** 스윙 종류에 맞는 모션 길이 */
export function swingMotionMs(type: SwingType): number {
  return type === 'BUNT' ? BUNT_MS : SWING_MS;
}
/**
 * 원격 공격측의 스윙 입력을 기다려 주는 여유 시간 (ms).
 * 이 시간이 지나도 오지 않으면 호스트가 "지켜본 공"으로 처리해 경기를 진행시킨다.
 * 상대 클라이언트도 같은 공을 1.22배 지점에서 자동 처리하므로,
 * 왕복 지연을 넉넉히 덮을 만큼만 잡으면 된다.
 */
const REMOTE_INPUT_GRACE_MS = 2500;

function flightMsFor(traj: PitchTrajectory, settings: GameSettings): number {
  // pitchSpeedScale이 작을수록 화면에서 느리게 보인다(= 쉬움)
  const scale = clamp(settings.pitchSpeedScale, 0.25, 1);
  return (traj.flightTime / scale) * 1000;
}

/** 투구 시작 시 공통으로 세팅되는 값 */
function pitchTiming(traj: PitchTrajectory, settings: GameSettings) {
  const now = performance.now();
  return {
    deliveryStartAt: now,
    pitchStartAt: now + WINDUP_MS,
    displayFlightMs: flightMsFor(traj, settings),
  };
}

/**
 * 결과가 공개된 뒤 최소한 이만큼은 배너를 띄워 둔다 (ms).
 * 승부가 끝나는 순간에 맞춰 공개하므로, 이 여유가 없으면 결과를 읽기도 전에
 * 다음 타석으로 넘어간다.
 */
const REVEAL_HOLD_MS = 1300;

/**
 * 결과 연출의 배속과 길이를 정한다.
 * 주루가 길어질수록(2·3루타, 주자 다수) 조금 빠르게 돌리되,
 * 짧은 플레이는 실제 속도에 가깝게 둔다.
 */
function playbackPlan(result: PitchResult, tl: PlayTimeline): { rate: number; ms: number } {
  const plan = basePlan(result, tl);
  // 공개 시점 + 읽을 시간보다 일찍 끝나면 안 된다
  const revealMs = (tl.revealAt / plan.rate) * 1000;
  return { rate: plan.rate, ms: Math.max(plan.ms, revealMs + REVEAL_HOLD_MS) };
}

function basePlan(result: PitchResult, tl: PlayTimeline): { rate: number; ms: number } {
  if (result.kind === 'HOME_RUN') {
    const rate = 1.15;
    return { rate, ms: (tl.duration / rate) * 1000 + 1800 };
  }
  if (!result.contact && !tl.runners.length) return { rate: 1, ms: 950 };
  // 볼넷·사구·도루처럼 타구가 없는 진루는 짧게 보여준다
  const quick = !result.contact;
  const target = quick ? 2.5 : 3.6;
  const hold = quick ? 350 : 550;
  const rate = clamp(tl.duration / target, 0.85, 1.8);
  return { rate, ms: (tl.duration / rate) * 1000 + hold };
}

// --- 결과 공개 타이머 ---------------------------------------------------------
// 판정이 끝난 뒤에도 화면은 기다린다. 그 대기를 관리하는 유일한 타이머.

let revealTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReveal: (() => void) | null = null;

function scheduleReveal(fn: () => void, delayMs: number) {
  cancelReveal();
  pendingReveal = fn;
  if (delayMs <= 0) {
    flushReveal();
    return;
  }
  revealTimer = setTimeout(flushReveal, delayMs);
}

/** 아직 공개하지 않았다면 지금 공개한다. 연출이 잘려도 로그는 남아야 한다. */
function flushReveal() {
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  const fn = pendingReveal;
  pendingReveal = null;
  fn?.();
}

function cancelReveal() {
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  pendingReveal = null;
}

export const useMatchStore = create<MatchStore>((set, get) => ({
  mode: 'CPU',
  difficulty: 'NORMAL',
  rewardKind: 'CPU',
  state: null,
  relayState: null,
  playerSide: 'away',
  phase: 'IDLE',
  myUid: '',
  owners: {},
  seatNames: {},
  pitchClockEndsAt: 0,
  inningBreakEndsAt: 0,
  trajectory: null,
  pitchCmd: null,
  pitchPreview: null,
  pitchStartAt: 0,
  deliveryStartAt: 0,
  displayFlightMs: 800,
  swung: false,
  swungAt: 0,
  swungType: 'NORMAL',
  lastResult: null,
  prePitchState: null,
  timeline: null,
  resultStartAt: 0,
  playRate: 1,
  resultMs: 950,
  revealed: true,
  revealAt: 0,
  log: [],
  stealOrders: [],
  aim: { x: 0, y: 0 },
  swingType: 'NORMAL',
  waitingRemote: false,
  message: null,
  sendFn: null,

  // -------------------------------------------------------------------------

  initCpuGame: ({ playerTeam, cpuTeam, playerSide, settings, difficulty, seed, rewardKind }) => {
    const away = playerSide === 'away' ? playerTeam : cpuTeam;
    const home = playerSide === 'home' ? playerTeam : cpuTeam;
    const seedSource = seed ?? `cpu-${Date.now()}-${playerTeam.id}`;
    const state = createGame(away, home, settings, seedSource);
    aiRng = new Rng(seedFromString(seedSource + ':ai'));
    logId = 0;
    cancelReveal();
    startCrowd();
    set({
      mode: 'CPU',
      difficulty,
      rewardKind: rewardKind ?? 'CPU',
      state,
      relayState: null,
      playerSide,
      myUid: '',
      owners: {},
      seatNames: {},
      phase: 'SETUP',
      pitchClockEndsAt: performance.now() + PITCH_CLOCK_MS,
      inningBreakEndsAt: 0,
      trajectory: null,
      pitchCmd: null,
      pitchPreview: null,
      lastResult: null,
      prePitchState: null,
      timeline: null,
      revealed: true,
      revealAt: 0,
      swung: false,
      swungAt: 0,
      stealOrders: [],
      aim: { x: 0, y: 0 },
      swingType: 'NORMAL',
      waitingRemote: false,
      message: null,
      log: [
        { id: logId++, text: `${away.name} vs ${home.name} 경기를 시작합니다.`, kind: 'info' },
        { id: logId++, text: '1회 초 시작', kind: 'inning' },
      ],
    });
  },

  initOnlineGame: ({ state, mode, playerSide, sendFn }) => {
    aiRng = new Rng(seedFromString(state.id + ':ai'));
    logId = 0;
    cancelReveal();
    startCrowd();
    set({
      mode,
      rewardKind: 'ONLINE',
      state,
      relayState: null,
      playerSide,
      myUid: '',
      owners: {},
      seatNames: {},
      sendFn,
      phase: 'SETUP',
      pitchClockEndsAt: performance.now() + PITCH_CLOCK_MS,
      inningBreakEndsAt: 0,
      trajectory: null,
      pitchCmd: null,
      pitchPreview: null,
      lastResult: null,
      prePitchState: null,
      timeline: null,
      revealed: true,
      revealAt: 0,
      swung: false,
      swungAt: 0,
      stealOrders: [],
      aim: { x: 0, y: 0 },
      swingType: 'NORMAL',
      waitingRemote: false,
      message: null,
      log: [
        { id: logId++, text: `${state.away.name} vs ${state.home.name} 온라인 경기 시작!`, kind: 'info' },
        { id: logId++, text: '1회 초 시작', kind: 'inning' },
      ],
    });
  },

  initPartyGame: ({ state, mode, playerSide, myUid, owners, seatNames, sendFn }) => {
    aiRng = new Rng(seedFromString(state.id + ':ai'));
    logId = 0;
    cancelReveal();
    startCrowd();
    set({
      mode,
      rewardKind: 'ONLINE',
      state,
      relayState: null,
      playerSide,
      myUid,
      owners,
      seatNames,
      sendFn,
      phase: 'SETUP',
      pitchClockEndsAt: performance.now() + PITCH_CLOCK_MS,
      inningBreakEndsAt: 0,
      trajectory: null,
      pitchCmd: null,
      pitchPreview: null,
      lastResult: null,
      prePitchState: null,
      timeline: null,
      revealed: true,
      revealAt: 0,
      swung: false,
      swungAt: 0,
      stealOrders: [],
      aim: { x: 0, y: 0 },
      swingType: 'NORMAL',
      waitingRemote: false,
      message: null,
      log: [
        {
          id: logId++,
          text: `${state.away.name} vs ${state.home.name} 2대2 올스타전 시작!`,
          kind: 'info',
        },
        {
          id: logId++,
          text: `선발 투수 추첨 결과 — ${state.away.abbr}: ${state.away.roster[state.away.pitcherId]?.name ?? '-'}, ${state.home.abbr}: ${state.home.roster[state.home.pitcherId]?.name ?? '-'}`,
          kind: 'info',
        },
        { id: logId++, text: '1회 초 시작', kind: 'inning' },
      ],
    });
  },

  initRelayGame: ({ relayState, mode, myUid, settings, sendFn }) => {
    logId = 0;
    cancelReveal();
    startCrowd();
    const state = relayGameState(relayState, settings);
    const control = relayControlState(relayState, state, myUid);
    set({
      mode,
      rewardKind: 'RELAY',
      state,
      relayState,
      playerSide: control.playerSide,
      myUid,
      owners: control.owners,
      seatNames: Object.fromEntries(relayState.participants.map((p) => [p.uid, p.name])),
      sendFn,
      phase: relayState.phase === 'GAME_OVER' ? 'GAME_OVER' : 'SETUP',
      pitchClockEndsAt:
        relayState.phase === 'GAME_OVER' ? 0 : performance.now() + PITCH_CLOCK_MS,
      inningBreakEndsAt: 0,
      trajectory: null,
      pitchCmd: null,
      pitchPreview: null,
      lastResult: null,
      prePitchState: null,
      timeline: null,
      revealed: true,
      revealAt: 0,
      swung: false,
      swungAt: 0,
      stealOrders: [],
      aim: { x: 0, y: 0 },
      swingType: 'NORMAL',
      waitingRemote: false,
      message: null,
      log: [
        { id: logId++, text: `${relayState.participants.length}인 릴레이 타격 대결 시작!`, kind: 'info' },
        {
          id: logId++,
          text: `1라운드 — ${currentRelayPitcher(relayState)?.name ?? '-'} 투구`,
          kind: 'inning',
        },
      ],
    });
  },

  applyRelayState: (relayState, notice) => {
    const st = get();
    if (!st.state) return;
    const state = relayGameState(relayState, st.state.settings);
    const control = relayControlState(relayState, state, st.myUid);
    const roundChanged = st.relayState?.roundIndex !== relayState.roundIndex;
    set({
      relayState,
      state,
      playerSide: control.playerSide,
      owners: control.owners,
      seatNames: Object.fromEntries(relayState.participants.map((p) => [p.uid, p.name])),
      phase: relayState.phase === 'GAME_OVER' ? 'GAME_OVER' : 'SETUP',
      pitchClockEndsAt:
        relayState.phase === 'GAME_OVER' ? 0 : performance.now() + PITCH_CLOCK_MS,
      trajectory: null,
      pitchCmd: null,
      pitchPreview: null,
      lastResult: null,
      prePitchState: null,
      timeline: null,
      revealed: true,
      revealAt: 0,
      swung: false,
      swungAt: 0,
      waitingRemote: false,
    });
    if (notice) get().pushLog(notice, 'info');
    if (roundChanged && relayState.phase !== 'GAME_OVER') {
      get().pushLog(
        `${relayState.roundIndex + 1}라운드 — ${currentRelayPitcher(relayState)?.name ?? '-'} 투구`,
        'inning',
      );
    }
    if (relayState.phase === 'GAME_OVER') stopCrowd();
  },

  applyRelayResult: (result, relayState) => {
    set({ relayState });
    applyResult(set, get, result);
  },

  setOwners: (owners) => set({ owners }),

  applyRemoteState: (s) => set({ state: s }),

  applyRemoteResult: (r) => {
    applyResult(set, get, r);
  },

  /** 게스트가 호스트로부터 PITCH_GO를 받았을 때 */
  startRemotePitch: (cmd) => {
    const { state } = get();
    if (!state) return;
    const traj = preparePitch(state, cmd);
    playPitchRelease(WINDUP_MS / 1000);
    set({
      pitchCmd: cmd,
      trajectory: traj,
      phase: 'FLIGHT',
      ...pitchTiming(traj, state.settings),
      swung: false,
      swungAt: 0,
      waitingRemote: false,
    });
  },

  setAim: (x, y) => set({ aim: { x: clamp(x, -1.9, 1.9), y: clamp(y, -1.9, 1.9) } }),
  setSwingType: (t) => set({ swingType: t }),
  setPitchPreview: (cmd) => set({ pitchPreview: cmd }),

  toggleSteal: (base) =>
    set((s) => ({
      stealOrders: s.stealOrders.includes(base)
        ? s.stealOrders.filter((b) => b !== base)
        : [...s.stealOrders, base],
    })),

  requestPitch: () => {
    const st = get();
    if (st.mode !== 'CPU' || st.phase !== 'SETUP') return;
    if (!isPlayerBatting(st)) return;
    maybeAutoPitch(set, get);
  },

  throwPitch: (cmd) => {
    const st = get();
    if (!st.state || st.phase !== 'SETUP') return;
    // 2대2: 마운드에 선 선수가 내 선수일 때만 던질 수 있다
    if (!controlsPitcher(st)) return;

    if (isRemoteMode(st.mode)) {
      // 게스트는 판정 권한이 없다. 명령만 보내고 PITCH_GO를 기다린다.
      if (isRelayMode(st.mode) && st.relayState) {
        st.sendFn?.({
          t: 'RELAY_PITCH',
          turnId: st.relayState.turnId,
          pitchSeq: st.relayState.pitchSeq + 1,
          cmd,
        });
      } else {
        st.sendFn?.({ t: 'PITCH', cmd });
      }
      set({ waitingRemote: true });
      return;
    }
    startPitch(set, get, cmd);
  },

  swing: (type) => {
    const st = get();
    const { state, trajectory, phase, pitchStartAt, displayFlightMs, aim, swingType, mode, sendFn } = st;
    if (!state || !trajectory || phase !== 'FLIGHT' || st.swung) return;
    if (!controlsBatter(st)) return;

    const now = performance.now();
    const elapsed = now - pitchStartAt;
    // 와인드업 중 입력이 스윙을 소모하지 않도록 실제 릴리스 이후에만 받는다.
    if (elapsed < 0) return;

    const t = type ?? swingType;
    // 입력 후 약 SWING_LEAD_MS 뒤에 배트가 임팩트 지점에 도달한다.
    // 따라서 공 도착보다 그만큼 일찍 누른 순간을 정타(0ms)로 삼고,
    // 화면 시간 오차를 엔진 시간 오차로 환산한다.
    const scale = clamp(state.settings.pitchSpeedScale, 0.25, 1);
    const timingMs = (elapsed - (displayFlightMs - SWING_LEAD_MS)) * scale;

    const cmd = { swing: true, type: t, aimX: aim.x, aimY: aim.y, timingMs };
    set({ swung: true, swungAt: now, swungType: t });

    if (isRemoteMode(mode)) {
      if (isRelayMode(mode) && st.relayState) {
        sendFn?.({
          t: 'RELAY_SWING',
          turnId: st.relayState.turnId,
          pitchSeq: st.relayState.pitchSeq + 1,
          cmd,
        });
      } else {
        // 도루 지시는 투구와 동시에 판정되므로 스윙과 함께 보낸다
        sendFn?.({ t: 'SWING', cmd, steal: st.stealOrders });
      }
      set({ waitingRemote: true });
      return;
    }
    finalize(set, get, cmd, st.stealOrders);
  },

  tick: (now) => {
    const st = get();
    if (st.phase === 'SETUP') {
      tickPitchClock(set, get, now);
      return;
    }
    if (st.phase !== 'FLIGHT' || !st.state || !st.trajectory) return;
    const elapsed = now - st.pitchStartAt;
    const noSwing = { swing: false, type: st.swingType, aimX: st.aim.x, aimY: st.aim.y, timingMs: 0 };

    if (isRemoteMode(st.mode)) {
      if (elapsed < st.displayFlightMs * 1.22 || st.swung) return;
      if (controlsBatter(st) && !st.waitingRemote) {
        if (isRelayMode(st.mode) && st.relayState) {
          st.sendFn?.({
            t: 'RELAY_SWING',
            turnId: st.relayState.turnId,
            pitchSeq: st.relayState.pitchSeq + 1,
            cmd: noSwing,
          });
        } else {
          st.sendFn?.({ t: 'SWING', cmd: noSwing, steal: st.stealOrders });
        }
        set({ swung: true, waitingRemote: true });
      }
      return;
    }

    if (controlsBatter(st)) {
      if (elapsed < st.displayFlightMs * 1.22 || st.swung) return;
      set({ swung: true });
      finalize(set, get, noSwing, st.stealOrders);
      return;
    }

    // 호스트인데 타석을 조작하는 사람이 따로 있는 경우.
    // 그쪽 입력이 끝내 오지 않으면(접속 불안정 등) 경기가 멈추므로
    // 넉넉히 기다린 뒤 "지켜본 공"으로 처리해 진행시킨다.
    if (st.mode !== 'CPU' && elapsed > st.displayFlightMs * 1.22 + REMOTE_INPUT_GRACE_MS) {
      set({ swung: true });
      finalize(set, get, noSwing, []);
    }
  },

  advance: () => {
    // 연출이 잘렸더라도(빠른 진행·나가기 등) 실황 로그는 남기고 넘어간다
    flushReveal();
    const current = get();
    const { state } = current;
    if (!state) return;
    if (isRelayMode(current.mode)) {
      // 게스트는 호스트가 보낸 RELAY_STATE를 기다린다. 각자 타이머로 넘기면
      // 네트워크 지연에 따라 차례가 갈라질 수 있다.
      if (current.mode === 'RELAY_GUEST' || !current.relayState) return;
      const nextRelay = advanceRelayState(current.relayState);
      current.applyRelayState(nextRelay);
      current.sendFn?.({ t: 'RELAY_STATE', state: nextRelay });
      return;
    }
    if (state.phase === 'GAME_OVER') {
      stopCrowd();
      set({ phase: 'GAME_OVER' });
      return;
    }
    // 공수 교대. 곧바로 다음 이닝을 시작하면 공격/수비가 뜬금없이 뒤바뀌므로,
    // 스카이뷰로 그라운드를 비추며 회차를 알리는 시간을 먼저 둔다.
    // 안내가 끝나면 UI가 advance()를 한 번 더 불러 아래 분기로 들어온다.
    if (state.phase === 'INNING_BREAK' && get().phase !== 'INNING_BREAK') {
      playCheer(0.45, 2.4);
      set({
        phase: 'INNING_BREAK',
        inningBreakEndsAt: performance.now() + INNING_BREAK_MS,
        // 안내가 끝나고 SETUP에 들어갈 때 다시 감는다 (교대 시간은 재지 않는다)
        pitchClockEndsAt: 0,
        trajectory: null,
        lastResult: null,
        prePitchState: null,
        timeline: null,
        revealed: true,
        revealAt: 0,
        swung: false,
        swungAt: 0,
        stealOrders: [],
      });
      return;
    }
    if (state.phase === 'INNING_BREAK') {
      const s2 = { ...state, phase: 'SETUP' as const };
      set({ state: s2 });
      get().pushLog(
        `${s2.inning}회 ${s2.half === 'TOP' ? '초' : '말'} 시작`,
        'inning',
      );
    }
    set({
      phase: 'SETUP',
      // 다음 타자/투구를 준비하는 순간부터 피치 클락이 다시 흐른다
      pitchClockEndsAt: performance.now() + PITCH_CLOCK_MS,
      inningBreakEndsAt: 0,
      trajectory: null,
      lastResult: null,
      prePitchState: null,
      timeline: null,
      revealed: true,
      revealAt: 0,
      swung: false,
      swungAt: 0,
      stealOrders: [],
    });
  },

  substitutePitcher: (pitcherId) => {
    const { state, playerSide, mode, sendFn, owners, myUid, phase } = get();
    if (!state || phase !== 'SETUP') return;
    if (isRelayMode(mode)) return;
    // 2대2에서는 자기 투수만 마운드에 올릴 수 있다.
    // (팀원이 던지는 중이어도 자기 불펜을 올리면 조작권이 넘어온다)
    if (isPartyMode(mode) && owners[pitcherId] !== myUid) return;
    const next = changePitcher(structuredClone(state), playerSide, pitcherId);
    if (next[playerSide].pitcherId === state[playerSide].pitcherId) return;
    // 투수를 바꾸면 피치 클락은 새로 감긴다 (교체하다 볼을 먹지 않도록)
    set({ state: next, pitchClockEndsAt: performance.now() + PITCH_CLOCK_MS });
    const p = next[playerSide].roster[pitcherId];
    if (p) get().pushLog(`투수 교체: ${p.name}`, 'info');
    if (mode !== 'CPU') sendFn?.({ t: 'SUB_PITCHER', side: playerSide, pitcherId });
  },

  /**
   * 대타 / 대주자 / 대수비.
   *
   * 아직 CPU·리그 전용이다 — 온라인은 protocol.ts에 SUB_* 메시지를 추가하고 호스트가
   * 검증까지 해야 하므로 다음 단계로 미뤘다. 그래서 여기서 CPU가 아니면 아무것도 하지 않는다.
   */
  substituteFielder: (kind, playerId, arg) => {
    const { state, playerSide, mode, phase } = get();
    if (!state || phase !== 'SETUP') return;
    if (mode !== 'CPU') {
      set({ message: '온라인 대전에서는 아직 야수 교체를 지원하지 않습니다.' });
      return;
    }

    const draft = structuredClone(state);
    const res =
      kind === 'HIT'
        ? pinchHit(draft, playerSide, playerId)
        : kind === 'RUN'
          ? pinchRun(draft, playerSide, arg as number, playerId)
          : subFielder(draft, playerSide, arg as Position, playerId);

    if (!res.ok) {
      set({ message: res.message });
      return;
    }
    // 교체하는 동안 피치 클락에 볼을 먹지 않도록 새로 감는다.
    set({ state: res.state, pitchClockEndsAt: performance.now() + PITCH_CLOCK_MS });
    get().pushLog(res.message, 'info');
  },

  reset: () => {
    cancelReveal();
    stopCrowd();
    set({
      state: null,
      relayState: null,
      phase: 'IDLE',
      pitchClockEndsAt: 0,
      inningBreakEndsAt: 0,
      trajectory: null,
      pitchCmd: null,
      pitchPreview: null,
      lastResult: null,
      prePitchState: null,
      timeline: null,
      revealed: true,
      revealAt: 0,
      log: [],
      stealOrders: [],
      swung: false,
      waitingRemote: false,
      message: null,
      sendFn: null,
      myUid: '',
      owners: {},
      seatNames: {},
    });
  },

  pushLog: (text, kind = 'play') =>
    set((s) => ({ log: [...s.log, { id: logId++, text, kind }].slice(-60) })),
}));

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

type SetFn = (partial: Partial<MatchStore> | ((s: MatchStore) => Partial<MatchStore>)) => void;
type GetFn = () => MatchStore;

function relayControlState(relay: RelayState, state: GameState, myUid: string) {
  const batter = currentRelayBatter(relay);
  const pitcher = currentRelayPitcher(relay);
  return {
    playerSide: (batter?.uid === myUid ? 'away' : 'home') as Side,
    owners: {
      [currentBatter(state).id]: batter?.uid ?? '',
      [currentPitcher(state).id]: pitcher?.uid ?? '',
    },
  };
}

/** 사람이 지금 공격 중인가 */
export function isPlayerBatting(s: Pick<MatchStore, 'state' | 'playerSide'>): boolean {
  if (!s.state) return false;
  const batting = s.state.half === 'TOP' ? 'away' : 'home';
  return batting === s.playerSide;
}

/** 사람이 지금 수비(투구) 중인가 */
export function isPlayerPitching(s: Pick<MatchStore, 'state' | 'playerSide'>): boolean {
  return !!s.state && !isPlayerBatting(s);
}

// --- 조작 권한 ---------------------------------------------------------------
// 2대2에서는 "내 팀 차례"가 아니라 "내 선수 차례"여야 조작할 수 있다.
// 1:1·CPU에서는 owners가 비어 있으므로 기존 동작과 같다.

type ControlSlice = Pick<MatchStore, 'state' | 'playerSide' | 'mode' | 'owners' | 'myUid'>;

/** 지금 타석에 선 선수를 내가 조작하는가 */
export function controlsBatter(s: ControlSlice): boolean {
  if (!s.state) return false;
  if (isRelayMode(s.mode)) return s.owners[currentBatter(s.state).id] === s.myUid;
  if (!isPlayerBatting(s)) return false;
  if (!usesOwnerControls(s.mode)) return true;
  return s.owners[currentBatter(s.state).id] === s.myUid;
}

/** 지금 마운드에 선 투수를 내가 조작하는가 */
export function controlsPitcher(s: ControlSlice): boolean {
  if (!s.state) return false;
  if (isRelayMode(s.mode)) return s.owners[currentPitcher(s.state).id] === s.myUid;
  if (!isPlayerPitching(s)) return false;
  if (!usesOwnerControls(s.mode)) return true;
  return s.owners[currentPitcher(s.state).id] === s.myUid;
}

/** 지금 화면을 조작 중인 사람 (2대2 관전 안내용) */
export function currentControllerUid(s: ControlSlice): string | null {
  if (!s.state || !usesOwnerControls(s.mode)) return null;
  const p = isPlayerBatting(s) ? currentBatter(s.state) : currentPitcher(s.state);
  return s.owners[p.id] ?? null;
}

/** 그 사람이 나와 같은 편(팀원)인가. 우리 편 타순에 그 사람 선수가 있으면 같은 편이다. */
export function isSameSide(s: ControlSlice, uid: string): boolean {
  if (!s.state) return false;
  return s.state[s.playerSide].lineup.some((id) => s.owners[id] === uid);
}

// --- 피치 클락 ---------------------------------------------------------------

/**
 * 지금 피치 클락이 재고 있는 쪽. null이면 시계가 돌지 않는다.
 *
 * SETUP에서 "사람이 눌러야 경기가 진행되는" 자리를 잰다.
 * - CPU전에서 사람이 타자면 대상은 공격이다. CPU 투수는 시간을 끌지 않고,
 *   대신 사람이 타석에 들어서야 투구가 시작되기 때문이다.
 * - 그 밖에는 항상 마운드(수비)가 대상이다. 온라인에서 타자는 SETUP 동안
 *   할 일이 없고 상대의 투구만 기다린다.
 */
export function pitchClockSubject(
  s: Pick<MatchStore, 'state' | 'playerSide' | 'mode' | 'phase'>,
): PitchClockViolation | null {
  if (!s.state || s.phase !== 'SETUP' || s.state.phase === 'GAME_OVER') return null;
  if (s.mode === 'CPU' && isPlayerBatting(s)) return 'OFFENSE';
  return 'DEFENSE';
}

/** 남은 시간 (ms). 시계가 돌고 있지 않으면 null. */
export function pitchClockRemaining(s: MatchStore, now: number): number | null {
  if (!s.pitchClockEndsAt || !pitchClockSubject(s)) return null;
  // 게스트가 투구 명령을 보낸 뒤로는 더 이상 그가 끄는 시간이 아니다
  if (s.waitingRemote) return null;
  return Math.max(0, s.pitchClockEndsAt - now);
}

/**
 * SETUP이 제한 시간을 넘겼는지 보고, 넘겼으면 위반을 선언한다.
 * 판정은 호스트(CPU 모드 포함)만 한다. 게스트 화면의 시계는 표시 전용이다.
 */
function tickPitchClock(set: SetFn, get: GetFn, now: number) {
  const st = get();
  const subject = pitchClockSubject(st);
  if (!subject || !st.state || !st.pitchClockEndsAt) return;
  if (!isHostMode(st.mode) || st.waitingRemote) return;
  // 온라인에서는 게스트 시계가 조금 늦게 출발하므로 그만큼 더 기다려 준다
  const grace = st.mode === 'CPU' ? 0 : PITCH_CLOCK_NET_GRACE_MS;
  if (now < st.pitchClockEndsAt + grace) return;

  if (isRelayMode(st.mode) && st.relayState) {
    const result = resolveRelayPitchClockViolation(st.state, subject);
    const relayState = applyRelayPitchResult(st.relayState, result);
    set({ relayState });
    st.sendFn?.({ t: 'RELAY_RESULT', result, state: relayState });
    applyResult(set, get, result);
    return;
  }

  const result = resolvePitchClockViolation(st.state, subject);
  if (st.mode !== 'CPU') st.sendFn?.({ t: 'RESULT', result });
  applyResult(set, get, result);
}

/**
 * 사람이 공격 중이면 CPU(또는 상대)가 투구해야 한다.
 * CPU 모드에서는 여기서 바로 CPU 투구를 시작한다.
 */
function maybeAutoPitch(set: SetFn, get: GetFn) {
  const st = get();
  if (st.mode !== 'CPU' || !st.state || st.phase !== 'SETUP') return;
  if (!isPlayerBatting(st)) return; // 사람이 투수면 UI 입력을 기다린다

  const state = st.state;
  // CPU 투수 교체 판단
  if (shouldChangePitcher(state, st.difficulty)) {
    const side: Side = state.half === 'TOP' ? 'home' : 'away';
    const cand = bullpenCandidates(state, side)[0];
    if (cand) {
      const next = changePitcher(structuredClone(state), side, cand.id);
      set({ state: next });
      get().pushLog(`${next[side].name} 투수 교체: ${cand.name}`, 'info');
    }
  }

  const cur = get().state!;
  const cmd = decidePitch(cur, aiRng, st.difficulty);
  const traj = preparePitch(cur, cmd);
  playPitchRelease(WINDUP_MS / 1000);
  set({
    pitchCmd: cmd,
    trajectory: traj,
    phase: 'FLIGHT',
    ...pitchTiming(traj, cur.settings),
    swung: false,
    swungAt: 0,
  });
}

/**
 * 궤적을 만들고 연출을 시작한다 (호스트/CPU 전용).
 * 호스트 모드면 같은 궤적을 그릴 수 있도록 PITCH_GO를 전원에게 보낸다.
 */
function startPitch(set: SetFn, get: GetFn, cmd: PitchCommand) {
  const st = get();
  const state = st.state;
  if (!state || st.phase !== 'SETUP') return;

  const traj = preparePitch(state, cmd);
  if (isRelayMode(st.mode) && st.relayState) {
    st.sendFn?.({
      t: 'RELAY_PITCH_GO',
      turnId: st.relayState.turnId,
      pitchSeq: st.relayState.pitchSeq + 1,
      cmd,
      serverTime: Date.now(),
    });
  } else if (st.mode !== 'CPU') {
    st.sendFn?.({ t: 'PITCH_GO', cmd, serverTime: Date.now() });
  }
  playPitchRelease(WINDUP_MS / 1000);
  set({
    pitchCmd: cmd,
    trajectory: traj,
    phase: 'FLIGHT',
    ...pitchTiming(traj, state.settings),
    swung: false,
    swungAt: 0,
  });
}

/**
 * 스윙 입력이 확정된 뒤 실제 판정을 수행한다 (호스트/CPU 전용).
 *
 * steal은 반드시 호출측이 넘긴다. 도루는 투구와 동시에 판정되므로
 * "공격측을 조작하는 사람이 보낸 지시"여야 하는데, 호스트 로컬의 stealOrders를
 * 쓰면 원격 타자의 지시가 통째로 무시되기 때문이다.
 */
function finalize(
  set: SetFn,
  get: GetFn,
  swing: { swing: boolean; type: SwingType; aimX: number; aimY: number; timingMs: number },
  steal: number[],
) {
  const st = get();
  const state = st.state;
  const cmd = st.pitchCmd;
  // 같은 투구를 두 번 판정하지 않는다 (지연 도착한 스윙 / 타임아웃 중복)
  if (!state || !cmd || st.phase !== 'FLIGHT') return;

  if (isRelayMode(st.mode) && st.relayState) {
    const normalizedSwing = swing.type === 'BUNT' ? { ...swing, type: 'NORMAL' as const } : swing;
    const result = resolveRelayPitch(state, cmd, normalizedSwing);
    const relayState = applyRelayPitchResult(st.relayState, result);
    set({ relayState });
    if (isHostMode(st.mode)) st.sendFn?.({ t: 'RELAY_RESULT', result, state: relayState });
    applyResult(set, get, result);
    return;
  }

  const result = resolvePitch(state, cmd, { steal, swing });
  if (st.mode !== 'CPU' && isHostMode(st.mode)) st.sendFn?.({ t: 'RESULT', result });
  applyResult(set, get, result);
}

/** CPU가 타석에 있을 때의 스윙 결정 */
function cpuSwingFor(state: GameState, traj: PitchTrajectory, difficulty: Difficulty) {
  return decideSwing(state, traj, aiRng, difficulty);
}

function applyResult(set: SetFn, get: GetFn, result: PitchResult) {
  const st = get();
  const prev = st.state;
  const next = result.state;

  // 주루 연출 타임라인. 공격팀 로스터는 플레이 시점(prev) 기준이어야 한다.
  // 이닝이 바뀌면 next의 공격/수비가 뒤바뀌기 때문이다.
  const timeline = buildTimeline(result, offense(prev ?? next).roster);
  const plan = playbackPlan(result, timeline);
  // 연출 시계는 공이 홈플레이트에 닿는 순간부터 흐른다
  const now = performance.now();
  const resultStartAt = Math.max(now, st.pitchStartAt + st.displayFlightMs);

  // 스윙 모션은 판정에 쓰인 스윙 명령만 따라간다.
  // 원격 타자의 스윙은 결과가 도착해야 알 수 있으므로 여기서 시각을 찍고,
  // 지켜본 공이면 남아 있는 모션 시각을 지워 헛스윙처럼 보이지 않게 한다.
  const motionMs = swingMotionMs(result.swing.type);
  const swungAt = !result.swing.swing
    ? 0
    : st.swungAt > 0
      ? st.swungAt
      : clamp(st.pitchStartAt + st.displayFlightMs - SWING_LEAD_MS, now - motionMs * 0.4, now);
  const soundDelay = Math.max(0, (resultStartAt - now) / 1000);
  // 결과가 공개되는 시각. 승부가 눈으로 끝나는 순간이다.
  const revealAt = resultStartAt + (timeline.revealAt / plan.rate) * 1000;
  const revealDelay = Math.max(0, (revealAt - now) / 1000);

  // --- 사운드 ---
  // 투구·타격음은 실제로 그 일이 일어나는 순간(soundDelay)에, 결과를 알려 주는
  // 소리(환호·파울 콜)는 결과가 공개되는 순간(revealDelay)에 울린다.
  if (!result.trajectory) {
    // 던지지 않은 공(피치 클락 위반). 미트 소리 없이 심판 콜만 울린다.
    playUmpireCall(result.pitchClockViolation === 'OFFENSE' ? 'strike' : 'ball');
  } else if (result.contact && result.battedBall) {
    const bb = result.battedBall;
    if (bb.kind === 'BUNT' || bb.exitVelocity < 90) playWeakContact(soundDelay);
    else playBatCrack(clamp((bb.exitVelocity - 90) / 100, 0, 1), soundDelay);
    // 파울 콜은 공이 파울 지역에 떨어진 뒤에 나온다
    if (result.kind === 'FOUL') playUmpireCall('foul', revealDelay + 0.1);
  } else if (result.swing.swing) {
    playWhiff(soundDelay);
    playMitt(result.trajectory.velocity, soundDelay);
  } else {
    playMitt(result.trajectory.velocity, soundDelay);
  }
  if (result.kind === 'BALL') playUmpireCall('ball', soundDelay + 0.1);
  if (
    result.kind === 'STRIKE_LOOKING' ||
    result.kind === 'STRIKE_SWINGING' ||
    result.kind === 'STRIKEOUT'
  ) {
    playUmpireCall('strike', soundDelay + 0.1);
  }

  // 환호는 결과가 드러난 뒤에 터진다. 배트에 맞는 순간 홈런 팡파르가 울리면
  // 공을 끝까지 볼 이유가 없어진다.
  if (result.kind === 'HOME_RUN') {
    playHomeRunCelebration(revealDelay + 0.08);
  } else if (result.kind === 'SINGLE' || result.kind === 'DOUBLE' || result.kind === 'TRIPLE') {
    const extraBases = result.kind === 'SINGLE' ? 0 : result.kind === 'DOUBLE' ? 1 : 2;
    playHitCheer(extraBases, revealDelay + 0.08);
  } else if (result.runsScored > 0) {
    playCheer(0.78, 2, revealDelay + 0.08);
  }

  set({
    state: next,
    prePitchState: prev,
    lastResult: result,
    timeline,
    resultStartAt,
    revealAt,
    revealed: false,
    swung: true,
    swungAt,
    // 원격 타자의 스윙 종류는 결과가 도착해야 알 수 있다
    swungType: result.swing.type,
    playRate: plan.rate,
    resultMs: plan.ms,
    phase: 'RESULT',
    waitingRemote: false,
  });

  // 실황 로그도 결과의 일부다. 미리 찍히면 배너를 감춘 의미가 없다.
  scheduleReveal(() => {
    set({ revealed: true });
    pushResultLog(get, result, prev, next);
  }, revealAt - performance.now());
}

/** 결과가 공개되는 순간에 남기는 실황 로그 */
function pushResultLog(
  get: GetFn,
  result: PitchResult,
  prev: GameState | null,
  next: GameState,
) {
  const push = get().pushLog;
  for (const sr of result.stealResults) {
    const name = prev ? offense(prev).roster[sr.playerId]?.name : '';
    push(
      sr.safe
        ? `${name} 도루 성공! (${sr.fromBase + 2}루)`
        : `${name} 도루 실패, 아웃!`,
      sr.safe ? 'play' : 'play',
    );
  }
  if (result.description) push(result.description, result.runsScored > 0 ? 'score' : 'play');
  if (next.phase === 'GAME_OVER') {
    const w =
      next.winner === 'TIE'
        ? '무승부'
        : `${next[next.winner as Side].name} 승리`;
    push(
      `경기 종료 — ${next.away.abbr} ${next.away.runs} : ${next.home.runs} ${next.home.abbr} (${w}${next.endedByMercy ? ', 콜드게임' : ''})`,
      'info',
    );
  }
}

/**
 * CPU가 타자일 때, 공이 미트에 닿는 시점에 맞춰 스윙 판정을 수행한다.
 * 컴포넌트의 애니메이션 루프에서 호출한다.
 */
export function cpuBatterTick(now: number) {
  const store = useMatchStore.getState();
  if (store.mode !== 'CPU') return;
  if (store.phase !== 'FLIGHT' || !store.state || !store.trajectory) return;
  if (isPlayerBatting(store)) return; // 사람이 타자면 관여하지 않는다
  if (store.swung) return;

  const elapsed = now - store.pitchStartAt;
  // 임팩트가 스윙 모션 중간에 오도록 공이 닿기 조금 전에 스윙을 시작한다.
  // decideSwing은 실제 시각을 쓰지 않으므로 판정 결과는 달라지지 않는다.
  if (elapsed < store.displayFlightMs - SWING_LEAD_MS) return;

  const swing = cpuSwingFor(store.state, store.trajectory, store.difficulty);
  // 모션은 실제로 방망이를 낸 공에만 붙인다. 지켜본 공까지 휘두르면
  // 화면은 헛스윙인데 판정은 볼/루킹 스트라이크로 나온다.
  useMatchStore.setState({
    swung: true,
    swungAt: swing.swing ? now : 0,
    swungType: swing.type,
  });
  // CPU가 타석에 있으므로 도루도 AI가 결정한다
  const steal = decideSteal(store.state, aiRng, store.difficulty);
  finalize(
    useMatchStore.setState as SetFn,
    useMatchStore.getState as GetFn,
    swing,
    steal,
  );
}

/**
 * 호스트가 원격 수비측의 투구 명령을 받았을 때.
 * 보낸 사람이 그 투수의 주인인지는 호출측(방 페이지)에서 확인한다.
 */
export function hostStartPitch(cmd: PitchCommand) {
  startPitch(useMatchStore.setState as SetFn, useMatchStore.getState as GetFn, cmd);
}

/**
 * 호스트가 원격 공격측의 입력을 받았을 때.
 * 도루 지시도 같은 메시지로 함께 온다.
 */
export function hostResolveWithSwing(
  swing: {
    swing: boolean;
    type: SwingType;
    aimX: number;
    aimY: number;
    timingMs: number;
  },
  steal: number[] = [],
) {
  finalize(useMatchStore.setState as SetFn, useMatchStore.getState as GetFn, swing, steal);
}

// 편의 셀렉터 -----------------------------------------------------------------

/**
 * HUD(스코어보드·카운트·타자 정보)가 그릴 상태.
 *
 * 결과가 공개되기 전에는 투구 직전 상태를 쓴다. 아웃 카운트나 점수가 먼저
 * 올라가면 타구를 보기도 전에 답을 알려 주는 셈이기 때문이다.
 * 3D 화면(sceneState)이 연출 내내 투구 직전 상태를 쓰는 것과 같은 이유다.
 */
export function selectHudState(s: MatchStore): GameState | null {
  if (s.phase === 'RESULT' && !s.revealed) return s.prePitchState ?? s.state;
  return s.state;
}

export function selectBatter(s: MatchStore): Player | null {
  return s.state ? currentBatter(s.state) : null;
}
export function selectPitcher(s: MatchStore): Player | null {
  return s.state ? currentPitcher(s.state) : null;
}
export function selectCatcher(s: MatchStore): Player | null {
  return s.state ? (currentCatcher(s.state) ?? null) : null;
}
export function selectArsenal(s: MatchStore) {
  const p = s.state ? currentPitcher(s.state) : null;
  return p ? arsenalOf(p) : [];
}
export function selectDefenseTeam(s: MatchStore) {
  return s.state ? defenseTeam(s.state) : null;
}
export function selectOffenseTeam(s: MatchStore) {
  return s.state ? offense(s.state) : null;
}
