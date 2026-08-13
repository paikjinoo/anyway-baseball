import { Rng, clamp, norm } from './rng';
import {
  GRAVITY,
  MOUND_DISTANCE,
  MOUND_HEIGHT,
  PITCH_DEFS,
  ZONE_HALF_HEIGHT,
  ZONE_HALF_WIDTH,
  ZONE_STRIKE_LIMIT,
  ZONE_THIRD,
  worldToZone,
  zoneToWorld,
} from './constants';
import type { BatSide, PitchCommand, PitchTrajectory, Player, Vec3 } from './types';

/**
 * 릴리스 포인트. 폼(사이드암/언더핸드 등)과 좌우 투수에 따라 달라진다.
 *
 * 값은 실제 투수(릴리스 1.9m 안팎)가 아니라 **화면에 그려지는 SD 모델이
 * RELEASE_AT 시점에 손을 두는 위치**를 잰 것이다. 실제 스케일을 쓰면 공이
 * 모델 머리 위 40cm 지점에서 튀어나와 손과 따로 논다. 스트라이크존(0.45~1.06m)도
 * 같은 이유로 모델 스케일에 맞춰져 있다.
 *
 * **투구 포즈를 고치면 이 표를 다시 재야 한다.** 손이 움직였는데 표가 그대로면
 * 공이 손에서 떨어져 나온다. 재는 법은 `poses.jointPositions` + `poses.torsoToModel`로
 * k=RELEASE_AT일 때 던지는 팔(armL) 손의 월드 좌표를 뽑는 것이다.
 * 아래 값은 그렇게 측정했다 (접지 모델을 실제 신발 밑판으로 바꾸면서 모델이
 * 2cm 올라가 높이가 그만큼 커졌다).
 */
export function releasePoint(pitcher: Player): Vec3 {
  const side = pitcher.throws === 'L' ? -1 : 1;
  // form: 0 오버스로 / 1 스리쿼터 / 2 사이드암 / 3 언더핸드 / 4 토네이도
  const heights = [1.4, 1.4, 1.33, 1.16, 1.4];
  const offsets = [0.37, 0.42, 0.48, 0.46, 0.38];
  // 스트라이드로 마운드보다 앞에서 놓는 거리 (익스텐션)
  const extension = [0.58, 0.51, 0.4, 0.32, 0.57];
  const f = clamp(pitcher.form, 0, 4);
  return {
    x: side * offsets[f],
    y: heights[f] + MOUND_HEIGHT,
    z: MOUND_DISTANCE - extension[f],
  };
}

/** 그 구종의 능력치. 던질 줄 모르는 구종이면 직구로 대신한다. */
function attrOf(pitcher: Player, type: PitchCommand['type']) {
  return (
    pitcher.pitching?.arsenal[type] ??
    pitcher.pitching?.arsenal.FOURSEAM ?? { velocity: 30, control: 30, movement: 20 }
  );
}

/**
 * 이 투수가 완전히 회복된 상태에서 버틸 수 있는 투구 수.
 * 스태미나 100이면 약 112구.
 */
export function pitchCapacity(pitcher: Player): number {
  return 34 + (pitcher.pitching?.stamina ?? 40) * 0.78;
}

/**
 * 이번 경기 투구 수에 **경기 사이에 이월된 피로**를 더한 유효 투구 수.
 *
 * Player.fatigue(0~1)는 지난 경기에서 남은 피로다. 1이면 던지기도 전에 한계에 도달한 상태로
 * 마운드에 오른다. 이 한 줄로 아래 fatigueOf/staminaRemaining을 쓰는 모든 곳
 * (HUD 게이지, CPU 교체 판단, pitcherIsTired, 3D 씬)이 함께 따라온다.
 */
function effectivePitches(pitcher: Player, pitchesThrown: number): number {
  return pitchesThrown + (pitcher.fatigue ?? 0) * pitchCapacity(pitcher);
}

/** 투구 수에 따른 피로도 (0~1). 스태미나 100 기준 약 110구까지 버틴다. */
function fatigueOf(pitcher: Player, pitchesThrown: number): number {
  const capacity = pitchCapacity(pitcher);
  return clamp((effectivePitches(pitcher, pitchesThrown) - capacity * 0.6) / capacity, 0, 1);
}

/**
 * 제구 산포. 노린 지점에서 실제 도착점이 흩어지는 정도(존 좌표계 표준편차)다.
 *
 * 존 반폭이 1이므로 sigma 0.4면 대체로 노린 사분면 근처에 들어간다.
 * control 99 -> 0.40, control 50 -> 0.72, control 0 -> 1.05
 */
export function controlSpread(
  pitcher: Player,
  cmd: PitchCommand,
  pitchesThrown: number,
): { x: number; y: number } {
  const def = PITCH_DEFS[cmd.type];
  let sigma = 1.06 - 0.62 * norm(attrOf(pitcher, cmd.type).control);
  sigma *= 1 + fatigueOf(pitcher, pitchesThrown) * 0.5;
  sigma *= 1 + def.difficulty * 0.06;
  if (cmd.quickPitch) sigma *= 1.35; // 퀵모션은 제구가 나빠진다
  if (cmd.type === 'KNUCKLE') sigma *= 1.5;
  return { x: sigma, y: sigma * 0.92 };
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
  const attr = attrOf(pitcher, cmd.type);
  const fatigue = fatigueOf(pitcher, pitchesThrown);

  // --- 구속 -------------------------------------------------------------
  const veloStat = norm(attr.velocity);
  let velocity = def.baseVelo + def.veloRange * veloStat;
  velocity *= 1 - fatigue * 0.055;
  velocity += rng.normal(0, 1.6);
  velocity = clamp(velocity, 80, 172);

  // --- 제구 -------------------------------------------------------------
  const spread = controlSpread(pitcher, cmd, pitchesThrown);
  const zoneX = cmd.targetX + rng.normal(0, spread.x);
  const zoneY = cmd.targetY + rng.normal(0, spread.y);

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

  const isStrikeZone =
    Math.abs(zoneX) <= ZONE_STRIKE_LIMIT && Math.abs(zoneY) <= ZONE_STRIKE_LIMIT;

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

/**
 * 난수를 전부 평균값으로 돌려주는 난수원. 상태를 갖지 않으므로 몇 번을 뽑아도 같다.
 * 실제 투구와 같은 계산식을 쓰되 흔들림만 지우고 싶을 때 쓴다.
 */
class MeanRng extends Rng {
  constructor() {
    super(0);
  }
  next(): number {
    return 0.5;
  }
  gauss(): number {
    return 0;
  }
}

/**
 * 투구 전에 보여 주는 예상 궤적.
 *
 * 실제 투구(computePitch)와 같은 계산이지만 난수 — 제구 산포·구속 편차·무브먼트
 * 흔들림 — 만 0으로 둔 평균 궤적이다. 따라서 도착점은 노린 지점과 정확히 같고,
 * 실제 공은 이 선 주위로 controlSpread 만큼 흩어진다.
 *
 * 게임 RNG를 건드리지 않으므로 몇 번을 불러도 이후 투구 결과가 달라지지 않는다.
 */
export function previewPitch(
  pitcher: Player,
  cmd: PitchCommand,
  pitchesThrown: number,
): PitchTrajectory {
  return computePitch(new MeanRng(), pitcher, cmd, pitchesThrown);
}

/** 구종 무브먼트를 화면에서 읽히게 하는 과장 배수 */
const BREAK_GAIN = 1.25;

/**
 * 투구 궤적상의 위치. t는 0(릴리스)~1(홈플레이트).
 *
 * 실제 투구와 같은 모델이다. 공은 릴리스에서 어떤 방향으로 던져진 뒤 일정한 가속도
 * (중력 + 매그너스)를 받으므로, 그 변위는 시간의 제곱에 비례해 쌓인다.
 * 도착점(plate)은 판정에 쓰인 지점으로 고정돼 있으므로 던지는 방향을 역산하면
 *
 *   pos(u) = release + (plate - release)·u - D·(u - u²),   D = 총 변위(무회전 직선 대비)
 *
 * 가 되고, 현(릴리스→플레이트) 대비 편차는 u=0.5에서 D/4로 최대가 된다.
 *
 * 세로 변위 D_y는 아래로 g·T²/2 만큼인데, 백스핀 양력(vBreak)이 그만큼 상쇄한다.
 * 직구는 vBreak가 커서 중력 낙하의 절반 이상이 지워져 거의 직선으로 보이고,
 * 느린 커브는 T가 커진 데다 vBreak가 음수라 낙차가 크게 남는다.
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

/**
 * 존 좌표 -> 화면 표시용 문자열 (실황 텍스트)
 *
 * **몸쪽/바깥쪽 표기는 우타자 기준이다.** 좌타 타석에서는 실제로 반대편이므로
 * 코스별 기록에는 이 함수를 쓰지 않는다 (@see zoneCell).
 */
export function describeLocation(zx: number, zy: number): string {
  if (Math.abs(zx) > ZONE_STRIKE_LIMIT || Math.abs(zy) > ZONE_STRIKE_LIMIT) {
    const parts: string[] = [];
    if (zy > ZONE_STRIKE_LIMIT) parts.push('높은');
    else if (zy < -ZONE_STRIKE_LIMIT) parts.push('낮은');
    if (zx > ZONE_STRIKE_LIMIT) parts.push('바깥쪽');
    else if (zx < -ZONE_STRIKE_LIMIT) parts.push('몸쪽');
    return `${parts.join(' ')} 코스`;
  }
  const v = zy > ZONE_THIRD ? '높은' : zy < -ZONE_THIRD ? '낮은' : '가운데';
  const h = zx > ZONE_THIRD ? '바깥쪽' : zx < -ZONE_THIRD ? '몸쪽' : '한복판';
  return v === '가운데' && h === '한복판' ? '한복판' : `${v} ${h}`;
}

/**
 * 투구 위치를 3×3 코스 칸(0~8)으로 나눈다.
 *
 * **타자 기준이다** — 같은 zoneX가 우타에게는 바깥쪽, 좌타에게는 몸쪽이므로 좌타는
 * 좌우를 접어 넣는다. 스위치히터가 매 타석 반대편에 서도 약점이 한 칸에 모이려면
 * 이 기준이어야 한다. 호출하는 쪽은 batter.bats가 아니라 반드시
 * batting.effectiveBatSide()를 넘겨야 한다 ('S'가 그대로 오면 우타로 처리된다).
 *
 * 존 밖 공도 버리지 않고 가장 가까운 가장자리 칸에 넣는다. 낮은 바깥쪽 유인구에
 * 속아 삼진당한 것도 그 코스의 약점이고, 그래야 **9칸 타수 합 = 실제 타수**라는
 * 불변식이 성립해 집계 누락을 테스트로 잡을 수 있다.
 *
 * ```
 *   0 높은 몸쪽   1 높은 한복판   2 높은 바깥쪽
 *   3 몸쪽        4 한복판        5 바깥쪽
 *   6 낮은 몸쪽   7 낮은 한복판   8 낮은 바깥쪽
 * ```
 */
export function zoneCell(zoneX: number, zoneY: number, batSide: BatSide): number {
  // rx < 0 이 늘 몸쪽이 되도록 좌타에서 뒤집는다.
  const rx = batSide === 'L' ? -zoneX : zoneX;
  const col = rx > ZONE_THIRD ? 2 : rx < -ZONE_THIRD ? 0 : 1;
  const row = zoneY > ZONE_THIRD ? 0 : zoneY < -ZONE_THIRD ? 2 : 1;
  return row * 3 + col;
}

/**
 * 화면의 3×3 그리드 칸(0~8, 좌상단부터) -> 기록된 코스 칸 번호.
 *
 * 좌우를 **두 번** 뒤집는다. 하나만 적용하면 절반의 경우에만 맞아서 눈으로도 잘 안 잡힌다.
 *   - mirrored: 카메라가 존을 좌우 반전해 보여주는가 (PitchPanel의 목표 마커와 같은 부호)
 *   - batSide: zoneCell이 타자 기준으로 접어 저장했으므로 화면 기준으로 되돌린다
 *
 * 세로는 어느 쪽도 뒤집지 않는다 — 패널 위쪽은 늘 높은 공이다.
 */
export function screenCellToZoneCell(i: number, batSide: BatSide, mirrored: boolean): number {
  const sb = batSide === 'L' ? -1 : 1;
  const sx = mirrored ? -1 : 1;
  return Math.floor(i / 3) * 3 + (1 + sb * sx * ((i % 3) - 1));
}

/**
 * 칸 번호 -> 한글 이름. 툴팁과 스크린리더용.
 *
 * 우타 기준 describeLocation이 내놓는 문구와 **한 글자까지 같다.** 실황이 "가운데 바깥쪽"이라
 * 말한 공이 히트맵 툴팁에서는 "바깥쪽"이면 같은 것을 가리키는지 알 수 없기 때문이다.
 * zone.test.ts가 둘을 맞대어 고정한다.
 */
export const ZONE_CELL_KO: readonly string[] = [
  '높은 몸쪽',
  '높은 한복판',
  '높은 바깥쪽',
  '가운데 몸쪽',
  '한복판',
  '가운데 바깥쪽',
  '낮은 몸쪽',
  '낮은 한복판',
  '낮은 바깥쪽',
];

/** 투수의 보유 구종 목록 */
export function arsenalOf(p: Player) {
  const a = p.pitching?.arsenal ?? {};
  return (Object.keys(a) as (keyof typeof a)[])
    .filter((k) => a[k])
    .map((k) => ({ type: k!, attr: a[k]!, def: PITCH_DEFS[k!] }));
}

/** 남은 스태미나 비율 (0~1). 경기 사이에 이월된 피로가 이미 반영돼 있다. */
export function staminaRemaining(pitcher: Player, pitches: number): number {
  return clamp(1 - effectivePitches(pitcher, pitches) / pitchCapacity(pitcher), 0, 1);
}

export { ZONE_HALF_WIDTH, ZONE_HALF_HEIGHT, worldToZone };
