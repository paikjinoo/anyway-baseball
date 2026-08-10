import { Rng, clamp, lerp, norm } from './rng';
import { PITCH_DEFS } from './constants';
import { arsenalOf, staminaRemaining } from './pitching';
import { effectiveBatting } from './batting';
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
        const outside = batter.bats === 'L' ? -1 : 1;
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
    quickPitch: runnersOn && stealThreat && rng.chance(0.55),
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
  const aimX = clamp(estX + rng.normal(0, aimNoise), -1.9, 1.9);
  const aimY = clamp(estY + rng.normal(0, aimNoise), -1.9, 1.9);

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
      // 실제 야구에서 도루 시도는 기회당 5~10% 수준이다.
      // 이 값이 크면 CPU가 매 투구마다 뛰어 득점이 비현실적으로 늘어난다.
      let chance = clamp((speed - 0.62) * 0.5, 0, 0.16) * aggression;
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
      const chance = clamp((speed - 0.78) * 0.35, 0, 0.08) * aggression;
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
