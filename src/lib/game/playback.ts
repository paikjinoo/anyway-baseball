/**
 * 플레이 연출용 주루 타임라인.
 *
 * 엔진은 "결과 상태"만 만들어 주므로, 그대로 그리면 주자가 베이스 사이를
 * 순간이동한다. 여기서 PitchResult.runnerMoves 와 주루 시간 모델을 합쳐
 * "언제 어디에 있는가"를 시간 함수로 만들고, 화면은 그것을 샘플링만 한다.
 *
 * 시간 단위는 전부 엔진 시간(초)이고 기준점 t=0 은 타격(또는 포구) 순간이다.
 */

import {
  BASE_COORDS,
  BASE_DISTANCE,
  DEFENSE_SPOTS,
  DRAG_K,
  GRAVITY,
  RUN_STRIDE,
  fenceDistance,
} from './constants';
import { baseToBase, homeToFirst, tagUpTime } from './baserunning';
import { throwArrivalTime } from './fielding';
import { clamp } from './rng';
import type { BattedBall, PitchResult, Player, Position, Vec3 } from './types';

/** 타구 판단 후 스타트를 끊기까지 */
const REACTION = 0.22;
/**
 * 타자가 스윙을 마치고 타석을 벗어나기까지.
 * 이 시간 동안은 타석 모델이 팔로스루를 끝내고, 그 뒤 주자 모델이 이어받는다.
 */
export const BOX_EXIT = 0.2;
/**
 * 투구와 동시에 스타트한 주자의 선행 시간.
 * 실제 엔진 보정(1.35s)을 그대로 쓰면 연출 시작 시점에 주자가 이미 베이스간
 * 40% 지점에 있어 순간이동처럼 보인다. 화면상으로는 짧게만 앞세운다.
 */
const DISPLAY_HEAD_START = 0.45;
/** 한 걸음 주기당 이동 거리. 모델의 접지 보폭과 짝을 이룬다 (@see constants.RUN_STRIDE) */
const STRIDE = RUN_STRIDE;
/** 홈런 세리머니 주루는 전력질주가 아니다 */
const TROT_SCALE = 1.6;

const CENTER: Vec3 = { x: 0, y: 0, z: (BASE_DISTANCE * Math.SQRT2) / 2 };

// ---------------------------------------------------------------------------
// 좌표
// ---------------------------------------------------------------------------

/** 베이스 인덱스의 좌표. -1 = 타석, 0~2 = 1~3루, 3 = 홈. */
export function bagPoint(base: number, batsLeft = false): Vec3 {
  // 좌타자는 1루 쪽(-X), 우타자는 3루 쪽(+X) 타석에 선다
  if (base <= -1) return { x: batsLeft ? -0.78 : 0.78, y: 0, z: 0.15 };
  return BASE_COORDS[Math.min(base, 3)];
}

/** 다이아몬드 바깥 방향 (베이스에서 중앙 반대쪽) */
function outwardAt(base: number): Vec3 {
  const b = bagPoint(clamp(base, 0, 3));
  const dx = b.x - CENTER.x;
  const dz = b.z - CENTER.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, y: 0, z: dz / len };
}

/**
 * 베이스에 멈춰 선 주자의 위치.
 * 베이스를 정확히 밟고 서면 야수와 겹치므로 다음 베이스 쪽으로 살짝 리드하고
 * 다이아몬드 바깥으로 비켜 세운다. 정지 렌더링과 애니메이션이 같은 값을 써야
 * 연출이 끝나는 순간 튀지 않는다.
 */
export function baseStation(base: number): Vec3 {
  const bag = bagPoint(base);
  const next = bagPoint(base + 1);
  const dx = next.x - bag.x;
  const dz = next.z - bag.z;
  const len = Math.hypot(dx, dz) || 1;
  const out = outwardAt(base);
  return {
    x: bag.x + (dx / len) * 1.9 + out.x * 0.5,
    y: 0,
    z: bag.z + (dz / len) * 1.9 + out.z * 0.5,
  };
}

/** 베이스에서 다음 베이스를 바라보는 각도 */
export function baseFacing(base: number): number {
  const bag = bagPoint(base);
  const next = bagPoint(base + 1);
  return Math.atan2(next.x - bag.x, next.z - bag.z);
}

// ---------------------------------------------------------------------------
// 타임라인
// ---------------------------------------------------------------------------

export interface RunLeg {
  from: number;
  to: number;
  start: number;
  end: number;
  /** 이 구간 끝에서 멈추는가 (베이스를 돌지 않고 정지) */
  stop: boolean;
}

export interface RunnerAnim {
  playerId: string;
  batsLeft: boolean;
  legs: RunLeg[];
  /** 아웃 여부 */
  out: boolean;
  /** 아웃된 베이스. -1이면 뜬공 포구(공중에서 아웃) */
  outAt: number;
  scored: boolean;
  /** 마지막 도착 시각 */
  finish: number;
  /** 마지막 베이스에서 슬라이딩할지 */
  slide: boolean;
  /** 홈런 주루 */
  trot: boolean;
}

export interface PlayTimeline {
  runners: RunnerAnim[];
  /** 수비 연출 (야수 이동 + 송구). 타구가 없으면 null */
  field: FieldAnim | null;
  /** 낙구 후 공의 바운드/구르기. 땅에 닿지 않는 타구(포구·홈런 전)는 null */
  ground: GroundBall | null;
  /** 모든 움직임이 정리되는 시각 (s) */
  duration: number;
  /**
   * 결과를 화면에 드러내도 되는 시각 (s).
   * 이 시각까지는 판정을 알고 있어도 감춘다 (revealTime 참고).
   */
  revealAt: number;
  homeRun: boolean;
}

const EMPTY: PlayTimeline = {
  runners: [],
  field: null,
  ground: null,
  duration: 0,
  revealAt: 0,
  homeRun: false,
};

/**
 * PitchResult 하나를 주루 타임라인으로 변환한다.
 * roster는 공격팀 로스터 (주자 능력치 조회용).
 */
export function buildTimeline(
  result: PitchResult,
  roster: Record<string, Player>,
): PlayTimeline {
  const { field, ground } = buildFieldAnim(result);

  if (!result.runnerMoves.length) {
    // 주루가 없어도 타구는 날아가고 야수는 움직인다
    const hang = result.battedBall ? result.battedBall.hangTime + 0.5 : 0;
    const duration = Math.max(hang, fieldEnd(field));
    return {
      ...EMPTY,
      field,
      ground,
      duration,
      revealAt: clamp(revealTime(result, field, []), 0, duration),
    };
  }

  const homeRun = result.kind === 'HOME_RUN';
  const bunt = result.swing.type === 'BUNT';
  /**
   * 도루 주자는 판정이 쓴 주파 시간을 그대로 쓴다.
   *
   * 일반 주루 모델(baseToBase)로 그리면 3.3초가 걸려 1.9초에 도착하는 송구에
   * 언제나 진다 — 세이프로 판정된 도루가 화면에서는 여유 있는 아웃으로 보인다.
   * 타임라인의 t=0은 공이 홈플레이트에 닿는 순간이므로 catchTime만큼 당겨 놓는다.
   */
  const stealOf = new Map(
    result.stealResults
      .filter((x) => x.runTime !== undefined && x.catchTime !== undefined)
      .map((x) => [x.playerId, x]),
  );
  const hangTime = result.battedBall?.hangTime ?? 0;
  const runners: RunnerAnim[] = [];
  let duration = result.battedBall ? hangTime + 0.5 : 0.6;

  for (const m of result.runnerMoves) {
    const p = roster[m.playerId];
    if (!p) continue;

    const isBatter = m.from < 0;
    // 공중에서 잡힌 타자주자는 1루로 몇 걸음만 나갔다 돌아온다
    const caughtInAir = m.to === -1 && (m.outAt ?? -1) < 0;
    const dest =
      m.to === -1 ? (caughtInAir ? m.from + 1 : (m.outAt ?? m.from + 1)) : m.to;

    const legs: RunLeg[] = [];
    let cursor = m.running
      ? -DISPLAY_HEAD_START
      : m.tagUp
        ? hangTime
        : isBatter
          ? BOX_EXIT
          : REACTION;

    const legCount = Math.max(0, dest - m.from);
    for (let i = 0; i < legCount; i++) {
      const from = m.from + i;
      const to = from + 1;
      let dur =
        from < 0
          ? homeToFirst(p, bunt)
          : m.tagUp && i === 0
            ? tagUpTime(p)
            : baseToBase(p);
      if (homeRun) dur *= TROT_SCALE;
      const st = i === 0 ? stealOf.get(m.playerId) : undefined;
      if (st && st.fromBase === from) {
        // 투수가 움직인 순간 출발해서 판정과 같은 시각에 도착한다
        cursor = -st.catchTime!;
        dur = st.runTime! - cursor;
      }
      legs.push({ from, to, start: cursor, end: cursor + dur, stop: i === legCount - 1 });
      cursor += dur;
    }

    if (!legs.length) {
      // 진루하지 않은 주자는 정적 렌더링에 맡긴다.
      // 단, 제자리에서 아웃된 주자(귀루 실패 등)는 사라지는 연출이 필요하다.
      if (m.to !== -1) continue;
      legs.push({ from: m.from, to: m.from, start: cursor, end: cursor + 0.5, stop: true });
      cursor += 0.5;
    }

    if (caughtInAir) {
      // 1루까지 가지 않고 3분의 1 지점에서 멈춘다
      const l = legs[0];
      l.end = l.start + (l.end - l.start) * 0.34;
      legs.length = 1;
      cursor = l.end;
    }

    const out = m.to === -1;
    const slide = out || !!m.running || (legs.length > 1 && dest >= 1) || dest === 3;

    runners.push({
      playerId: m.playerId,
      batsLeft: p.bats === 'L',
      legs,
      out,
      outAt: caughtInAir ? -1 : (m.outAt ?? -1),
      scored: m.to === 3,
      finish: cursor,
      slide,
      trot: homeRun,
    });
    if (!homeRun) duration = Math.max(duration, cursor);
  }

  const total = Math.max(duration + 0.45, homeRun ? 0 : fieldEnd(field));
  return {
    runners,
    field,
    ground,
    duration: total,
    revealAt: clamp(revealTime(result, field, runners), 0, total),
    homeRun,
  };
}

// ---------------------------------------------------------------------------
// 결과 공개 시점
// ---------------------------------------------------------------------------

/**
 * 공이 담장 상공을 지나는 시각 (s).
 * 홈런이 확정되는 건 관중석에 떨어질 때가 아니라 이 순간이다.
 */
function fenceCrossTime(bb: BattedBall): number {
  const path = bb.path;
  if (path.length < 2) return bb.hangTime;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (Math.hypot(p.x, p.z) >= fenceDistance(Math.atan2(p.x, p.z))) {
      // path는 hangTime을 등간격으로 샘플링한 것이다 (sampleBattedPath와 같은 규약)
      return (i / (path.length - 1)) * bb.hangTime;
    }
  }
  return bb.hangTime;
}

/**
 * 결과를 화면에 드러내도 되는 시각 (s, 타격 순간이 0).
 *
 * 엔진은 배트에 맞는 순간 이미 답을 알고 있다. 그대로 그리면 타구가 날아가기도
 * 전에 "2루타"가 떠서 공을 지켜볼 이유가 없어진다. 그래서 판정 시각과 별개로
 * "눈으로 승부가 끝나는 순간"을 잡아 두고, 화면은 그때까지 결과를 감춘다.
 *
 * 야수가 공을 잡고, 송구가 베이스에 닿고, 주자가 마지막 베이스를 밟을 때까지가
 * 그 시각이다. 전부 판정에 쓰인 값에서 나오므로 화면과 결과가 어긋나지 않는다.
 */
function revealTime(
  result: PitchResult,
  field: FieldAnim | null,
  runners: RunnerAnim[],
): number {
  const bb = result.battedBall;

  // 타구가 없는 공은 심판이 곧바로 콜한다. 도루만 주자가 닿아야 안다.
  if (!bb || !result.contact) {
    if (!result.stealResults.length) return 0;
    const ids = new Set(result.stealResults.map((s) => s.playerId));
    return runners.reduce((t, r) => (ids.has(r.playerId) ? Math.max(t, r.finish) : t), 0);
  }

  if (result.kind === 'HOME_RUN') return fenceCrossTime(bb);
  // 파울처럼 수비가 붙지 않는 타구는 공이 떨어지는 순간 판정된다
  if (!field) return bb.hangTime;

  let t = field.chase.secure;
  // 송구 없이 직접 베이스를 밟으러 가는 구간 (1루수 땅볼 처리 등)
  const carry = field.chase.legs[1];
  if (carry) t = Math.max(t, carry.end);
  // 복귀 송구는 승부가 끝난 뒤의 일이라 결과를 미룰 이유가 없다
  const lastThrow = field.throws.filter((th) => !th.relay).pop();
  if (lastThrow) t = Math.max(t, lastThrow.end);
  // 몇 루타인지, 세이프인지는 주자가 멈춰야 결정된다
  for (const r of runners) {
    if (r.out || r.scored || (r.legs[0]?.from ?? 0) < 0) t = Math.max(t, r.finish);
  }
  return t;
}

/** 타자주자(타석에서 출발한 주자)의 애니메이션 */
export function batterRunner(tl: PlayTimeline): RunnerAnim | null {
  return tl.runners.find((r) => (r.legs[0]?.from ?? 0) < 0) ?? null;
}

// ---------------------------------------------------------------------------
// 수비 연출
// ---------------------------------------------------------------------------

/** 연출용 야수 이동 속도 (m/s). 판정에 쓰이는 값이 아니라 보기 좋은 근사치다. */
const FIELDER_SPEED = 7.4;
/**
 * 연출에서 절대 넘지 않는 이동 속도 (m/s).
 *
 * 판정 시각에 맞추려고 이동 시간을 줄이다 보면 야수가 순간이동하듯 뛴다.
 * 그럴 바에는 조금 늦게 도착하는 편이 낫다. 사람이 낼 수 있는 최고 속도가
 * 12m/s대이므로 전력질주로 읽히는 선까지만 허용한다.
 */
const FIELDER_MAX_SPEED = 9.6;
/**
 * 타구를 보고 첫 발을 떼기까지 (s).
 * 야수는 공이 떨어지기를 기다렸다가 뛰는 게 아니라, 타구를 판단하자마자
 * 낙구 지점으로 출발해 미리 가서 기다린다. fielding.reactionTime과 같은 뜻이지만
 * 이쪽은 연출용이라 포지션별 편차 없이 하나로 둔다.
 */
const BREAK_DELAY = 0.24;
/** 중계 플레이에서 받아 다시 던지기까지 */
const RELAY_PAUSE = 0.24;
/** 실책일 때 공을 더듬는 시간의 상한 (초) */
const FUMBLE_MAX = 1.1;
/** 이 거리 안이면 던지지 않고 직접 베이스를 밟으러 간다 */
const CARRY_DISTANCE = 4;
/** 그 베이스를 원래 지키는 야수라면 이만큼까지는 직접 밟으러 간다 */
const COVER_CARRY_DISTANCE = 7;
/** 공을 확보하고 내야로 돌려보내기까지 (s) */
const RETURN_PAUSE = 0.35;

/** 베이스를 커버하는 포지션 */
const COVER_OF: Position[] = ['1B', '2B', '3B', 'C'];
/**
 * 원래 커버해야 할 야수가 타구를 처리하러 빠졌을 때 대신 들어오는 야수.
 * 1루수가 타구를 쫓아가면 투수가 1루를 커버하는, 그 장면이다.
 */
const BACKUP_COVER_OF: Position[] = ['P', 'SS', 'SS', 'P'];
/** 외야 송구를 받아 주는 중계수 후보 */
const CUTOFF_CANDIDATES: Position[] = ['2B', 'SS'];

export interface MoveLeg {
  from: Vec3;
  to: Vec3;
  start: number;
  end: number;
}

export interface FielderChase {
  pos: Position;
  /** [0] 타구까지, [1] (있으면) 공을 들고 베이스까지 */
  legs: MoveLeg[];
  /** 공이 있는 곳에 도달하는 시각 */
  reach: number;
  /** 공을 확보하는 시각 (실책이면 reach보다 늦다) */
  secure: number;
  caught: boolean;
  error: boolean;
  /** 전력으로 달려 겨우 닿는 타구 — 몸을 던진다 */
  dive: boolean;
  /** 서서 잡을 수 있는 높이를 넘는 타구 — 뛰어오른다 */
  jump: boolean;
}

export interface BallThrow {
  from: Vec3;
  to: Vec3;
  start: number;
  end: number;
  /**
   * 승부와 무관한 복귀 송구(내야로 공을 돌려보내는 것)인가.
   * 결과 공개 시점과 연출 길이는 이 송구를 기다리지 않는다.
   */
  relay?: boolean;
}

export interface FieldAnim {
  chase: FielderChase;
  /** 송구 궤적 (병살이면 2개) */
  throws: BallThrow[];
  /** 베이스를 커버하러 가는 야수들. look은 송구가 날아오는 쪽. */
  covers: { pos: Position; leg: MoveLeg; look: Vec3 }[];
}

function dist2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 송구를 놓는 높이 / 받는 높이 (m) */
const THROW_RELEASE_Y = 1.45;
const THROW_CATCH_Y = 1.15;

/**
 * 송구 중 공의 위치.
 *
 * 예전에는 높이를 고정 포물선으로, 수평을 **등속**으로 그렸다. 그래서 외야에서 홈까지
 * 90m를 던져도 공이 처음부터 끝까지 같은 속도로 흘러 무게가 느껴지지 않았다.
 * 여기서는 출발·도착·비행시간(전부 판정이 정한 값)만 지키고 그 사이를 실제로 계산한다.
 *
 *  - 수직: 도착 높이에 맞는 초기 상향 속도를 역산해 중력으로 떨군다
 *  - 수평: 엔진과 같은 항력 모델(a = -DRAG_K·v²)로 감속한다.
 *    v(t) = v0 / (1 + k·v0·t) 이므로 거리는 ln(1 + k·v0·t)/k 이고,
 *    도착 거리 d에서 역산하면 v0 = (e^(k·d) − 1)/(k·T).
 */
function throwPoint(th: BallThrow, t: number): Vec3 {
  const T = Math.max(0.01, th.end - th.start);
  const tau = clamp(t - th.start, 0, T);
  const d = dist2d(th.from, th.to);

  let u: number;
  if (d < 0.5) {
    u = tau / T;
  } else {
    const v0 = (Math.exp(DRAG_K * d) - 1) / (DRAG_K * T);
    u = clamp(Math.log(1 + DRAG_K * v0 * tau) / (DRAG_K * d), 0, 1);
  }

  const vy = (THROW_CATCH_Y - THROW_RELEASE_Y + (GRAVITY * T * T) / 2) / T;
  return {
    x: th.from.x + (th.to.x - th.from.x) * u,
    y: THROW_RELEASE_Y + vy * tau - (GRAVITY * tau * tau) / 2,
    z: th.from.z + (th.to.z - th.from.z) * u,
  };
}


// ---------------------------------------------------------------------------
// 낙구 후의 공 (바운드 → 구르기)
// ---------------------------------------------------------------------------

/** 공 반지름. 지면에 놓인 공의 중심 높이. */
const BALL_RADIUS = 0.06;
/** 잔디 / 내야 흙의 수직 반발 계수. 흙이 더 잘 튄다. */
const GRASS_BOUNCE = 0.42;
const DIRT_BOUNCE = 0.52;
/** 바운드 1회마다 남는 수평 속도 */
const GRASS_SKID = 0.72;
const DIRT_SKID = 0.82;
/** 담장에 맞고 되튀어 나올 때 남는 법선 속도 */
const FENCE_REBOUND = 0.42;
/** 구르는 공의 감속 (m/s^2). 엔진의 땅볼 모델과 같은 값을 쓴다. */
const ROLL_FRICTION = 4.4;
/** 이보다 약하게 튀면 더 튀기지 않고 굴린다 */
const MIN_BOUNCE_VY = 0.9;
/** 바운드 구간 최대 개수 */
const MAX_HOPS = 5;
/** 내야 흙 반경 (Stadium의 내야 흙 부채꼴과 맞춘다) */
const DIRT_RADIUS = 29;
/** 수비가 붙지 않는 타구(파울/홈런)가 굴러가는 최대 거리 (m) */
const FREE_ROLL_MAX = 26;

/** 포물선 한 구간. 시작 높이 y0, 시작 수직속도 vy로 지면까지 간다. */
export interface BallHop {
  /** 착지 시각 기준 상대 시각 (s) */
  t0: number;
  /** 구간 길이 (s) */
  dur: number;
  y0: number;
  vy: number;
  /** 이 구간의 수평 속도 (m/s) */
  vh: number;
  /** 구간 시작까지 나아간 수평 거리 (m) */
  s0: number;
}

/**
 * 땅에 닿은 뒤의 공.
 *
 * 수직 운동(바운드)은 중력과 반발계수로 실제로 계산하고, 수평 운동은
 * from -> to 구간의 진행도(0~1)로 압축한다. 도달 지점과 시각은 판정이 정한
 * 값이므로, 두 축을 분리해야 판정과 어긋나지 않으면서 튀는 리듬이 살아난다.
 */
export interface GroundBall {
  /** 지면(담장을 맞았으면 담장)에 처음 닿은 지점 */
  from: Vec3;
  /** 공이 멈추거나 야수에게 잡히는 지점 */
  to: Vec3;
  /** from을 떠나는 시각 (s) */
  start: number;
  /** to에 도달하는 시각 (s) */
  end: number;
  hops: BallHop[];
  /** 마지막 바운드 이후 구르기 시작 속도 (m/s) / 그때까지의 거리 (m) */
  rollV: number;
  rollS0: number;
  /**
   * 수평 진행도 정규화 계수 (m) = end까지 물리적으로 나아가는 거리.
   * 0이면 물리 모델과 판정 결과의 차이가 너무 커서 신뢰할 수 없다는 뜻이고,
   * 이때는 등감속(굴러가다 멈추는 모양)으로 대체한다.
   */
  norm: number;
}

/** 착지 지점의 노면 */
function surfaceAt(p: Vec3) {
  const dirt = Math.hypot(p.x, p.z) < DIRT_RADIUS;
  return dirt
    ? { bounce: DIRT_BOUNCE, skid: DIRT_SKID }
    : { bounce: GRASS_BOUNCE, skid: GRASS_SKID };
}

/** 높이 y0에서 수직속도 vy로 출발한 공이 지면에 닿기까지 (s) */
function fallTime(y0: number, vy: number): number {
  const h = Math.max(0, y0 - BALL_RADIUS);
  return (vy + Math.sqrt(Math.max(0, vy * vy + 2 * GRAVITY * h))) / GRAVITY;
}

/**
 * 착지 순간의 속도.
 * 구버전 저장 데이터에는 landingVel이 없으므로 궤적 끝에서 근사한다.
 */
function impactVelocity(bb: BattedBall): Vec3 {
  const v = bb.landingVel;
  if (v && Math.hypot(v.x, v.z) > 0.5) return v;
  const p = bb.path;
  if (p.length >= 2) {
    const a = p[p.length - 2];
    const b = p[p.length - 1];
    const dt = 1 / 40; // simulateFlight의 궤적 샘플 간격
    const est = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt };
    if (Math.hypot(est.x, est.z) > 2) return est;
  }
  // 최후 수단: 타구 조건에서 추정한다 (방향만 맞으면 연출은 성립한다)
  const sa = (bb.sprayAngle * Math.PI) / 180;
  const speed = (bb.exitVelocity / 3.6) * 0.5;
  return { x: -speed * Math.sin(sa), y: -6, z: speed * Math.cos(sa) };
}

/** 담장에 맞은 공은 안쪽으로 튕겨 나온다 */
function fenceRebound(point: Vec3, vel: Vec3): Vec3 {
  const r = Math.hypot(point.x, point.z) || 1;
  const nx = point.x / r;
  const nz = point.z / r;
  const vn = vel.x * nx + vel.z * nz; // 담장 바깥 방향 성분
  const rn = -FENCE_REBOUND * vn;
  return {
    x: (vel.x - vn * nx) * 0.7 + rn * nx,
    y: vel.y,
    z: (vel.z - vn * nz) * 0.7 + rn * nz,
  };
}

/**
 * 반발 계수는 충돌 속도가 빠를수록 떨어진다 (공이 그만큼 더 찌그러진다).
 * 이 감쇠가 없으면 높이 뜬 타구가 사람 키의 몇 배로 튀어오른다.
 */
function restitution(base: number, impact: number): number {
  return base * (1 - 0.45 * clamp(impact / 40, 0, 1));
}

/**
 * 착지 속도로부터 바운드 구간을 만든다.
 * 수직(튀는 높이)과 수평(깎이는 속도)을 한 번에 계산해 두고, 이후에는
 * 이 구간들을 시간으로 훑기만 한다.
 */
function buildHops(from: Vec3, vel: Vec3): { hops: BallHop[]; rollV: number; rollS0: number } {
  const surf = surfaceAt(from);
  const hops: BallHop[] = [];
  // 담장을 맞은 공은 아직 공중에 있다. 첫 구간은 남은 낙하가 된다.
  const airborne = from.y > BALL_RADIUS + 0.05;
  let y = Math.max(BALL_RADIUS, from.y);
  let vy = airborne
    ? vel.y
    : Math.abs(vel.y) * restitution(surf.bounce, Math.abs(vel.y));
  let vh = Math.hypot(vel.x, vel.z);
  if (!airborne) vh *= surf.skid;
  let t = 0;
  let s = 0;

  for (let i = 0; i < MAX_HOPS; i++) {
    const dur = fallTime(y, vy);
    if (dur < 0.03) break;
    hops.push({ t0: t, dur, y0: y, vy, vh, s0: s });
    t += dur;
    s += vh * dur;
    // 지면에 닿는 순간의 하강 속도에서 반발분만 되튄다
    const impact = Math.abs(vy - GRAVITY * dur);
    vy = impact * restitution(surf.bounce, impact);
    vh *= surf.skid; // 바운드마다 노면에 깎인다
    y = BALL_RADIUS;
    if (vy < MIN_BOUNCE_VY) break;
  }
  return { hops, rollV: vh, rollS0: s };
}

/** rel(착지 후 경과 s) 시점까지 나아간 수평 거리 */
function travelledAt(g: Pick<GroundBall, 'hops' | 'rollV' | 'rollS0'>, rel: number): number {
  if (rel <= 0) return 0;
  for (const h of g.hops) {
    if (rel <= h.t0 + h.dur) return h.s0 + h.vh * (rel - h.t0);
  }
  const last = g.hops[g.hops.length - 1];
  const after = rel - (last ? last.t0 + last.dur : 0);
  const d = clamp(after, 0, g.rollV / ROLL_FRICTION);
  return g.rollS0 + g.rollV * d - 0.5 * ROLL_FRICTION * d * d;
}

/** 공이 완전히 멈추는 시각(착지 후 경과 s)과 그때까지의 거리 */
function restingAt(g: Pick<GroundBall, 'hops' | 'rollV' | 'rollS0'>) {
  const last = g.hops[g.hops.length - 1];
  const t = (last ? last.t0 + last.dur : 0) + g.rollV / ROLL_FRICTION;
  return { time: t, dist: g.rollS0 + (g.rollV * g.rollV) / (2 * ROLL_FRICTION) };
}

/** 페어 지역에서 담장 밖으로 굴러 나가지 않게 잡아 준다 */
function clampInsideFence(from: Vec3, p: Vec3): Vec3 {
  const theta = Math.atan2(p.x, p.z);
  if (Math.abs(theta) > Math.PI / 4) return p; // 파울 지역에는 담장이 없다
  const fromTheta = Math.atan2(from.x, from.z);
  // 이미 담장 밖에서 시작한 공(홈런)은 그대로 굴러가게 둔다
  if (
    Math.abs(fromTheta) <= Math.PI / 4 &&
    Math.hypot(from.x, from.z) > fenceDistance(fromTheta) - 0.5
  ) {
    return p;
  }
  const r = Math.hypot(p.x, p.z);
  const max = fenceDistance(theta) - 0.4;
  if (r <= max || r < 0.01) return p;
  return { x: (p.x / r) * max, y: p.y, z: (p.z / r) * max };
}

/**
 * 야수가 공의 진행 방향으로 따라갈 수 있는 최대 거리.
 * 정위치에서 reach까지 달릴 수 있는 반경과 공의 진행선이 만나는 지점.
 */
function reachableAlong(
  spot: Vec3,
  from: Vec3,
  dir: { x: number; z: number },
  radius: number,
): number {
  const wx = from.x - spot.x;
  const wz = from.z - spot.z;
  const b = wx * dir.x + wz * dir.z;
  const c = wx * wx + wz * wz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return 0;
  return Math.max(0, -b + Math.sqrt(disc));
}

/**
 * 낙구 후 공의 거동을 만든다.
 *
 * target(엔진이 정한 처리 지점)이 공의 진행 방향 앞쪽이면 그대로 쓴다 —
 * 굴러가는 타구를 야수가 앞에서 막아서는 그림이다.
 * 뜬공·직선타처럼 "떨어진 자리에서 처리"로 계산된 타구는 그대로 두면 공이
 * 제자리에서만 튀므로, 실제로 굴러갈 거리만큼 앞으로 내보내고 야수가
 * 거기까지 쫓아가게 한다. 단 야수가 제시간에 닿을 수 있는 범위까지만이다.
 */
function buildGroundBall(
  bb: BattedBall,
  target: Vec3,
  end: number,
  spot: Vec3 | null,
): GroundBall {
  const from = bb.landing;
  const start = bb.hangTime;
  const raw = impactVelocity(bb);
  const vel = bb.hitFence ? fenceRebound(from, raw) : raw;
  const motion = buildHops(from, vel);

  const vh = Math.hypot(vel.x, vel.z);
  const r0 = Math.hypot(from.x, from.z) || 1;
  // 굴러가는 방향. 속도가 없으면 타구가 뻗어 나온 방향으로 둔다.
  const dir =
    vh > 0.5
      ? { x: vel.x / vh, z: vel.z / vh }
      : { x: from.x / r0, z: from.z / r0 };
  const ahead = (d: number): Vec3 =>
    clampInsideFence(from, { x: from.x + dir.x * d, y: 0, z: from.z + dir.z * d });

  // ---- 수비가 붙지 않는 타구(파울/홈런): 스스로 멈출 때까지 굴러간다 ------
  if (!spot) {
    const rest = restingAt(motion);
    const dist = Math.min(rest.dist, FREE_ROLL_MAX);
    const to = ahead(dist);
    const real = dist2d(from, to); // 담장에 막혔으면 더 짧아진다
    const time = rest.dist > 0.1 ? rest.time * (real / rest.dist) : 0;
    return {
      from,
      to,
      start,
      end: start + Math.max(0.4, time),
      ...motion,
      norm: travelledAt(motion, Math.max(0.4, time)),
    };
  }

  // ---- 야수가 처리하는 타구 ---------------------------------------------
  const span = Math.max(0.05, end - start);
  const within = travelledAt(motion, span);
  const along = (target.x - from.x) * dir.x + (target.z - from.z) * dir.z;

  // 판정 지점이 공의 진행 방향 앞쪽이면 그대로 쓴다 (앞에서 막아서는 그림).
  //
  // 뒤쪽이면 그대로 쓸 수 없다. 굴러가던 공이 거꾸로 되돌아가는 그림이 되기 때문이다.
  // (엔진의 땅볼 모델은 공이 홈에서부터 구른다고 보므로, 체공이 긴 낮은 타구에서는
  //  공이 이미 넘어간 지점을 처리 지점으로 내놓는다.) 이때는 공을 진행 방향으로만
  // 내보내고 — 야수가 시간 안에 닿을 수 있는 데까지 — 야수가 거기로 오게 한다.
  let to = clampInsideFence(from, target);
  if (along < 1) {
    const radius = FIELDER_SPEED * Math.max(0.2, end - BREAK_DELAY);
    to = ahead(Math.max(0, Math.min(within, reachableAlong(spot, from, dir, radius))));
  } else if ((to.x - from.x) * dir.x + (to.z - from.z) * dir.z < 0) {
    // 담장에 걸려 뒤로 당겨졌다면 착지 지점에 세운다
    to = from;
  }

  // 물리적으로 굴러갈 거리와 실제 도달 거리가 크게 다르면 (엔진의 땅볼 모델은
  // 홈에서부터 굴린다) 물리 프로파일이 의미를 잃는다. 그때는 등감속으로 만다.
  const need = dist2d(from, to);
  const trust = need < 0.3 || (within > need * 0.35 && within < need * 3);
  return {
    from,
    to,
    start,
    end: Math.max(start + 0.05, end),
    ...motion,
    norm: trust ? within : 0,
  };
}

/** 시각 t에서 지면 위 공의 위치 */
export function sampleGroundBall(g: GroundBall, t: number): Vec3 {
  const rel = t - g.start;
  const span = Math.max(0.01, g.end - g.start);
  // 수평 진행도. 물리 프로파일을 믿을 수 있으면 그대로, 아니면 등감속.
  let u: number;
  if (g.norm > 0.05) {
    u = clamp(travelledAt(g, rel) / g.norm, 0, 1);
  } else {
    const x = clamp(rel / span, 0, 1);
    u = 1 - (1 - x) * (1 - x);
  }

  let y = BALL_RADIUS;
  for (const h of g.hops) {
    if (rel < h.t0) break;
    if (rel <= h.t0 + h.dur) {
      const dt = rel - h.t0;
      y = Math.max(BALL_RADIUS, h.y0 + h.vy * dt - 0.5 * GRAVITY * dt * dt);
      break;
    }
  }

  return {
    x: g.from.x + (g.to.x - g.from.x) * u,
    y,
    z: g.from.z + (g.to.z - g.from.z) * u,
  };
}

function fieldEnd(f: FieldAnim | null): number {
  if (!f) return 0;
  // 복귀 송구는 결과가 공개된 뒤 여유 시간에 흘러가면 되므로 길이에 세지 않는다
  const last = f.throws.filter((th) => !th.relay).pop();
  return (last ? last.end : f.chase.secure) + 0.5;
}

/**
 * 수비 연출 타임라인.
 *
 * 판정에 쓰인 FieldPlay(누가·언제·어디서)를 그대로 재생하므로,
 * 화면에서 야수가 공을 잡는 순간과 엔진이 아웃/안타를 가른 순간이 일치한다.
 * 낙구 후 공이 튀고 굴러가는 구간(ground)도 함께 만든다.
 */
function buildFieldAnim(result: PitchResult): { field: FieldAnim | null; ground: GroundBall | null } {
  const play = result.fieldPlay;
  const bb = result.battedBall;
  // 타구가 없어도 도루에는 수비가 붙는다 (포수 송구 + 베이스 커버)
  if (!bb) return { field: buildStealAnim(result), ground: null };
  if (!play || play.homeRun || (play.foul && !play.foulCaught)) {
    return { field: null, ground: buildGroundBall(bb, bb.landing, bb.hangTime, null) };
  }
  // 노바운드로 잡힌 타구는 땅에 닿지 않는다
  if (play.caught) return { field: buildChase(result, play, bb, bb.landing), ground: null };

  const secure = Math.max(0.1, play.secureTime);
  const reach = play.error ? Math.max(bb.hangTime, secure - FUMBLE_MAX) : secure;
  const ground = buildGroundBall(bb, play.securePoint, reach, DEFENSE_SPOTS[play.primary]);
  return { field: buildChase(result, play, bb, ground.to), ground };
}

/** 도루 시 목표 베이스를 커버하는 야수. 2루는 유격수, 3루는 3루수. */
const STEAL_COVER: Record<number, Position> = { 1: 'SS', 2: '3B', 3: 'C' };

/**
 * 도루 연출.
 *
 * 예전에는 타구가 없으면 field가 통째로 null이라 **포수가 미동도 하지 않았다.**
 * 주자만 혼자 뛰다가 아웃 판정이 나는, 승부가 어디서 갈렸는지 알 수 없는 장면이었다.
 *
 * 시각은 전부 판정이 쓴 값(StealResult.catchTime/defTime)을 그대로 쓴다. 그래서
 * 화면에서 송구가 베이스에 닿는 순간과 세이프/아웃이 갈리는 순간이 정확히 같다.
 */
function buildStealAnim(result: PitchResult): FieldAnim | null {
  // 홈 스틸은 포수가 송구하지 않는다 (그 자리에서 태그한다)
  const steals = result.stealResults.filter(
    (s) => s.fromBase < 2 && s.catchTime !== undefined && s.defTime !== undefined,
  );
  if (!steals.length) return null;
  // 더블 스틸이면 승부가 걸린 앞 주자 쪽으로 던진다
  const target = steals.reduce((a, b) => (b.fromBase > a.fromBase ? b : a));
  const base = target.fromBase + 1;
  const bag = BASE_COORDS[base];
  const home = DEFENSE_SPOTS.C;
  const catchAt = target.catchTime!;
  const arrive = target.defTime!;
  const cover = STEAL_COVER[base] ?? 'SS';
  const spot = DEFENSE_SPOTS[cover];

  const chase: FielderChase = {
    pos: 'C',
    // 포수는 제자리에서 받아 던진다
    legs: [{ from: home, to: home, start: 0, end: catchAt }],
    reach: catchAt,
    secure: catchAt,
    caught: true,
    error: false,
    dive: false,
    jump: false,
  };
  const throws: BallThrow[] = [{ from: home, to: bag, start: catchAt, end: arrive }];
  const covers: FieldAnim['covers'] = [];
  addCover(covers, cover, 'C', bag, home, arrive);
  // 커버가 늦게 출발하면 태그가 성립하지 않으므로 투구와 동시에 붙는다
  if (covers[0]) {
    covers[0].leg.start = 0;
    covers[0].leg.end = Math.min(arrive - 0.1, dist2d(spot, bag) / FIELDER_SPEED);
  }
  return { chase, throws, covers };
}

/** ball = 야수가 공을 만나는 지점 (구르는 타구는 실제로 굴러간 끝) */
function buildChase(
  result: PitchResult,
  play: NonNullable<PitchResult['fieldPlay']>,
  bb: NonNullable<PitchResult['battedBall']>,
  ball: Vec3,
): FieldAnim {
  const home = DEFENSE_SPOTS[play.primary];
  const runUp = dist2d(home, ball);
  // 실책이면 공에는 먼저 닿고, 확보만 늦어진다 (더듬는 연출)
  const rawSecure = Math.max(0.1, play.secureTime);
  const rawReach = play.error ? Math.max(bb.hangTime, rawSecure - FUMBLE_MAX) : rawSecure;
  // 타구를 보자마자 낙구 지점으로 출발한다. 도착이 포구 시각보다 이르면
  // 그 자리에서 공을 기다린다(뜬공을 미리 가서 잡는 모습). 늦게 출발시켜
  // 도착 시각을 맞추면 야수가 공이 떨어질 때까지 멀뚱히 서 있게 된다.
  //
  // 반대로 시간이 모자라면 먼저(최대 타격 순간까지) 출발시키고, 그래도 모자라면
  // 상한 속도까지만 올린다. 남은 차이는 "조금 늦게 도착"으로 흡수한다 —
  // 판정 시각에 억지로 맞추면 야수가 40m/s로 뛰는 그림이 나온다.
  const start = clamp(rawReach - runUp / FIELDER_SPEED, 0, BREAK_DELAY);
  const arrive = Math.max(
    Math.min(rawReach, start + runUp / FIELDER_SPEED),
    start + runUp / FIELDER_MAX_SPEED,
  );
  // 야수가 늦게 닿으면 공도 그때까지 땅에 남아 있어야 한다 (글러브로 순간이동 금지)
  const reach = Math.max(rawReach, arrive);
  const secure = Math.max(rawSecure, arrive);

  // 아슬아슬한 처리에는 다이빙/점프를 붙인다. 전부 같은 자세로 서서 받으면
  // 담장 앞 호수비도 평범한 뜬공도 구별이 안 된다.
  //
  // **평속(FIELDER_SPEED)으로 닿는 타구는 다이빙이 아니다.** buildChase는 여유가 있으면
  // 도착 시각을 정확히 평속으로 잡으므로, 기준을 평속에 두면 사실상 모든 수비가
  // 다이빙이 된다(처음에 그렇게 만들었더니 수비 프레임의 44%가 다이빙이었다).
  // 평속을 넘겨야만 닿는 경우 = 몸을 던져야 닿는 경우다.
  const runSpeed = runUp / Math.max(0.05, arrive - start);
  const chase: FielderChase = {
    pos: play.primary,
    legs: [{ from: home, to: ball, start, end: arrive }],
    reach,
    secure,
    caught: play.caught,
    error: play.error,
    dive: runUp > 5 && runSpeed > FIELDER_SPEED * 1.03,
    // 내야를 넘어가려던 라이너를 낚아채는 점프. 체공이 짧아 뛰지 않으면 닿지 않는다.
    jump: play.caught && play.infield && bb.kind === 'LINE_DRIVE' && bb.hangTime < 1.5,
  };

  // ---- 송구 대상: 아웃이 기록된 베이스 -----------------------------------
  const outBases = result.runnerMoves
    .filter((m) => m.to === -1 && (m.outAt ?? -1) >= 0)
    .map((m) => m.outAt as number)
    .filter((b, i, arr) => arr.indexOf(b) === i)
    .sort((a, b) => throwArrivalTime(play, a) - throwArrivalTime(play, b));

  const throws: BallThrow[] = [];
  const covers: FieldAnim['covers'] = [];
  let origin = ball;
  let originTime = secure;

  for (const base of outBases.slice(0, 2)) {
    const bag = BASE_COORDS[base];
    const d = dist2d(origin, bag);
    // 그 베이스를 지킬 야수. 원래 커버가 타구를 처리하러 빠졌으면 백업이 들어온다.
    const natural = COVER_OF[base];
    const cover = natural === play.primary ? BACKUP_COVER_OF[base] : natural;
    const carryLimit = natural === play.primary ? COVER_CARRY_DISTANCE : CARRY_DISTANCE;

    if (throws.length === 0 && d < carryLimit) {
      // 코앞이면 던지지 않고 직접 베이스를 밟는다 (1루수 앞 땅볼 등).
      // 뛰어가는 시간은 실제로 걸리는 만큼 준다.
      const end = Math.max(secure + d / FIELDER_SPEED, throwArrivalTime(play, base));
      chase.legs.push({ from: ball, to: bag, start: secure, end });
      origin = bag;
      originTime = end;
      continue;
    }

    const end =
      throws.length === 0
        ? Math.max(originTime + 0.2, throwArrivalTime(play, base))
        : originTime + RELAY_PAUSE + d / Math.max(20, play.throwSpeed);
    const begin = throws.length === 0 ? Math.max(originTime, end - d / Math.max(20, play.throwSpeed)) : originTime + RELAY_PAUSE;
    throws.push({ from: origin, to: bag, start: begin, end });
    addCover(covers, cover, play.primary, bag, origin, end);
    origin = bag;
    originTime = end;
  }

  // ---- 복귀 송구 ---------------------------------------------------------
  // 아웃을 잡을 곳이 없으면(안타 · 뜬공 포구 등) 여기까지 송구가 하나도 없다.
  // 그대로 두면 야수가 공을 든 채 그라운드에 서 있다. 실제로는 곧바로
  // 내야로 공을 돌려보내므로, 승부와 무관한 복귀 송구를 붙인다.
  if (!throws.length && chase.legs.length === 1) {
    addReturnThrow(throws, covers, play, origin, originTime);
  }

  return { chase, throws, covers };
}

/** 베이스 커버. 타구와 동시에 출발해 미리 가서 송구를 기다린다. */
function addCover(
  covers: FieldAnim['covers'],
  cover: Position,
  primary: Position,
  to: Vec3,
  look: Vec3,
  arriveBy: number,
) {
  if (cover === primary || covers.some((c) => c.pos === cover)) return;
  const spot = DEFENSE_SPOTS[cover];
  const d = dist2d(spot, to);
  const start = Math.min(BREAK_DELAY, arriveBy);
  covers.push({
    pos: cover,
    leg: {
      from: spot,
      to,
      // 일찍 닿으면 기다리고, 모자라면 상한 속도까지만 올린다
      start,
      end: Math.max(Math.min(arriveBy, start + d / FIELDER_SPEED), start + d / FIELDER_MAX_SPEED),
    },
    look,
  });
}

/**
 * 내야로 공을 돌려보내는 송구.
 * 외야수는 마중 나온 중계수에게, 내야수는 투수에게 던진다.
 * 투수·포수가 들고 있으면 이미 제자리이므로 아무것도 하지 않는다.
 */
function addReturnThrow(
  throws: BallThrow[],
  covers: FieldAnim['covers'],
  play: NonNullable<PitchResult['fieldPlay']>,
  from: Vec3,
  fromTime: number,
) {
  const primary = play.primary;
  if (primary === 'P' || primary === 'C') return;

  const outfield = !play.infield;
  const target = outfield
    ? CUTOFF_CANDIDATES.reduce((best, p) =>
        dist2d(DEFENSE_SPOTS[p], from) < dist2d(DEFENSE_SPOTS[best], from) ? p : best,
      )
    : 'P';
  if (target === primary) return;

  const spot = DEFENSE_SPOTS[target];
  // 중계수는 타구와 동시에 출발해 외야 쪽으로 마중 나간다.
  // 마중 나갈 수 있는 거리는 공을 확보할 때까지 실제로 달릴 수 있는 만큼이다.
  const gap = dist2d(spot, from);
  const advance = outfield
    ? Math.min(gap * 0.45, FIELDER_SPEED * Math.max(0, fromTime - BREAK_DELAY))
    : 0;
  const meet: Vec3 =
    advance > 0.5
      ? {
          x: spot.x + ((from.x - spot.x) / gap) * advance,
          y: 0,
          z: spot.z + ((from.z - spot.z) / gap) * advance,
        }
      : spot;

  const start = fromTime + RETURN_PAUSE;
  const end = start + dist2d(from, meet) / Math.max(20, play.throwSpeed);
  throws.push({ from, to: meet, start, end, relay: true });
  // 마중 나갈 때만 야수를 움직인다. 제자리에서 받는 경우(투수)까지 covers에 넣으면
  // 타격 직후부터 포구 자세로 고정되어 투수의 팔로스루가 잘린다.
  if (advance > 0.5) addCover(covers, target, primary, meet, from, start);
}

// ---------------------------------------------------------------------------
// 수비 샘플링
// ---------------------------------------------------------------------------

export interface FielderSample {
  pos: Vec3;
  yaw: number;
  pose: FielderPose;
  cycle: number;
  intensity: number;
}

export type FielderPose =
  | 'RUNNING'
  | 'FIELDING'
  | 'CATCHING'
  | 'IDLE'
  | 'THROWING'
  | 'TAG'
  | 'DIVING'
  | 'JUMP';

/**
 * 송구 모션 길이 (s)와 그 안에서 공이 손을 떠나는 지점.
 *
 * **릴리스가 BallThrow.start와 정확히 겹쳐야 한다.** 안 그러면 공이 아직 팔을 뒤로
 * 뺀 야수의 손에서 튀어나가거나, 이미 던진 팔 뒤를 따라 나간다. 그래서 모션은
 * `start` 이전에 시작해서 이후까지 이어진다.
 * @see PlayerModel의 THROW_RELEASE_AT (같은 값이어야 한다)
 */
const THROW_MS = 0.62;
const THROW_RELEASE = 0.44;

/** 송구가 시작되기 전에 팔을 감기 시작하는 시각 */
function throwWindup(startAt: number, notBefore: number): number {
  return Math.max(notBefore, startAt - THROW_MS * THROW_RELEASE);
}

/** t가 이 야수의 송구 모션 구간이면 진행도(0~1), 아니면 null */
function throwPhase(from: Vec3, th: BallThrow | undefined, notBefore: number, t: number) {
  if (!th) return null;
  const begin = throwWindup(th.start, notBefore);
  const rel = th.start;
  const end = rel + THROW_MS * (1 - THROW_RELEASE);
  if (t < begin || t > end) return null;
  // 여유가 모자라면 앞구간을 압축한다 (릴리스 시각은 그대로 지킨다)
  const k =
    t < rel
      ? (rel === begin ? THROW_RELEASE : ((t - begin) / (rel - begin)) * THROW_RELEASE)
      : THROW_RELEASE + ((t - rel) / (end - rel)) * (1 - THROW_RELEASE);
  return { k: clamp(k, 0, 1), yaw: facing(from, th.to) };
}

function legPos(leg: MoveLeg, t: number): { pos: Vec3; moving: boolean; travelled: number } {
  const span = Math.max(0.01, leg.end - leg.start);
  const u = clamp((t - leg.start) / span, 0, 1);
  const len = dist2d(leg.from, leg.to);
  return {
    pos: {
      x: leg.from.x + (leg.to.x - leg.from.x) * u,
      y: 0,
      z: leg.from.z + (leg.to.z - leg.from.z) * u,
    },
    moving: t > leg.start && t < leg.end && len > 0.3,
    travelled: len * u,
  };
}

function facing(from: Vec3, to: Vec3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** 타구가 날아오는 쪽 (홈플레이트) */
const HOME: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * 시각 t에서 이 포지션의 야수 상태. 움직이지 않는 야수는 null.
 * (null이면 화면은 정위치 + 기본 자세로 그린다)
 */
export function sampleFielder(
  field: FieldAnim | null,
  pos: Position,
  t: number,
): FielderSample | null {
  if (!field) return null;

  const cover = field.covers.find((c) => c.pos === pos);
  if (cover) {
    if (t < cover.leg.start) return null;
    const s = legPos(cover.leg, t);
    // 베이스에 자리를 잡으면 포구 자세로 기다리다가, 송구가 닿은 뒤에는 태그 자세로 남는다
    const arrived = !s.moving;
    const throwIn = field.throws.find((th) => dist2d(th.to, cover.leg.to) < 1.2);
    // 병살: 받아서 곧바로 다음 베이스로 던진다
    const relayOut = field.throws.find((th) => dist2d(th.from, cover.leg.to) < 1.2);
    const relaying = arrived
      ? throwPhase(cover.leg.to, relayOut, throwIn ? throwIn.end : cover.leg.end, t)
      : null;
    if (relaying) {
      return { pos: s.pos, yaw: relaying.yaw, pose: 'THROWING', cycle: relaying.k, intensity: 1 };
    }
    const tagging = arrived && !!throwIn && t > throwIn.end;
    return {
      pos: s.pos,
      yaw: arrived ? facing(cover.leg.to, cover.look) : facing(cover.leg.from, cover.leg.to),
      pose: arrived ? (tagging ? 'TAG' : 'CATCHING') : 'RUNNING',
      cycle: (s.travelled / RUN_STRIDE) % 1,
      intensity: 0.95,
    };
  }

  const c = field.chase;
  if (c.pos !== pos) return null;

  const first = c.legs[0];
  if (t < first.start) return null;

  // 공을 잡은 뒤의 송구. 릴리스 순간이 공이 떠나는 시각과 겹치도록 앞뒤로 걸친다.
  const th = field.throws[0];
  const thrown = throwPhase(c.legs[0].to, th, c.secure, t);
  if (thrown) {
    return {
      pos: c.legs[0].to,
      yaw: thrown.yaw,
      pose: 'THROWING',
      cycle: thrown.k,
      intensity: 1,
    };
  }

  // 공을 들고 베이스로 가는 두 번째 구간
  const carry = c.legs[1];
  if (carry && t >= carry.start) {
    const s = legPos(carry, t);
    return {
      pos: s.pos,
      yaw: facing(carry.from, carry.to),
      pose: s.moving ? 'RUNNING' : 'TAG',
      cycle: (s.travelled / RUN_STRIDE) % 1,
      intensity: 1,
    };
  }

  const s = legPos(first, t);
  // 도달 직전/직후에는 포구 자세
  const atBall = t >= first.end - 0.18;
  const waiting = !s.moving || atBall;
  // 아슬아슬하게 닿는 타구는 몸을 던지거나 뛰어오른다
  // 도약 구간: 도달 직전에 시작해 착지까지 이어진다. 그 뒤에는 평소 자세로 돌아간다
  // (끝을 안 주면 한 번 뛰어든 야수가 플레이 내내 엎드려 있다).
  const span = c.dive ? 0.42 : 0.34;
  const effort = c.dive ? 'DIVING' : c.jump ? 'JUMP' : null;
  const effortFrom = first.end - span;
  if (effort && t >= effortFrom && t < effortFrom + span * 1.9) {
    return {
      pos: s.pos,
      yaw: facing(first.from, first.to),
      pose: effort,
      cycle: clamp((t - effortFrom) / (span * 1.9), 0, 1),
      intensity: 1,
    };
  }
  return {
    pos: s.pos,
    // 자리를 잡은 뒤에는 달려온 방향이 아니라 공이 오는 쪽(홈)을 본다
    yaw: waiting ? facing(s.pos, HOME) : facing(first.from, first.to),
    pose: waiting ? (c.caught ? 'CATCHING' : 'FIELDING') : 'RUNNING',
    cycle: (s.travelled / RUN_STRIDE) % 1,
    intensity: 1,
  };
}

/**
 * 시각 t에서 공의 위치. 타구 → 바운드/구르기 → 글러브 → 송구 순서로 이어진다.
 * 아직 타격 직후 비행 중이면 null (호출측이 타구 궤적을 그린다).
 */
export function sampleBallInPlay(tl: PlayTimeline | null, t: number): Vec3 | null {
  if (!tl) return null;
  const field = tl.field;
  const ground = tl.ground;

  // 수비가 붙지 않는 타구(파울/홈런)는 굴러가다 멈추는 것으로 끝난다
  if (!field) return ground && t >= ground.start ? sampleGroundBall(ground, t) : null;

  const c = field.chase;
  if (t < c.reach) {
    if (!ground || t < ground.start) return null; // 아직 공중
    return sampleGroundBall(ground, t);
  }

  for (let i = 0; i < field.throws.length; i++) {
    const th = field.throws[i];
    if (t < th.start) {
      // 중계 플레이 대기 중. 직전 송구를 받은 야수가 베이스에서 들고 있다.
      if (i > 0) return { x: th.from.x, y: 1.1, z: th.from.z };
      break; // 첫 송구 전이면 타구를 잡은 야수가 들고 있다
    }
    if (t <= th.end) return throwPoint(th, t);
    // 이 송구는 끝났다. 다음 송구가 없으면 베이스 위에 남는다.
    if (i === field.throws.length - 1) return { x: th.to.x, y: 1.1, z: th.to.z };
  }

  // 야수가 들고 있는 동안에는 글러브 높이로 따라다닌다
  const held = sampleFielder(field, c.pos, t);
  const at = held?.pos ?? c.legs[0].to;
  // 확보 전(실책으로 더듬는 중)에는 땅에 굴러다닌다
  const y = t < c.secure && !c.caught ? BALL_RADIUS : 1.1;
  return { x: at.x, y, z: at.z };
}

// ---------------------------------------------------------------------------
// 샘플링
// ---------------------------------------------------------------------------

export type RunnerState = 'IDLE' | 'RUNNING' | 'SLIDING' | 'SLIDING_HEAD' | 'CELEBRATE';

export interface RunnerSample {
  pos: Vec3;
  yaw: number;
  state: RunnerState;
  /** 달리기 위상 0~1 */
  cycle: number;
  /** 달리기 강도 (팔다리 진폭) */
  intensity: number;
  /** 슬라이딩 진행도 0~1 */
  slideT: number;
  visible: boolean;
  /** 앞으로 기운 정도(rad). 출발 가속에서 커진다. */
  lean: number;
  /** 베이스를 도는 곡선 안쪽으로 기운 정도(rad) */
  bank: number;
}

/** 베이스를 돌아 나가는 바깥쪽 부풀림 (m) */
function bulgeFor(leg: RunLeg): number {
  if (leg.stop) return leg.from < 0 ? 0.35 : 0.5;
  return 2.6;
}

/** 구간 시작/끝 좌표 */
function legPoints(leg: RunLeg, batsLeft: boolean): [Vec3, Vec3] {
  const a = leg.from < 0 ? bagPoint(-1, batsLeft) : bagPoint(leg.from);
  const b = leg.stop ? baseStation(leg.to) : bagPoint(leg.to);
  return [a, b];
}

const easeOutQuad = (x: number) => 1 - (1 - x) * (1 - x);

/**
 * 곡선 주루의 기울기 (rad).
 *
 * 원심력을 몸으로 버티는 각도 = atan(v^2 / (g * r)). 곡률 반경 r은 2차 베지어의
 * 1·2계 도함수에서 얻는다. 실제 물리를 쓰면 "빠르게 도는 주자일수록 더 눕는다"가
 * 저절로 나온다 — 상수로 넣으면 트로트와 전력질주가 같은 각도로 돈다.
 */
function bankOf(a: Vec3, b: Vec3, ctrl: Vec3, u: number, speed: number): number {
  // 2차 베지어: B'(u) = 2(1-u)(P1-P0) + 2u(P2-P1), B''(u) = 2(P0 - 2P1 + P2)
  const dx = 2 * (1 - u) * (ctrl.x - a.x) + 2 * u * (b.x - ctrl.x);
  const dz = 2 * (1 - u) * (ctrl.z - a.z) + 2 * u * (b.z - ctrl.z);
  const ddx = 2 * (a.x - 2 * ctrl.x + b.x);
  const ddz = 2 * (a.z - 2 * ctrl.z + b.z);
  const sp = Math.hypot(dx, dz);
  if (sp < 1e-4) return 0;
  const cross = dx * ddz - dz * ddx;
  const curv = cross / (sp * sp * sp); // 부호가 도는 방향을 알려 준다
  const lat = speed * speed * curv;
  // 사람이 실제로 낼 수 있는 기울기까지만 (30도)
  return clamp(Math.atan2(lat, GRAVITY), -0.52, 0.52);
}

function quad(a: Vec3, b: Vec3, ctrl: Vec3, u: number): Vec3 {
  const iu = 1 - u;
  return {
    x: iu * iu * a.x + 2 * iu * u * ctrl.x + u * u * b.x,
    y: 0,
    z: iu * iu * a.z + 2 * iu * u * ctrl.z + u * u * b.z,
  };
}

const HIDDEN: RunnerSample = {
  pos: { x: 0, y: 0, z: 0 },
  yaw: 0,
  state: 'IDLE',
  cycle: 0,
  intensity: 0,
  slideT: 0,
  visible: false,
  lean: 0,
  bank: 0,
};

function still(base: number): RunnerSample {
  return {
    pos: baseStation(base),
    yaw: baseFacing(base),
    state: 'IDLE',
    cycle: 0,
    intensity: 0,
    slideT: 0,
    visible: true,
    lean: 0,
    bank: 0,
  };
}

/**
 * 슬라이딩 방향. 2·3루는 헤드퍼스트, 홈과 1루는 발부터.
 *
 * 실제로도 그렇게 갈린다 — 홈은 포수와 부딪히고 1루는 베이스를 밟고 지나가면 되므로
 * 발부터 들어간다. 전부 같은 슬라이딩이면 어느 베이스든 같은 그림이 된다.
 */
function slideStateFor(base: number): RunnerState {
  return base === 1 || base === 2 ? 'SLIDING_HEAD' : 'SLIDING';
}

/** 시각 t에서 주자의 위치/자세 */
export function sampleRunner(anim: RunnerAnim, t: number): RunnerSample {
  if (!anim.legs.length) return HIDDEN;

  const first = anim.legs[0];
  if (t <= first.start) {
    // 아직 출발 전. 타자주자는 타석 모델이 따로 그려지므로 감춘다.
    return first.from < 0 ? HIDDEN : still(first.from);
  }

  // 지금 달리고 있는 구간 찾기
  let leg: RunLeg | null = null;
  let travelled = 0;
  for (const l of anim.legs) {
    if (t < l.end) {
      leg = l;
      break;
    }
    travelled += segmentLength(l, anim.batsLeft);
  }

  if (!leg) {
    // 주루 종료
    const last = anim.legs[anim.legs.length - 1];
    const after = t - anim.finish;
    if (anim.scored) {
      // 홈을 밟고 지나쳐 나간다
      const dir = { x: last.to === 3 ? -0.55 : 0, z: -1 };
      const base = bagPoint(3);
      const k = Math.min(after, 1.4);
      return {
        pos: { x: base.x + dir.x * k * 3.4, y: 0, z: base.z + dir.z * k * 3.4 },
        yaw: Math.atan2(dir.x, dir.z),
        state: after > 0.9 ? 'CELEBRATE' : 'RUNNING',
        cycle: ((travelled + k * 5) / STRIDE) % 1,
        intensity: anim.trot ? 0.45 : 0.8,
        slideT: 0,
        visible: after < 2.2,
        lean: 0,
        bank: 0,
      };
    }
    if (anim.out) {
      const tail = tailPosition(anim, last);
      // 슬라이딩(또는 정지) 자세를 잠깐 유지했다가 사라진다
      if (anim.slide && after < 0.8) {
        return { ...tail, state: slideStateFor(last.to), slideT: clamp(after / 0.8, 0, 1) };
      }
      return { ...tail, visible: after < 1.6 };
    }
    const base = last.to;
    if (anim.slide && after < 0.6) {
      return {
        ...tailPosition(anim, last),
        state: slideStateFor(last.to),
        slideT: clamp(after / 0.6, 0, 1),
        cycle: 0,
        intensity: 0,
        visible: true,
      };
    }
    return still(base);
  }

  const [a, b] = legPoints(leg, anim.batsLeft);
  const u = clamp((t - leg.start) / Math.max(0.01, leg.end - leg.start), 0, 1);
  // 발이 미끄러지지 않도록 실제 이동 거리로 걸음 위상을 만든다
  const segLen = segmentLength(leg, anim.batsLeft);
  const dist = travelled + segLen * u;

  const out = outwardAt(leg.to);
  const bulge = bulgeFor(leg);
  const ctrl: Vec3 = {
    x: (a.x + b.x) / 2 + out.x * bulge,
    y: 0,
    z: (a.z + b.z) / 2 + out.z * bulge,
  };
  const pos = quad(a, b, ctrl, u);
  const ahead = quad(a, b, ctrl, Math.min(1, u + 0.04));
  const yaw = Math.atan2(ahead.x - pos.x, ahead.z - pos.z);

  // 마지막 구간 끝에서 슬라이딩
  const slidePhase = leg.stop && anim.slide ? clamp((u - 0.86) / 0.14, 0, 1) : 0;
  const speed = segLen / Math.max(0.01, leg.end - leg.start); // m/s
  // 출발 직후에는 몸을 앞으로 눕히고, 베이스를 돌 때는 곡선 안쪽으로 기운다.
  // 등속으로 곧게 선 채 미끄러지듯 도는 게 "가짜"로 보이는 큰 이유였다.
  const lean = (1 - easeOutQuad(clamp(u / 0.22, 0, 1))) * 0.34 * clamp(speed / 7, 0, 1);
  const bank = leg.stop ? 0 : bankOf(a, b, ctrl, u, speed);
  return {
    pos,
    yaw,
    state: slidePhase > 0 ? slideStateFor(leg.to) : 'RUNNING',
    cycle: (dist / STRIDE) % 1,
    intensity: clamp((speed - 3.2) / 4.2, 0.35, 1.15),
    slideT: slidePhase,
    lean,
    bank,
    visible: true,
  };
}

/** 마지막 구간 종료 지점 */
function tailPosition(anim: RunnerAnim, last: RunLeg): RunnerSample {
  const [a, b] = legPoints(last, anim.batsLeft);
  const out = outwardAt(last.to);
  const bulge = bulgeFor(last);
  const ctrl: Vec3 = {
    x: (a.x + b.x) / 2 + out.x * bulge,
    y: 0,
    z: (a.z + b.z) / 2 + out.z * bulge,
  };
  const pos = quad(a, b, ctrl, 1);
  const prev = quad(a, b, ctrl, 0.96);
  return {
    pos,
    yaw: Math.atan2(pos.x - prev.x, pos.z - prev.z),
    state: 'IDLE',
    cycle: 0,
    intensity: 0,
    slideT: 1,
    visible: true,
    lean: 0,
    bank: 0,
  };
}

function segmentLength(leg: RunLeg, batsLeft: boolean): number {
  const [a, b] = legPoints(leg, batsLeft);
  const straight = Math.hypot(b.x - a.x, b.z - a.z);
  // 베이스를 도는 구간은 곡선이라 조금 더 길다
  return leg.stop ? straight : straight * 1.06;
}
