import { Rng, clamp, lerp, norm } from './rng';
import { BASE_COORDS, DEFENSE_SPOTS, GLOVE_DEFS, MOUND_DISTANCE, fenceDistance } from './constants';
import type { BattedBall, FieldPlay, Player, Position, Vec3 } from './types';
import { effSpeed, isFoulBall } from './batting';

const INFIELD: Position[] = ['P', 'C', '1B', '2B', '3B', 'SS'];
const OUTFIELD: Position[] = ['LF', 'CF', 'RF'];

function dist2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 야수의 이동 속도 (m/s). 스피드 + 수비 능력치. */
function rangeSpeed(p: Player): number {
  const s = norm(effSpeed(p));
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
const GLOVE_REACH = 1.25;

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
  const a = 4.9 + norm(effSpeed(p)) * 2.1; // 4.9 ~ 7.0 m/s^2
  const dAcc = (vmax * vmax) / (2 * a);
  if (d <= dAcc) return Math.sqrt((2 * d) / a);
  return vmax / a + (d - dAcc) / vmax;
}

/** 송구 속도 (m/s) */
function throwSpeed(p: Player): number {
  return lerp(24, 44, norm(p.batting.arm));
}

/**
 * 포구 후 송구 동작까지 (s). MLB 실측 exchange 중앙값은 0.75초쯤이고
 * 백핸드·역모션 처리까지 섞이면 꼬리가 길다.
 *
 * 난수를 빼면 모든 1루 승부가 같은 여유로 끝나 접전이 사라진다.
 * 실제로는 포구가 흔들리거나 송구가 살짝 빗나가는 일이 늘 있다.
 */
function transferTime(rng: Rng, p: Player): number {
  const base = lerp(1.02, 0.62, norm(p.batting.fielding));
  return Math.max(0.42, base + rng.normal(0, 0.1));
}

const HOME: Vec3 = { x: 0, y: 0, z: 0 };

/** 내야 흙의 경계. 실제 구장은 마운드 중심에서 반경 95 ft. */
const INFIELD_ARC = 28.96;

/**
 * 이 지점이 내야를 벗어났는가.
 *
 * `throughInfield`를 "내야수가 처리했는가"로 정하면, 유격수가 뒤로 물러나
 * 외야 잔디에서 주운 공까지 내야 땅볼로 분류되어 1루 승부가 붙는다
 * (홈에서 52m에 떨어진 라이너가 "유격수 땅볼 아웃"이 되는 식).
 * 판단 기준은 누가 잡았는지가 아니라 공이 어디까지 갔는지다.
 */
function beyondInfield(point: Vec3): boolean {
  return Math.hypot(point.x, point.z - MOUND_DISTANCE) > INFIELD_ARC;
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
  const foul = isFoulBall(bb);

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
      // 낮게 깔린 라이너는 떨어지는 공을 기다렸다 잡을 수가 없다. 야수가 낙구
      // 지점에 미리 가 있어야 하고, 아니면 눈앞에서 떨어진다. 이 여유를 0으로
      // 두면 가라앉는 타구가 전부 아웃이 되어 라인드라이브 안타율이 .60까지
      // 떨어진다 (MLB .655).
      const sinkMargin = clamp((22 - bb.launchAngle) * 0.018, 0, 0.28);
      if (margin >= sinkMargin) {
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
            transferTime: transferTime(rng, player),
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
          transferTime: transferTime(rng, player),
          infield: INFIELD.includes(pos),
          infieldFly,
        };
      }
      // 못 잡음 -> 안타.
      //
      // 떨어진 공을 낙구 지점에 고정해두면, 갭에 떨어져 외야를 가르는 타구가
      // 전부 그 자리에서 처리되어 2루타가 절반으로 줄어든다. 실제로는 공이
      // 튀어서 계속 굴러가고, 그 사이 타자가 2루를 밟는다.
      // 착지 후의 구르기는 땅볼과 같은 물리라서 그대로 재사용한다
      // (resolveGrounder는 landingVel의 수평 성분에서 굴리기 시작한다 —
      // 가라앉는 라이너는 멀리 구르고, 가파른 뜬공은 그 자리에 선다).
      return { ...resolveGrounder(rng, bb, defense), infieldFly };
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
    // 외야수 루트 효율. 이 값이 뜬공 안타율을 정한다 (MLB .130).
    const route = OUTFIELD.includes(pos) ? 0.78 : 1.0;
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

  // 구르는 공은 담장에서 멈춘다. 이 한계가 없으면 공이 담장 뒤 130m까지 굴러가고
  // 외야수가 거기까지 쫓아가느라 확보가 6.4초로 늘어져, 2루타가 될 타구가
  // 전부 3루타가 된다 (경기당 0.70 — MLB는 0.14).
  const maxRoll = fenceDistance((bb.sprayAngle * Math.PI) / 180);

  while (t < 8 && travelled < maxRoll) {
    speed = Math.max(2.4, speed - 4.4 * dt);
    travelled = Math.min(travelled + speed * dt, maxRoll);
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
        const rangePenalty = clamp((covered - 2.5) * 0.085, 0, 0.9);
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
          transferTime: transferTime(rng, p) + rangePenalty * 0.4,
          infield: INFIELD.includes(pos),
          // 내야수가 처리했더라도 외야 잔디까지 나가 주운 공이면 내야를 뚫린 것이다
          throughInfield: !INFIELD.includes(pos) || beyondInfield(point),
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
    transferTime: p ? transferTime(rng, p) : 0.7,
    infield: false,
    throughInfield: true,
    infieldFly: false,
  };
}

/**
 * 송구 비행 시간 (s).
 *
 * 야구공은 공기저항으로 속도가 v0·e^(-k·d)로 줄어든다 (k ≈ 0.0057 /m).
 * d/v0로 계산하면 내야 송구가 8%, 100m 중계 송구가 35% 빨라진다.
 */
function throwFlight(d: number, v0: number): number {
  const k = 0.0057;
  return (Math.exp(k * d) - 1) / (k * v0);
}

/** 커트맨이 공을 받아 다시 던지기까지 (s) */
const RELAY_TRANSFER = 0.8;

/**
 * 확보 지점에서 특정 베이스로 송구가 도달하는 시각.
 *
 * 먼 거리는 커트맨을 중간에 두고 절반씩 두 번 던진다. 항력이 거리에 지수로
 * 붙기 때문에(v = v0·e^(-kd)) 아주 먼 송구는 나눠 던지는 쪽이 실제로 더 빠르다.
 * 야수는 둘 중 빠른 쪽을 고른다.
 *
 * 예전에는 "한 번에 던진 시간 + 중계 페널티"로 계산했다. 이건 두 선택지의
 * 나쁜 쪽만 합친 값이라 담장 앞 타구의 송구가 0.85초씩 늦어졌고, 2루타가 될
 * 타구가 전부 3루타로 기록됐다 (경기당 0.52 — MLB는 0.14).
 */
export function throwArrivalTime(play: FieldPlay, baseIndex: number): number {
  const target = BASE_COORDS[baseIndex];
  const d = Math.hypot(play.securePoint.x - target.x, play.securePoint.z - target.z);
  const direct = throwFlight(d, play.throwSpeed);
  const relay =
    d > 50 ? throwFlight(d / 2, play.throwSpeed) * 2 + RELAY_TRANSFER : Number.POSITIVE_INFINITY;
  return play.secureTime + play.transferTime + Math.min(direct, relay);
}

export { INFIELD, OUTFIELD, rangeSpeed, throwSpeed, effFielding };
