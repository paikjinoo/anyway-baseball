import { Rng, clamp, lerp, norm } from './rng';
import { AIM_LIMIT, PITCH_DEFS } from './constants';
import { arsenalOf, staminaRemaining } from './pitching';
import { effectiveBatSide, effectiveBatting } from './batting';
import {
  currentBatter,
  currentPitcher,
  defenseTeam,
  offense,
} from './engine';
import type {
  GameState,
  OffenseCommand,
  PitchCommand,
  PitchTrajectory,
  Player,
  SwingCommand,
  SwingType,
} from './types';
import { effSpeed } from './batting';

export type Difficulty = 'EASY' | 'NORMAL' | 'HARD' | 'PRO';

interface DiffParams {
  /** 타자가 공 위치를 읽는 정확도. 낮을수록 잘 읽는다. */
  readNoise: number;
  /** 스윙 타이밍 오차 (ms) */
  timingNoise: number;
  /** 조준 오차 */
  aimNoise: number;
  /** 나쁜 공에 손대는 비율 */
  chaseRate: number;
  /** 투수의 제구 목표 선정 품질 */
  pitchIq: number;
}

const DIFF: Record<Difficulty, DiffParams> = {
  EASY: { readNoise: 0.62, timingNoise: 95, aimNoise: 0.46, chaseRate: 0.42, pitchIq: 0.35 },
  NORMAL: { readNoise: 0.4, timingNoise: 62, aimNoise: 0.3, chaseRate: 0.3, pitchIq: 0.6 },
  HARD: { readNoise: 0.25, timingNoise: 40, aimNoise: 0.2, chaseRate: 0.22, pitchIq: 0.82 },
  PRO: { readNoise: 0.16, timingNoise: 27, aimNoise: 0.13, chaseRate: 0.15, pitchIq: 0.95 },
};

// ---------------------------------------------------------------------------
// CPU 투수
// ---------------------------------------------------------------------------

/**
 * 퀵모션(슬라이드 스텝)을 섞는 비율 — 1루 주자의 발에 비례한다.
 *
 * 퀵모션은 수비 시간을 3.30 -> 3.03초로 0.27초 줄인다. 이 게임에서 뛸 만한 주자의 주파
 * 시간이 3.0~3.2초라 **0.27초가 승패를 그대로 뒤집는다.** 대가는 제구 산포 ×1.35
 * (pitching.ts)이고, 그 대가는 도루와 무관하게 볼넷으로 청구된다.
 *
 * **주자가 누구든 같은 비율로 섞으면 안 된다.** 예전에는 그랬고(고정 0.55), 그래서 3 시드셋
 * 평균으로 이런 손해를 봤다:
 *
 *   고정 0.55 -> 도루 성공률 69.8% · 볼넷 2.66 · 득점 4.26
 *   고정 0.30 -> 도루 성공률 76.0% · 볼넷 2.40 · 득점 3.96
 *
 * 즉 고정값으로는 도루 성공률과 볼넷을 맞바꿀 수밖에 없다. 하지만 실제 투수는 발 느린
 * 주자에게 슬라이드 스텝을 쓰지 않는다 — 제구만 잃고 막을 게 없기 때문이다. 1루를 밟는
 * 주자의 77%는 애초에 뛰지 않으므로(speed 60 미만), 그들에게 쓰던 퀵모션은 순수 낭비였다.
 *
 * 그래서 빈도를 주자 speed에 걸었다. 실제로 뛰는 주자(speed 65~85)는 예전과 비슷한 30~40%를
 * 마주하고, 뛰지 않는 주자에게는 하한만 쓴다.
 *
 * ⚠ **이 값은 볼넷 손잡이이기도 하다.** 퀵모션은 제구 산포를 ×1.35 하므로 퀵모션이 많을수록
 * 볼넷이 늘어난다 — 도루와 아무 상관 없는 부작용이다. 옛 고정 0.55는 공 비행 중복만 상쇄한
 * 게 아니라 **볼넷도 떠받치고 있었고**, 그걸 걷어내자 볼넷이 2.66 -> 2.24로 떨어졌다.
 * 하한 0.2는 그중 일부(2.36)를 되돌린 절충이다. 느린 주자에게도 타이밍을 뺏으려 가끔 빠르게
 * 던지는 건 실제로 있는 일이라 물리적으로도 무리가 없다.
 *
 * 볼넷을 여기서 더 끌어올리려 하지 말 것. 그건 도루 상수로 볼넷을 맞추는 짓이고, 방금 걷어낸
 * 바로 그 패턴이다. 볼넷의 진짜 손잡이는 아래 `edge`(존 안쪽을 얼마나 깊이 노리는가)이며,
 * 그건 존 투구 비율(48.3%)과 묶여 있어 함께 재보정해야 한다.
 */
const QUICK_PITCH_MIN = 0.2;
const QUICK_PITCH_MAX = 0.4;
/** 이 속도(정규화) 아래는 위협이 아니고, 위로 QUICK_PITCH_SPEED_SPAN만큼에서 최대치에 닿는다. */
const QUICK_PITCH_SPEED_FLOOR = 0.45;
const QUICK_PITCH_SPEED_SPAN = 0.35;

function quickPitchRate(state: GameState): number {
  const r = state.bases[0];
  if (!r) return 0;
  const p = offense(state).roster[r.playerId];
  if (!p) return QUICK_PITCH_MIN;
  const t = clamp((norm(effSpeed(p)) - QUICK_PITCH_SPEED_FLOOR) / QUICK_PITCH_SPEED_SPAN, 0, 1);
  return lerp(QUICK_PITCH_MIN, QUICK_PITCH_MAX, t);
}

/**
 * 구종과 코스를 고른다.
 *
 *  - 카운트가 불리하면(볼이 많으면) 제구가 좋은 구종으로 존 안쪽을 노린다.
 *  - 유리하면(스트라이크가 많으면) 무브먼트가 큰 구종으로 존 경계/바깥을 노려 헛스윙을 유도한다.
 *  - 주자가 있으면 퀵모션을 섞는다.
 */
export function decidePitch(state: GameState, rng: Rng, difficulty: Difficulty): PitchCommand {
  const p = DIFF[difficulty];
  const pitcher = currentPitcher(state);
  const batter = currentBatter(state);
  const arsenal = arsenalOf(pitcher);
  const def = defenseTeam(state);

  const behind = state.balls - state.strikes; // 양수면 투수가 불리
  const twoStrikes = state.strikes === 2;
  const threeBalls = state.balls === 3;
  const fatigue = 1 - staminaRemaining(pitcher, def.pitcherPitches);

  // ---- 구종 선택 --------------------------------------------------------
  const scored = arsenal.map((a) => {
    const ctrl = norm(a.attr.control);
    const move = norm(a.attr.movement);
    const velo = norm(a.attr.velocity);
    let score = ctrl * 0.9 + move * 0.7 + velo * 0.6;
    if (threeBalls) score += ctrl * 1.6; // 반드시 스트라이크
    if (twoStrikes) score += move * 1.3; // 결정구
    if (behind > 0) score += ctrl * 0.8;
    // 피로하면 직구 비중 상승
    if (a.type === 'FOURSEAM') score += fatigue * 0.5;
    return { a, score };
  });
  // 최고 점수만 고르면 능력치가 가장 좋은 직구가 8할 가까이 나와
  // 매 타석 같은 공만 보게 된다. 점수에 비례한 확률로 뽑아 배합을 만든다.
  // temp가 작을수록 결정적이므로, 난이도가 높을수록 좋은 구종에 집중한다.
  const chosen = weightedPick(rng, scored, lerp(0.62, 0.22, p.pitchIq));

  // ---- 코스 선택 --------------------------------------------------------
  const eb = effectiveBatting(batter);
  // 선구안이 좋은 타자에게는 존 안으로, 나쁜 타자에게는 유인구
  const batterEye = norm(eb.eye);
  const batterPower = norm(eb.power);

  let targetX: number;
  let targetY: number;

  if (threeBalls) {
    // 스트라이크 필수. 존 한가운데보다 살짝 낮게.
    targetX = rng.range(-0.35, 0.35);
    targetY = rng.range(-0.4, 0.15);
  } else if (twoStrikes && !threeBalls) {
    // 유인구: 존 경계 밖으로
    const chaseAttempt = rng.chance(clamp(0.7 - batterEye * 0.35, 0.25, 0.8));
    if (chaseAttempt) {
      const def2 = PITCH_DEFS[chosen.type];
      // 떨어지는 구종은 아래로, 횡변화 구종은 바깥쪽으로
      if (def2.chaseLow) {
        targetX = rng.range(-0.5, 0.5);
        targetY = rng.range(-1.35, -0.85);
      } else {
        // 바깥쪽은 타자가 실제로 선 쪽 기준이다 (스위치히터는 투수에 따라 바뀐다)
        const outside = effectiveBatSide(batter, pitcher) === 'L' ? -1 : 1;
        targetX = outside * rng.range(0.85, 1.3);
        targetY = rng.range(-0.6, 0.4);
      }
    } else {
      targetX = rng.range(-0.75, 0.75);
      targetY = rng.range(-0.75, 0.55);
    }
  } else {
    // 일반 카운트: 존 모서리
    const cornerX = rng.chance(0.5) ? 1 : -1;
    const cornerY = rng.chance(0.55) ? -1 : 1;
    // 존 안쪽 깊숙이 노리면 스트라이크 비율이 올라가 볼넷이 마른다.
    // MLB 존 투구 비율은 48.5%다.
    const edge = lerp(0.55, 1.02, p.pitchIq);
    targetX = cornerX * rng.range(edge * 0.6, edge);
    targetY = cornerY * rng.range(edge * 0.5, edge);
    // 장타력 있는 타자에게는 더 낮게
    if (batterPower > 0.7) targetY = Math.min(targetY, -0.2);
  }

  // 제구가 나쁜 구종일수록 목표를 존 안쪽으로 당겨 잡는다 (안전 마진).
  // 변화구 비중이 늘어난 만큼 이 보정이 없으면 볼넷이 늘어난다.
  const ctrlStat = norm(chosen.attr.control);
  const margin = clamp(0.58 + ctrlStat * 0.56, 0.58, 1);
  targetX *= margin;
  targetY *= margin;

  const runnersOn = state.bases.some(Boolean);
  const stealThreat = state.bases[0] !== null && !state.bases[1];

  return {
    type: chosen.type,
    targetX: clamp(targetX, -1.7, 1.7),
    targetY: clamp(targetY, -1.7, 1.7),
    quickPitch: runnersOn && stealThreat && rng.chance(quickPitchRate(state)),
  };
}

/**
 * 점수에 비례한 확률로 하나를 고른다 (소프트맥스).
 * temp가 0에 가까우면 최고 점수만, 크면 고르게 섞인다.
 */
function weightedPick<T>(rng: Rng, items: { a: T; score: number }[], temp: number): T {
  if (items.length === 1) return items[0].a;
  const top = Math.max(...items.map((i) => i.score));
  const weights = items.map((i) => Math.exp((i.score - top) / Math.max(0.05, temp)));
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i].a;
  }
  return items[items.length - 1].a;
}

/** CPU 투수 교체 판단 */
export function shouldChangePitcher(state: GameState, difficulty: Difficulty): boolean {
  const side = state.half === 'TOP' ? 'home' : 'away';
  const t = state[side];
  const p = t.roster[t.pitcherId];
  if (!p) return false;
  const remaining = staminaRemaining(p, t.pitcherPitches);
  const threshold = difficulty === 'EASY' ? 0.05 : difficulty === 'NORMAL' ? 0.12 : 0.2;
  return remaining < threshold;
}

// ---------------------------------------------------------------------------
// CPU 타자
// ---------------------------------------------------------------------------

/**
 * 투구를 보고 스윙 여부/조준/타이밍을 정한다.
 *
 * CPU는 실제 도착 지점을 "노이즈가 섞인 추정치"로 인식한다.
 * 노이즈는 난이도와 타자의 선구안에 반비례한다.
 */
export function decideSwing(
  state: GameState,
  traj: PitchTrajectory,
  rng: Rng,
  difficulty: Difficulty,
): SwingCommand {
  const p = DIFF[difficulty];
  const batter = currentBatter(state);
  const eb = effectiveBatting(batter);
  const eye = norm(eb.eye);
  const contact = norm(eb.contact);
  const power = norm(eb.power);

  // 추정 위치
  const noise = p.readNoise * (1.25 - eye * 0.55);
  const estX = traj.zoneX + rng.normal(0, noise);
  const estY = traj.zoneY + rng.normal(0, noise);
  const estInZone = Math.abs(estX) <= 1 && Math.abs(estY) <= 1;

  const twoStrikes = state.strikes === 2;
  const threeBalls = state.balls === 3;

  // ---- 스윙 여부 --------------------------------------------------------
  let swingP: number;
  if (estInZone) {
    swingP = twoStrikes ? 0.97 : threeBalls ? 0.55 : 0.78;
  } else {
    const howFar = Math.max(Math.abs(estX), Math.abs(estY)) - 1;
    swingP = clamp(p.chaseRate * (1 - eye * 0.5) * (1 - howFar), 0.02, 0.6);
    if (twoStrikes) swingP = clamp(swingP + 0.42, 0, 0.9); // 커트해야 한다
    if (threeBalls && !twoStrikes) swingP *= 0.3;
  }

  const willSwing = rng.chance(swingP);

  // ---- 번트 판단 --------------------------------------------------------
  const outs = state.outs;
  const runnerOn1 = !!state.bases[0];
  const runnerOn2 = !!state.bases[1];
  const closeGame = Math.abs(state.away.runs - state.home.runs) <= 2;
  const lateInning = state.inning >= state.settings.regulationInnings - 2;
  const weakHitter = norm(eb.power) < 0.35 && norm(eb.contact) < 0.5;
  const buntSituation =
    outs < 2 && (runnerOn1 || runnerOn2) && !twoStrikes && closeGame && (weakHitter || lateInning);

  let type: SwingType = 'NORMAL';
  if (buntSituation && rng.chance(0.28)) {
    type = 'BUNT';
  } else if (!twoStrikes && power > 0.6 && estInZone && rng.chance(0.3 + power * 0.25)) {
    type = 'POWER';
  }

  if (!willSwing) {
    return { swing: false, type, aimX: estX, aimY: estY, timingMs: 0 };
  }

  // ---- 조준/타이밍 ------------------------------------------------------
  const aimNoise = p.aimNoise * (1.3 - contact * 0.6);
  const aimX = clamp(estX + rng.normal(0, aimNoise), -AIM_LIMIT, AIM_LIMIT);
  const aimY = clamp(estY + rng.normal(0, aimNoise), -AIM_LIMIT, AIM_LIMIT);

  // 느린 변화구는 CPU도 타이밍을 뺏긴다
  const def = PITCH_DEFS[traj.type];
  const timingBias = def.baseVelo < 120 ? rng.range(-40, 10) : 0;
  const timingNoise = p.timingNoise * (1.25 - contact * 0.5);
  const timingMs = rng.normal(timingBias, timingNoise);

  return { swing: true, type, aimX, aimY, timingMs };
}

// ---------------------------------------------------------------------------
// CPU 주루 (도루 명령)
// ---------------------------------------------------------------------------

/**
 * 도루를 시도할 만한 발의 기준선 (정규화 speed). 속도 약 60.
 *
 * **이 값은 취향이 아니라 물리에서 나온다.** baserunning.resolveSteals는 주자의 주파 시간과
 * (투수 릴리스 + 공 비행 + 포수 팝타임)을 재는 경주다. 180경기 강제 도루 실측에서 성공률이
 * 속도 40대 10% · 50대 28% · 60대 56% · 70대 84% · 80대 94%로 갈린다.
 *
 * 손익분기는 취향이 아니라 계산이다. 도루 성공은 약 +0.19점, 실패는 약 -0.42점이므로
 * 0.42/(0.19+0.42) = **69%**가 뛰나 마나인 지점이고, 그게 speed 65~70 구간이다. 그보다 느린
 * 주자를 뛰게 하면 도루가 늘어나는 게 아니라 **아웃이 늘어난다.**
 */
const STEAL_SPEED_FLOOR = 0.61;
/**
 * 기준선 위로 발이 빠른 만큼 시도 확률이 붙는 기울기.
 *
 * 기준선만 손익분기로 올리면 시도 자체가 말라버린다. 올린 만큼 기울기를 세워서, 자격이
 * 되는 주자가 **더 자주** 뛰게 만들어 시도 수를 되찾는다. 실제 야구도 그렇다 — 뛸 줄 아는
 * 주자가 자주 뛰는 것이지, 아무나 가끔 뛰는 게 아니다.
 */
const STEAL_SPEED_SLOPE = 4.6;
/**
 * 아무리 빨라도 한 투구에 이 확률을 넘지 않는다. 매 공 뛰는 그림을 막는 상한이다.
 * 속도 76부터 걸린다 (노멀 난이도에서 실제 58%).
 *
 * 상한을 올리는 건 성공률을 거의 해치지 않는다 — 여기 걸리는 건 84%로 성공하는 주자들뿐이라,
 * 시도 수를 되찾는 손잡이 중 값이 가장 싸다. 반대로 기준선을 내려 시도를 늘리면 60% 짜리
 * 주자가 섞여 성공률이 그대로 깎인다.
 */
const STEAL_CHANCE_CAP = 0.72;

/**
 * 3루 도루 기준선. 포수 송구가 짧아 성공률 자체는 나쁘지 않지만, 실패하면 득점권 주자를
 * 통째로 날리므로 실제 야구에서도 훨씬 드물다. 발이 확실히 빠를 때만 간다.
 */
const STEAL3_SPEED_FLOOR = 0.62;
const STEAL3_SPEED_SLOPE = 0.6;
const STEAL3_CHANCE_CAP = 0.06;

export function decideSteal(state: GameState, rng: Rng, difficulty: Difficulty): number[] {
  const off = offense(state);
  const steals: number[] = [];
  const aggression = difficulty === 'EASY' ? 0.5 : difficulty === 'NORMAL' ? 0.8 : 1.1;

  // 1루 주자 -> 2루
  const r1 = state.bases[0];
  if (r1 && !state.bases[1]) {
    const p = off.roster[r1.playerId];
    if (p) {
      const speed = norm(effSpeed(p));
      let chance =
        clamp((speed - STEAL_SPEED_FLOOR) * STEAL_SPEED_SLOPE, 0, STEAL_CHANCE_CAP) * aggression;
      if (state.strikes === 2) chance *= 0.5;
      if (state.outs === 2) chance *= 0.7;
      if (state.balls === 3) chance *= 0.4;
      if (rng.chance(chance)) steals.push(0);
    }
  }

  // 2루 주자 -> 3루 (아웃 카운트 0~1일 때만)
  const r2 = state.bases[1];
  if (r2 && !state.bases[2] && state.outs < 2 && !steals.length) {
    const p = off.roster[r2.playerId];
    if (p) {
      const speed = norm(effSpeed(p));
      const chance =
        clamp((speed - STEAL3_SPEED_FLOOR) * STEAL3_SPEED_SLOPE, 0, STEAL3_CHANCE_CAP) * aggression;
      if (rng.chance(chance)) steals.push(1);
    }
  }

  return steals;
}

/** CPU의 한 투구 전체 결정 */
export function cpuOffenseCommand(
  state: GameState,
  traj: PitchTrajectory,
  rng: Rng,
  difficulty: Difficulty,
): OffenseCommand {
  return {
    steal: decideSteal(state, rng, difficulty),
    swing: decideSwing(state, traj, rng, difficulty),
  };
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EASY: '이지',
  NORMAL: '노멀',
  HARD: '하드',
  PRO: '프로',
};
