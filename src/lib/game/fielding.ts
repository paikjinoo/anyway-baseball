import { Rng, clamp, lerp, norm } from './rng';
import { BASE_COORDS, DEFENSE_SPOTS, GLOVE_DEFS, fenceDistance } from './constants';
import type { BattedBall, FieldPlay, Player, Position, Vec3 } from './types';

const INFIELD: Position[] = ['P', 'C', '1B', '2B', '3B', 'SS'];
const OUTFIELD: Position[] = ['LF', 'CF', 'RF'];

function dist2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 야수의 이동 속도 (m/s). 스피드 + 수비 능력치. */
function rangeSpeed(p: Player): number {
  const s = norm(p.batting.speed);
  const f = norm(p.batting.fielding);
  return lerp(6.2, 9.0, s * 0.6 + f * 0.4);
}

/**
 * 타구 판단 후 첫 발을 떼기까지 걸리는 시간 (s).
 *
 * 내야수는 투구마다 크리프 스텝으로 이미 체중을 옮기고 있어 첫 발이 훨씬 빠르다.
 * 외야수는 타구를 조금 더 보고 판단한다.
 */
function reactionTime(p: Player, pos?: Position): number {
  const f = norm(p.batting.fielding);
  if (pos && OUTFIELD.includes(pos)) return lerp(0.43, 0.13, f);
  return lerp(0.32, 0.14, f);
}

/**
 * 몸이 닿지 않아도 처리할 수 있는 반경 (m).
 * 야수는 공이 있는 자리에 몸을 세울 필요가 없고, 글러브를 뻗거나 다이빙해
 * 이만큼을 더 커버한다. 이 값이 없으면 타구선에 몸을 정확히 갖다 놓아야만
 * 아웃이 되어 내야 안타가 폭증한다.
 */
const GLOVE_REACH = 1.6;

/**
 * 정지 상태에서 거리 d(m)를 이동하는 데 걸리는 시간 (s).
 *
 * 단순히 d/최고속도로 계산하면 짧은 거리에서 야수가 순간이동하는 셈이 되어
 * 내야 수비 범위가 비현실적으로 넓어진다(모든 땅볼이 아웃이 된다).
 * 실제로는 가속 구간이 지배적이므로 등가속 모델을 쓴다.
 */
function travelTime(p: Player, d: number): number {
  if (d <= 0) return 0;
  const vmax = rangeSpeed(p);
  const a = 4.9 + norm(p.batting.speed) * 2.1; // 4.9 ~ 7.0 m/s^2
  const dAcc = (vmax * vmax) / (2 * a);
  if (d <= dAcc) return Math.sqrt((2 * d) / a);
  return vmax / a + (d - dAcc) / vmax;
}

/** 송구 속도 (m/s) */
function throwSpeed(p: Player): number {
  return lerp(24, 44, norm(p.batting.arm));
}

/** 포구 후 송구 동작까지 (s) */
function transferTime(p: Player): number {
  return lerp(0.95, 0.5, norm(p.batting.fielding));
}

/** 장비 보정 포함 실효 수비 능력 */
function effFielding(p: Player): number {
  const g = GLOVE_DEFS.find((x) => x.id === p.gear.glove);
  return clamp(p.batting.fielding + (g?.fieldMod ?? 0), 1, 99);
}

export type { FieldPlay };

export interface DefenseMap {
  /** position -> Player */
  players: Partial<Record<Position, Player>>;
}

/**
 * 타구를 어느 야수가, 언제 처리하는지 계산한다.
 *
 * - 뜬공/라인드라이브: 낙구 지점까지 도달 시간 <= 체공 시간이면 포구
 * - 땅볼: 타구가 굴러가는 경로에서 야수가 가로챌 수 있는 최단 시점을 찾는다
 * - 담장을 넘으면 홈런
 */
export function resolveFielding(
  rng: Rng,
  bb: BattedBall,
  defense: DefenseMap,
  outs: number,
  runnersOn: boolean[],
): FieldPlay {
  const theta = Math.atan2(bb.landing.x, bb.landing.z);
  const foul = Math.abs(bb.sprayAngle) > 45;

  const base: FieldPlay = {
    primary: 'CF',
    caught: false,
    error: false,
    homeRun: false,
    fenceHit: false,
    foul,
    foulCaught: false,
    secureTime: bb.hangTime + 1,
    securePoint: bb.landing,
    throwSpeed: 32,
    transferTime: 0.7,
    infield: false,
    throughInfield: false,
    infieldFly: false,
  };

  // ---- 담장 판정 --------------------------------------------------------
  // simulateFlight가 통과 시점의 높이로 이미 판정해 두었다.
  if (!foul && bb.overFence) {
    return { ...base, homeRun: true, primary: nearestOutfielder(bb.landing, defense) };
  }
  if (!foul && bb.hitFence) {
    return {
      ...base,
      fenceHit: true,
      primary: nearestOutfielder(bb.landing, defense),
      secureTime: bb.hangTime + rng.range(1.1, 2.0),
      securePoint: bb.landing,
    };
  }

  // ---- 파울 타구 --------------------------------------------------------
  if (foul) {
    // 파울 플라이는 뜬공이고 관중석까지 가지 않았을 때만 잡을 수 있다
    if (bb.launchAngle > 30 && bb.distance < 60 && bb.hangTime > 2.2) {
      const cand = nearestFielderTo(bb.landing, defense, [...INFIELD, ...OUTFIELD]);
      if (cand) {
        const p = defense.players[cand]!;
        const reach = reactionTime(p, cand) + travelTime(p, dist2d(DEFENSE_SPOTS[cand], bb.landing));
        // 파울 지역은 난이도가 높다
        if (reach <= bb.hangTime * 0.94 && rng.chance(0.55 + norm(effFielding(p)) * 0.35)) {
          return { ...base, primary: cand, caught: true, foulCaught: true, secureTime: bb.hangTime };
        }
      }
    }
    return { ...base, foul: true };
  }

  // ---- 인필드 플라이 ----------------------------------------------------
  const infieldFly =
    bb.launchAngle > 45 &&
    bb.distance < 62 &&
    outs < 2 &&
    ((runnersOn[0] && runnersOn[1]) || (runnersOn[0] && runnersOn[1] && runnersOn[2]));

  // ---- 뜬공 / 라인드라이브 ----------------------------------------------
  if (bb.launchAngle > 8 && bb.landing.y <= 0.5) {
    const cand = bestCatcher(rng, bb, defense);
    if (cand) {
      const { pos, reachTime, player } = cand;
      const margin = bb.hangTime - reachTime;
      if (margin >= 0) {
        // 여유가 적을수록 포구 실패 확률 증가
        const diff = clamp(1 - margin / 1.4, 0, 1);
        const catchP = clamp(0.998 - diff * 0.2 + norm(effFielding(player)) * 0.1, 0.6, 0.999);
        if (rng.chance(catchP)) {
          return {
            ...base,
            primary: pos,
            caught: true,
            secureTime: bb.hangTime,
            securePoint: bb.landing,
            throwSpeed: throwSpeed(player),
            transferTime: transferTime(player),
            infield: INFIELD.includes(pos),
            infieldFly,
          };
        }
        // 落球 = 실책
        return {
          ...base,
          primary: pos,
          error: true,
          secureTime: bb.hangTime + rng.range(0.8, 1.8),
          securePoint: bb.landing,
          throwSpeed: throwSpeed(player),
          transferTime: transferTime(player),
          infield: INFIELD.includes(pos),
          infieldFly,
        };
      }
      // 못 잡음 -> 안타. 낙구 후 달려가 잡는 시간
      const chase = reachTime - bb.hangTime;
      const p = defense.players[pos]!;
      return {
        ...base,
        primary: pos,
        // 낙구 후 실제로 뛰어가 잡는 시간. 여기를 짧게 잡으면 갭 타구가
        // 전부 단타로 처리되어 2·3루타가 사라진다.
        secureTime: bb.hangTime + Math.max(0.4, chase * 0.95) + rng.range(0.15, 0.5),
        securePoint: bb.landing,
        throwSpeed: throwSpeed(p),
        transferTime: transferTime(p),
        infield: INFIELD.includes(pos),
        throughInfield: !INFIELD.includes(pos),
        infieldFly,
      };
    }
  }

  // ---- 땅볼 ------------------------------------------------------------
  return resolveGrounder(rng, bb, defense);
}

/** 낙구 지점에 가장 빨리 도달할 수 있는 야수 */
function bestCatcher(rng: Rng, bb: BattedBall, defense: DefenseMap) {
  let best: { pos: Position; reachTime: number; player: Player } | null = null;
  const positions = [...INFIELD, ...OUTFIELD] as Position[];
  for (const pos of positions) {
    const p = defense.players[pos];
    if (!p) continue;
    if (pos === 'C' && bb.distance > 25) continue;
    if (pos === 'P' && bb.distance > 32) continue;
    const d = dist2d(DEFENSE_SPOTS[pos], bb.landing);
    // 뒤로 물러나는 타구는 느리다
    const backward = bb.distance > Math.hypot(DEFENSE_SPOTS[pos].x, DEFENSE_SPOTS[pos].z);
    // 외야수는 타구가 뜬 직후부터 낙구 지점을 향해 최단 경로로 움직인다.
    // (루트 효율 + 타자에 맞춘 사전 시프트) 이를 실효 이동거리 감소로 근사한다.
    const route = OUTFIELD.includes(pos) ? 0.86 : 1.0;
    const t = reactionTime(p, pos) + travelTime(p, (d * route) / (backward ? 0.88 : 1.0));
    if (!best || t < best.reachTime) best = { pos, reachTime: t, player: p };
  }
  return best;
}

function nearestOutfielder(point: Vec3, defense: DefenseMap): Position {
  return nearestFielderTo(point, defense, OUTFIELD) ?? 'CF';
}

function nearestFielderTo(point: Vec3, defense: DefenseMap, pool: Position[]): Position | null {
  let best: Position | null = null;
  let bd = Infinity;
  for (const pos of pool) {
    if (!defense.players[pos]) continue;
    const d = dist2d(DEFENSE_SPOTS[pos], point);
    if (d < bd) {
      bd = d;
      best = pos;
    }
  }
  return best;
}

/**
 * 땅볼 처리.
 * 타구가 굴러가는 경로를 시간축으로 이산화하고, 각 시점에서
 * 어떤 야수가 이미 그 지점에 도달해 있는지를 검사한다.
 *
 * 공은 **착지한 자리에서부터** 구른다. 예전에는 홈플레이트(travelled=0)에서
 * 굴리기 시작했는데, 그러면 타구가 공중에서 간 거리가 통째로 사라져서
 * 야수가 이미 자기 머리 위를 넘어간 공을 처리하는 것으로 계산됐다
 * (외야 깊숙이 떨어진 낮은 직선타를 투수가 잡는 식).
 */
function resolveGrounder(rng: Rng, bb: BattedBall, defense: DefenseMap): FieldPlay {
  // 월드 +X는 3루 방향이므로 sprayAngle(+ = 우익)의 x 부호를 뒤집는다
  const dir = { x: -Math.sin((bb.sprayAngle * Math.PI) / 180), z: Math.cos((bb.sprayAngle * Math.PI) / 180) };
  // 지면 마찰: 첫 바운드에서 수평 속도의 약 30%가 깎이고 이후 감속.
  // 착지 속도를 알 수 없는 구버전 데이터는 타구 속도에서 근사한다.
  const impact = bb.landingVel
    ? Math.hypot(bb.landingVel.x, bb.landingVel.z)
    : (bb.exitVelocity / 3.6) * 0.95;
  let speed = impact * (bb.kind === 'BUNT' ? 0.45 : 0.7);
  let travelled = bb.distance;
  let t = Math.max(0.05, bb.hangTime);
  const dt = 0.04;

  const positions = [...INFIELD, ...OUTFIELD] as Position[];

  while (t < 8 && travelled < 130) {
    speed = Math.max(2.4, speed - 4.4 * dt);
    travelled += speed * dt;
    t += dt;
    const point: Vec3 = { x: dir.x * travelled, y: 0, z: dir.z * travelled };

    for (const pos of positions) {
      const p = defense.players[pos];
      if (!p) continue;
      const d = dist2d(DEFENSE_SPOTS[pos], point);
      const reach = reactionTime(p, pos) + travelTime(p, Math.max(0, d - GLOVE_REACH));
      if (reach <= t) {
        // 이 야수가 이 지점에 도달 가능 -> 처리
        const hard = clamp((bb.exitVelocity - 130) / 80, 0, 1); // 강습 타구는 어렵다
        const errP = clamp(0.022 + hard * 0.055 - norm(effFielding(p)) * 0.045, 0.003, 0.075);
        const isError = rng.chance(errP);
        // 정위치에서 멀리 이동해 잡을수록 자세가 무너져 포구/송구가 늦어진다.
        // 이 페널티가 없으면 내야가 모든 땅볼을 아웃으로 만들어 내야안타가 사라진다.
        const covered = dist2d(DEFENSE_SPOTS[pos], point);
        const rangePenalty = clamp((covered - 2.5) * 0.055, 0, 0.6);
        return {
          primary: pos,
          caught: false,
          error: isError,
          homeRun: false,
          fenceHit: false,
          foul: false,
          foulCaught: false,
          secureTime: t + rangePenalty + (isError ? rng.range(1.0, 2.2) : 0),
          securePoint: point,
          throwSpeed: throwSpeed(p),
          transferTime: transferTime(p) + rangePenalty * 0.4,
          infield: INFIELD.includes(pos),
          throughInfield: !INFIELD.includes(pos),
          infieldFly: false,
        };
      }
    }
  }

  // 아무도 못 잡음 -> 외야 끝까지 굴러감
  const point: Vec3 = { x: dir.x * travelled, y: 0, z: dir.z * travelled };
  const pos = nearestOutfielder(point, defense);
  const p = defense.players[pos]!;
  return {
    primary: pos,
    caught: false,
    error: false,
    homeRun: false,
    fenceHit: false,
    foul: false,
    foulCaught: false,
    secureTime: t + 0.6,
    securePoint: point,
    throwSpeed: p ? throwSpeed(p) : 32,
    transferTime: p ? transferTime(p) : 0.7,
    infield: false,
    throughInfield: true,
    infieldFly: false,
  };
}

/**
 * 확보 지점에서 특정 베이스로 송구가 도달하는 시각.
 * 거리가 멀면 중계 플레이가 끼어 추가 시간이 든다.
 */
export function throwArrivalTime(play: FieldPlay, baseIndex: number): number {
  const target = BASE_COORDS[baseIndex];
  const d = Math.hypot(play.securePoint.x - target.x, play.securePoint.z - target.z);
  let time = play.secureTime + play.transferTime + d / play.throwSpeed;
  if (d > 50) {
    // 중계 플레이 1회 (커트맨 포구 + 재송구 동작)
    time += 0.85;
  }
  return time;
}

export { INFIELD, OUTFIELD, rangeSpeed, throwSpeed, effFielding };
