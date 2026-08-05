import { Rng, clamp, lerp, norm } from './rng';
import { BAT_DEFS, PITCH_DEFS, SWING_DEFS } from './constants';
import type { BattedBall, PitchTrajectory, Player, SwingCommand, Vec3 } from './types';
import { GRAVITY, DRAG_K, LIFT_K, FENCE_HEIGHT, fenceDistance } from './constants';

// ---------------------------------------------------------------------------
// 스윙 판정
// ---------------------------------------------------------------------------

export type SwingOutcome =
  | { kind: 'WHIFF' }
  | { kind: 'FOUL_TIP' }
  | { kind: 'CONTACT'; quality: number; timingErr: number; spatialErr: number };

/** 장비 보정을 적용한 실효 능력치 */
export function effectiveBatting(p: Player) {
  const bat = BAT_DEFS.find((b) => b.id === p.gear.bat);
  // 타격 자세 보정: 0 스탠다드 / 1 오픈 / 2 클로즈드 / 3 크라우칭 / 4 레그킥 / 5 노스텝
  const stanceContact = [0, -1, 1, 2, -2, 3][clamp(p.stance, 0, 5)];
  const stancePower = [0, 2, -1, -2, 4, -2][clamp(p.stance, 0, 5)];
  const stanceEye = [0, 1, 0, 2, -2, 1][clamp(p.stance, 0, 5)];
  return {
    contact: clamp(p.batting.contact + (bat?.contactMod ?? 0) + stanceContact, 1, 99),
    power: clamp(p.batting.power + (bat?.powerMod ?? 0) + stancePower, 1, 99),
    eye: clamp(p.batting.eye + stanceEye, 1, 99),
    speed: p.batting.speed,
    fielding: p.batting.fielding,
    arm: p.batting.arm,
  };
}

/**
 * 스윙 결과 판정.
 *
 * 두 축으로 평가한다.
 *  - 공간 오차: 배트 조준점과 실제 공 도착점의 거리 (존 좌표계)
 *  - 시간 오차: 스윙 타이밍 (ms)
 * 두 오차가 모두 허용 범위 안이면 컨택. quality(0~1)는 두 오차의 정확도.
 */
export function judgeSwing(
  rng: Rng,
  batter: Player,
  pitcher: Player,
  traj: PitchTrajectory,
  swing: SwingCommand,
): SwingOutcome {
  const def = SWING_DEFS[swing.type];
  const eb = effectiveBatting(batter);
  const contactStat = norm(eb.contact);
  const eyeStat = norm(eb.eye);

  // --- 공간 판정 ---------------------------------------------------------
  // 컨택 능력치가 높을수록 배트 판정 반경이 커진다.
  const radius = def.contactRadius * (0.62 + 0.72 * contactStat);
  const dx = swing.aimX - traj.zoneX;
  const dy = swing.aimY - traj.zoneY;
  const spatialErr = Math.hypot(dx, dy * 0.92);

  // 무브먼트가 큰 공은 조준을 어긋나게 만든다 (선구안으로 일부 상쇄)
  const pAttr = pitcher.pitching?.arsenal[traj.type];
  const moveStat = norm(pAttr?.movement ?? 40);
  const deceive = clamp(moveStat * 0.55 - eyeStat * 0.4, 0, 0.5) * PITCH_DEFS[traj.type].difficulty * 0.42;
  const effSpatial = spatialErr + rng.range(0, deceive);

  if (effSpatial > radius) return { kind: 'WHIFF' };

  // --- 시간 판정 ---------------------------------------------------------
  // 빠른 공일수록 타이밍 창이 좁아진다.
  const veloFactor = clamp(1.42 - traj.velocity / 150, 0.6, 1.25);
  const window = def.timingWindow * veloFactor * (0.68 + 0.6 * contactStat);
  const timingErr = Math.abs(swing.timingMs);
  if (timingErr > window * 1.55) return { kind: 'WHIFF' };

  // --- 품질 계산 ---------------------------------------------------------
  // 0.15의 기본값을 주는 이유: 배트에 맞은 이상 최소한의 타구는 나가야 한다.
  // (이 값이 없으면 타구속도 분포 전체가 실제 야구보다 크게 낮아진다)
  const spatialQ = 1 - clamp(effSpatial / radius, 0, 1);
  const timingQ = 1 - clamp(timingErr / window, 0, 1.3);
  let quality = clamp(0.15 + spatialQ * 0.44 + timingQ * 0.5, 0, 1);

  // 헛스윙 보정: 품질이 매우 낮으면 확률적으로 헛스윙/파울팁
  const whiffP = clamp((0.42 - quality) * 1.55 + def.whiffBias, 0, 0.8);
  if (rng.chance(whiffP)) {
    return rng.chance(0.35) ? { kind: 'FOUL_TIP' } : { kind: 'WHIFF' };
  }

  quality = clamp(quality * rng.range(0.9, 1.08), 0, 1);
  return { kind: 'CONTACT', quality, timingErr: swing.timingMs, spatialErr: effSpatial };
}

// ---------------------------------------------------------------------------
// 타구 생성
// ---------------------------------------------------------------------------

/**
 * 컨택 품질 -> 타구.
 *
 * quality가 1에 가까울수록 배럴(이상적 발사각 + 최대 타구속도)에 가깝고,
 * 낮을수록 빗맞은 땅볼/뜬공이 된다.
 * 타이밍이 이르면 당겨치고(pull), 늦으면 밀어친다.
 */
export function makeBattedBall(
  rng: Rng,
  batter: Player,
  swing: SwingCommand,
  traj: PitchTrajectory,
  quality: number,
  timingErr: number,
): BattedBall {
  const def = SWING_DEFS[swing.type];
  const eb = effectiveBatting(batter);
  const powerStat = norm(eb.power);
  const isLefty = batter.bats === 'L' || (batter.bats === 'S' && true);

  // --- 타구 속도 ---------------------------------------------------------
  // quality는 대략 [0.2, 1.0] 균등분포로 나온다. 이 구간을 실제 MLB의
  // 타구속도 분위수(10% 80 / 50% 140 / 90% 178 km/h)에 선형으로 대응시킨다.
  let exit = (56 + 115 * quality) * (0.82 + 0.36 * powerStat) * def.powerMult;
  // 투구 구속의 일부가 반발로 실린다
  exit += traj.velocity * 0.05 * quality;
  exit *= rng.range(0.93, 1.07);
  exit = clamp(exit, 22, 196);

  // --- 발사각 -----------------------------------------------------------
  // 조준점이 공보다 아래면 퍼올려서 뜬공, 위면 눌러쳐서 땅볼.
  //
  // 실제 타구의 발사각은 평균 약 12도, 표준편차 약 23도로 매우 넓게 퍼진다.
  // (땅볼 44% / 라인드라이브 21% / 뜬공 26% / 팝업 9%)
  // 분산이 좁으면 라인드라이브만 쏟아져 타율이 비현실적으로 치솟는다.
  const vertOffset = swing.aimY - traj.zoneY; // + 이면 배트가 공 위
  let launch = 11 - vertOffset * 38 + rng.normal(0, 19);
  // 품질이 좋을수록 이상적 발사각으로 수렴하되, 너무 강하게 끌어당기면
  // 잘 맞은 타구가 전부 홈런 각도로 몰린다.
  launch = lerp(launch, 20 + rng.normal(0, 8), quality * 0.28);
  if (swing.type === 'POWER') launch += 4;
  if (swing.type === 'BUNT') launch = rng.range(-16, 6);
  launch = clamp(launch, -70, 88);

  // --- 좌우 방향 ---------------------------------------------------------
  // 타이밍이 이르면(-) 당겨친다. 우타자는 좌측(-), 좌타자는 우측(+).
  // 타이밍이 어긋나면 파울 지역(±45도 밖)으로 나가야 한다.
  // 실제 야구에서 스윙의 약 38%가 파울이 되므로 이 계수가 작으면
  // 타석이 너무 빨리 끝나 삼진이 급감하고 안타가 폭증한다.
  const pullDir = isLefty ? 1 : -1;
  const timingRatio = clamp(-timingErr / 110, -1.8, 1.8);
  let spray = timingRatio * 78 * pullDir;
  // 조준점 좌우도 방향에 영향
  spray += (swing.aimX - traj.zoneX) * 14 * pullDir;
  spray += rng.normal(0, 19 * (1.3 - quality * 0.6));
  if (swing.type === 'BUNT') spray = clamp(spray * 0.6 + rng.normal(0, 20), -70, 70);
  // ±115도까지: 포수 뒤로 넘어가는 파울까지 포함한다
  spray = clamp(spray, -115, 115);

  // 번트는 무조건 약한 땅볼
  if (swing.type === 'BUNT') {
    exit = clamp(exit, 18, 52);
  }

  const kind: BattedBall['kind'] =
    swing.type === 'BUNT'
      ? 'BUNT'
      : launch < 8
        ? 'GROUNDER'
        : launch < 26
          ? 'LINE_DRIVE'
          : launch < 52
            ? 'FLY'
            : 'POPUP';

  const flight = simulateFlight(exit / 3.6, launch, spray);

  return {
    exitVelocity: Math.round(exit * 10) / 10,
    launchAngle: Math.round(launch * 10) / 10,
    sprayAngle: Math.round(spray * 10) / 10,
    hangTime: flight.hangTime,
    landing: flight.landing,
    landingVel: flight.landingVel,
    distance: flight.distance,
    kind,
    path: flight.path,
    overFence: flight.overFence,
    hitFence: flight.hitFence,
  };
}

// ---------------------------------------------------------------------------
// 타구 궤적 시뮬레이션 (항력 + 양력 포함 오일러 적분)
// ---------------------------------------------------------------------------

export interface FlightResult {
  hangTime: number;
  landing: Vec3;
  /** 착지(또는 담장 충돌) 순간의 속도. 바운드 연출의 초기 조건. */
  landingVel: Vec3;
  distance: number;
  path: Vec3[];
  /** 펜스를 넘겼는지 */
  overFence: boolean;
  /** 펜스 맞고 튄 경우 */
  hitFence: boolean;
}

export function simulateFlight(speedMps: number, launchDeg: number, sprayDeg: number): FlightResult {
  const la = (launchDeg * Math.PI) / 180;
  const sa = (sprayDeg * Math.PI) / 180;

  const horiz = speedMps * Math.cos(la);
  // sprayAngle은 +가 우익 방향이고 월드 +X는 3루(좌익) 방향이라 부호가 반대다
  let vx = -horiz * Math.sin(sa);
  let vz = horiz * Math.cos(sa);
  let vy = speedMps * Math.sin(la);

  let x = 0;
  let y = 1.0; // 타격 지점 높이
  let z = 0.3;

  const dt = 1 / 120;
  const path: Vec3[] = [{ x, y, z }];
  let t = 0;
  let overFence = false;
  let hitFence = false;
  // 담장에 맞은 경우의 위치/시각. 이후 수비는 이 지점을 기준으로 한다.
  let fencePoint: Vec3 | null = null;
  let fenceVel: Vec3 | null = null;
  let fenceTime = 0;

  while (t < 12) {
    const v = Math.hypot(vx, vy, vz);
    const drag = DRAG_K * v;
    const lift = LIFT_K * v * v;

    vx -= vx * drag * dt;
    vz -= vz * drag * dt;
    vy += (-GRAVITY + lift - vy * drag) * dt;

    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    t += dt;

    if (path.length < 400 && Math.round(t / dt) % 3 === 0) path.push({ x, y, z });

    // 담장 통과 판정. 궤적은 멈추지 않고 통과 시점의 높이만 기록한다.
    // (여기서 break 하면 비거리가 담장 거리에서 잘려 홈런 판정이 불가능해진다)
    if (!overFence && !hitFence) {
      const r = Math.hypot(x, z);
      const theta = Math.atan2(x, z);
      if (Math.abs(theta) <= Math.PI / 4 + 0.02 && r >= fenceDistance(theta)) {
        if (y > FENCE_HEIGHT) {
          overFence = true;
        } else {
          hitFence = true;
          fencePoint = { x, y, z };
          fenceVel = { x: vx, y: vy, z: vz };
          fenceTime = t;
        }
      }
    }

    if (y <= 0) {
      y = 0;
      break;
    }
    // 담장을 맞았으면 더 계산할 필요가 없다
    if (hitFence) break;
  }

  path.push({ x, y: Math.max(0, y), z });

  const landing = fencePoint ?? { x, y: Math.max(0, y), z };
  return {
    hangTime: fencePoint ? fenceTime : t,
    landing,
    landingVel: fenceVel ?? { x: vx, y: vy, z: vz },
    distance: Math.hypot(landing.x, landing.z),
    path,
    overFence,
    hitFence,
  };
}

/** 파울 여부: 좌우 45도를 벗어나면 파울 */
export function isFoul(sprayAngle: number): boolean {
  return Math.abs(sprayAngle) > 45;
}

/** 타구 속도/각도로부터 사람이 읽는 설명 */
export function describeBattedBall(bb: BattedBall): string {
  if (bb.kind === 'BUNT') return '번트 타구';
  if (bb.kind === 'GROUNDER') return bb.exitVelocity > 130 ? '강한 땅볼' : '평범한 땅볼';
  if (bb.kind === 'LINE_DRIVE') return bb.exitVelocity > 150 ? '총알 같은 라인드라이브' : '라인드라이브';
  if (bb.kind === 'POPUP') return '높이 뜬 공';
  return bb.distance > 100 ? '큼지막한 타구' : '외야 뜬공';
}

export { SWING_DEFS };
