import { Rng, clamp, norm } from './rng';
import {
  GRAVITY,
  MOUND_DISTANCE,
  MOUND_HEIGHT,
  PITCH_DEFS,
  ZONE_HALF_HEIGHT,
  ZONE_HALF_WIDTH,
  worldToZone,
  zoneToWorld,
} from './constants';
import type { PitchCommand, PitchTrajectory, Player, Vec3 } from './types';

/** 릴리스 포인트. 폼(사이드암/언더핸드 등)과 좌우 투수에 따라 달라진다. */
export function releasePoint(pitcher: Player): Vec3 {
  const side = pitcher.throws === 'L' ? -1 : 1;
  // form: 0 오버스로 / 1 스리쿼터 / 2 사이드암 / 3 언더핸드 / 4 토네이도
  const heights = [1.95, 1.78, 1.42, 1.05, 1.86];
  const offsets = [0.28, 0.52, 0.92, 1.05, 0.42];
  const f = clamp(pitcher.form, 0, 4);
  return {
    x: side * offsets[f],
    y: heights[f] + MOUND_HEIGHT,
    z: MOUND_DISTANCE - 1.5, // 익스텐션만큼 앞에서 놓는다
  };
}

/**
 * 1구를 계산한다.
 *
 * 제구(control)가 낮을수록 목표 지점 대비 산포가 커지고,
 * 구속(velocity)은 구종 기본 구속 + 능력치 + 소량의 랜덤,
 * 무브먼트(movement)는 궤적 변화량을 결정한다.
 * 스태미나가 떨어지면 구속/제구가 함께 나빠진다.
 */
export function computePitch(
  rng: Rng,
  pitcher: Player,
  cmd: PitchCommand,
  pitchesThrown: number,
): PitchTrajectory {
  const def = PITCH_DEFS[cmd.type];
  const attr = pitcher.pitching?.arsenal[cmd.type] ??
    pitcher.pitching?.arsenal.FOURSEAM ?? { velocity: 30, control: 30, movement: 20 };

  // --- 피로도 -----------------------------------------------------------
  const stamina = pitcher.pitching?.stamina ?? 40;
  // 스태미나 100 기준 약 110구까지 버틴다.
  const capacity = 34 + stamina * 0.78;
  const fatigue = clamp((pitchesThrown - capacity * 0.6) / capacity, 0, 1);

  // --- 구속 -------------------------------------------------------------
  const veloStat = norm(attr.velocity);
  let velocity = def.baseVelo + def.veloRange * veloStat;
  velocity *= 1 - fatigue * 0.055;
  velocity += rng.normal(0, 1.6);
  velocity = clamp(velocity, 80, 172);

  // --- 제구 -------------------------------------------------------------
  const ctrlStat = norm(attr.control);
  // 존 반폭이 1이므로 sigma 0.4면 대체로 노린 사분면 근처에 들어간다.
  // control 99 -> 0.40, control 50 -> 0.72, control 0 -> 1.05
  let sigma = 1.06 - 0.62 * ctrlStat;
  sigma *= 1 + fatigue * 0.5;
  sigma *= 1 + def.difficulty * 0.06;
  if (cmd.quickPitch) sigma *= 1.35; // 퀵모션은 제구가 나빠진다
  if (cmd.type === 'KNUCKLE') sigma *= 1.5;

  const zoneX = cmd.targetX + rng.normal(0, sigma);
  const zoneY = cmd.targetY + rng.normal(0, sigma * 0.92);

  // --- 무브먼트 ----------------------------------------------------------
  const moveStat = norm(attr.movement);
  const armSide = pitcher.throws === 'L' ? -1 : 1;
  const moveScale = 0.55 + 0.9 * moveStat;
  let breakX = def.hBreak * moveScale * armSide;
  let breakY = def.vBreak * moveScale;
  if (cmd.type === 'KNUCKLE') {
    breakX += rng.normal(0, 0.28);
    breakY += rng.normal(0, 0.24);
  }
  breakX += rng.normal(0, 0.03);
  breakY += rng.normal(0, 0.03);

  // --- 좌표/시간 ---------------------------------------------------------
  const release = releasePoint(pitcher);
  const plateWorld = zoneToWorld(zoneX, zoneY);
  const plate: Vec3 = { x: plateWorld.x, y: Math.max(0.05, plateWorld.y), z: 0 };

  const mps = velocity / 3.6;
  // 릴리스에서 홈까지의 직선 거리. 실제 감속을 감안해 평균 속도는 약 92%.
  const dist = Math.hypot(release.x - plate.x, release.y - plate.y, release.z - plate.z);
  const flightTime = dist / (mps * 0.92);

  const isStrikeZone = Math.abs(zoneX) <= 1.06 && Math.abs(zoneY) <= 1.06;

  return {
    type: cmd.type,
    velocity: Math.round(velocity * 10) / 10,
    release,
    plate,
    breakX,
    breakY,
    flightTime,
    zoneX,
    zoneY,
    isStrikeZone,
  };
}

/** 구종 무브먼트를 화면에서 읽히게 하는 과장 배수 */
const BREAK_GAIN = 1.25;

/**
 * 투구 궤적상의 위치. t는 0(릴리스)~1(홈플레이트).
 *
 * 양 끝점이 고정된 포물선이다. 즉 공은 **반드시 plate(판정에 쓰인 지점)에 도착**하고,
 * 릴리스 직후의 겉보기 직선에서 u^2에 비례해 벌어지는 편차가 "휘어짐"으로 보인다.
 * (직선 + break*u^2 로 그리면 공이 판정 지점이 아닌 곳으로 지나가 버린다)
 *
 * 세로 편차는 중력 g·T²/2 에서 구종의 vBreak를 뺀 값이다. 느린 공일수록 T가 커져
 * 자동으로 낙차가 커지므로, 커브와 직구의 궤적이 눈에 띄게 달라진다.
 */
export function pitchPositionAt(traj: PitchTrajectory, t: number): Vec3 {
  const u = clamp(t, 0, 1);
  const { release: r, plate: p } = traj;
  const T = traj.flightTime;
  // 현(release→plate) 대비 편차. u=0, u=1에서 0이고 중간에서 최대.
  const arc = u - u * u;
  const drop = (GRAVITY * T * T) / 2 - traj.breakY * BREAK_GAIN;
  return {
    x: r.x + (p.x - r.x) * u - traj.breakX * BREAK_GAIN * arc,
    y: r.y + (p.y - r.y) * u + drop * arc,
    z: r.z + (p.z - r.z) * u,
  };
}

/** 미트 뒤로 통과하는 연출까지 포함한 확장 궤적 (t는 0~1.25) */
export function pitchPositionExtended(traj: PitchTrajectory, t: number): Vec3 {
  if (t <= 1) return pitchPositionAt(traj, t);
  const a = pitchPositionAt(traj, 0.98);
  const b = pitchPositionAt(traj, 1);
  const k = (t - 1) / 0.25;
  return {
    x: b.x + (b.x - a.x) * k * 12,
    y: b.y + (b.y - a.y) * k * 12,
    z: b.z + (b.z - a.z) * k * 12,
  };
}

/** 존 좌표 -> 화면 표시용 문자열 (실황 텍스트) */
export function describeLocation(zx: number, zy: number): string {
  if (Math.abs(zx) > 1.06 || Math.abs(zy) > 1.06) {
    const parts: string[] = [];
    if (zy > 1.06) parts.push('높은');
    else if (zy < -1.06) parts.push('낮은');
    if (zx > 1.06) parts.push('바깥쪽');
    else if (zx < -1.06) parts.push('몸쪽');
    return `${parts.join(' ')} 코스`;
  }
  const v = zy > 0.35 ? '높은' : zy < -0.35 ? '낮은' : '가운데';
  const h = zx > 0.35 ? '바깥쪽' : zx < -0.35 ? '몸쪽' : '한복판';
  return v === '가운데' && h === '한복판' ? '한복판' : `${v} ${h}`;
}

/** 투수의 보유 구종 목록 */
export function arsenalOf(p: Player) {
  const a = p.pitching?.arsenal ?? {};
  return (Object.keys(a) as (keyof typeof a)[])
    .filter((k) => a[k])
    .map((k) => ({ type: k!, attr: a[k]!, def: PITCH_DEFS[k!] }));
}

/** 남은 스태미나 비율 (0~1) */
export function staminaRemaining(pitcher: Player, pitches: number): number {
  const stamina = pitcher.pitching?.stamina ?? 40;
  const capacity = 34 + stamina * 0.78;
  return clamp(1 - pitches / capacity, 0, 1);
}

export { ZONE_HALF_WIDTH, ZONE_HALF_HEIGHT, worldToZone };
