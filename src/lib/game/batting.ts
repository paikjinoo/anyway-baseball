import { Rng, clamp, lerp, norm } from './rng';
import { BAT_DEFS, BODY_BY_ID, PITCH_DEFS, SWING_DEFS } from './constants';
import type {
  BattedBall,
  Handedness,
  PitchTrajectory,
  Player,
  SwingCommand,
  Vec3,
} from './types';
import { GRAVITY, DRAG_K, MAGNUS_K, SIDESPIN_K, FENCE_HEIGHT, fenceDistance } from './constants';

// ---------------------------------------------------------------------------
// 스윙 판정
// ---------------------------------------------------------------------------

export type SwingOutcome =
  | { kind: 'WHIFF' }
  | { kind: 'FOUL_TIP' }
  | { kind: 'CONTACT'; quality: number; timingErr: number; spatialErr: number };

/**
 * 체형 보정. 파워와 스피드를 맞바꾼다.
 * 투수는 체형 선택이 없으므로 항상 0이다.
 */
export function bodyMod(p: Player): { power: number; speed: number } {
  const def = BODY_BY_ID[p.body ?? 'NORMAL'];
  if (!def || p.kind === 'PITCHER') return { power: 0, speed: 0 };
  return { power: def.powerMod, speed: def.speedMod };
}

/**
 * 체형 보정이 들어간 실효 스피드.
 *
 * 주루·수비 코드가 `p.batting.speed`를 직접 읽으면 체형 보정이 타격에만 걸리고 발에는
 * 안 걸리는 반쪽짜리가 된다. 스피드를 보는 곳은 전부 이 함수를 지난다.
 */
export function effSpeed(p: Player): number {
  return clamp(p.batting.speed + bodyMod(p).speed, 1, 99);
}

// ---------------------------------------------------------------------------
// 부상 보정 (컨디션 난조)
// ---------------------------------------------------------------------------

/** 부상 잔여 1경기당 깎이는 능력치 비율 */
export const INJURY_PENALTY_PER_GAME = 0.05;
/** 아무리 심해도 여기까지만 깎는다 */
export const INJURY_PENALTY_MAX = 0.25;

/**
 * 부상으로 깎이는 능력치 비율 (0~0.25).
 *
 * 부상은 출전을 막지 않는다. 몸이 덜 풀린 채로 뛰는 것에 가깝게, **남은 경기 수에 비례해**
 * 깎는다 — 갓 다쳤을 때가 가장 나쁘고 회복이 가까워질수록 옅어져서, 낫는 중이라는 게
 * 숫자로 보인다. 사구 타박(1~3경기)은 5~15%, 투구 과부하(2~5경기)는 10~25%로 자연히 갈린다.
 */
export function injuryPenalty(p: Player): number {
  const left = p.injury?.gamesLeft ?? 0;
  if (left <= 0) return 0;
  return Math.min(INJURY_PENALTY_MAX, left * INJURY_PENALTY_PER_GAME);
}

/**
 * 부상 보정이 들어간 사본. 성한 선수는 원본을 그대로 돌려준다.
 *
 * **경기 로스터를 만들 때 딱 한 번 통과시킨다** (engine.toTeamInGame). 그러면 타격·투구·수비·
 * 주루·AI가 전부 깎인 값을 읽는다. 읽는 쪽마다 보정을 거는 방식은 effSpeed 주석에 적힌 것과
 * 같은 이유로 반드시 어딘가 새고, 그때는 "타격만 깎이고 발은 멀쩡한" 반쪽이 된다.
 */
export function withInjuryPenalty(p: Player): Player {
  const cut = injuryPenalty(p);
  if (cut <= 0) return p;

  const k = 1 - cut;
  const scale = (v: number) => Math.max(1, Math.round(v * k));

  const next: Player = {
    ...p,
    batting: {
      contact: scale(p.batting.contact),
      power: scale(p.batting.power),
      eye: scale(p.batting.eye),
      speed: scale(p.batting.speed),
      fielding: scale(p.batting.fielding),
      arm: scale(p.batting.arm),
    },
  };

  if (p.pitching) {
    const arsenal: typeof p.pitching.arsenal = {};
    for (const [type, a] of Object.entries(p.pitching.arsenal)) {
      if (!a) continue;
      arsenal[type as keyof typeof arsenal] = {
        velocity: scale(a.velocity),
        control: scale(a.control),
        movement: scale(a.movement),
      };
    }
    next.pitching = { stamina: scale(p.pitching.stamina), arsenal };
  }

  return next;
}

/** 장비·자세·체형 보정을 적용한 실효 능력치 */
export function effectiveBatting(p: Player) {
  const bat = BAT_DEFS.find((b) => b.id === p.gear.bat);
  // 타격 자세 보정: 0 스탠다드 / 1 오픈 / 2 클로즈드 / 3 크라우칭 / 4 레그킥 / 5 노스텝
  const stanceContact = [0, -1, 1, 2, -2, 3][clamp(p.stance, 0, 5)];
  const stancePower = [0, 2, -1, -2, 4, -2][clamp(p.stance, 0, 5)];
  const stanceEye = [0, 1, 0, 2, -2, 1][clamp(p.stance, 0, 5)];
  const body = bodyMod(p);
  return {
    contact: clamp(p.batting.contact + (bat?.contactMod ?? 0) + stanceContact, 1, 99),
    power: clamp(p.batting.power + (bat?.powerMod ?? 0) + stancePower + body.power, 1, 99),
    eye: clamp(p.batting.eye + stanceEye, 1, 99),
    speed: effSpeed(p),
    fielding: p.batting.fielding,
    arm: p.batting.arm,
  };
}

/**
 * 이 타석에서 타자가 실제로 서는 쪽.
 *
 * 스위치히터는 투수 반대편에 선다. 예전에는 `bats === 'S' && true`로 **항상 좌타 고정**
 * 이었는데, 좌우 상성이 없던 시절에는 타구 방향만 바뀌어 눈에 띄지 않았다. 상성이 붙는
 * 순간부터는 스위치히터가 우투수를 상대로 영구히 불리해지는 버그가 된다.
 *
 * **좌우를 읽는 곳은 전부 이 함수 하나를 거쳐야 한다.** 호출하는 쪽마다 `bats`를 직접
 * 읽으면 반드시 어딘가 어긋나고, 그때는 "판정은 좌타인데 화면에서는 우타석에 선"
 * 반쪽이 된다 (부상 보정을 engine.toTeamInGame 한 곳에만 건 것과 같은 이유).
 */
export function effectiveBatSide(batter: Player, pitcher: Player): Handedness {
  if (batter.bats !== 'S') return batter.bats;
  return pitcher.throws === 'L' ? 'R' : 'L';
}

/**
 * 좌우 상성(플래툰) 보정. 배트 판정 반경에 곱한다.
 *
 * 같은 손끼리 붙으면(좌투-좌타) 변화구가 몸쪽에서 바깥으로 달아나 치기 어렵고,
 * 엇갈리면 반대로 공이 몸쪽으로 들어와 보기 편하다. 실제 MLB의 좌우 스플릿은
 * OPS 기준으로 동측 약 −8%, 이측 약 +5% 수준이다.
 *
 * 판정 반경 하나로만 거는 이유는 그것이 헛스윙률과 타구의 질(reachQ·sweetQ)에
 * 동시에 흘러들어 타율·장타가 함께 움직이는 유일한 지점이기 때문이다. 여러 곳에
 * 나눠 걸면 180경기 시뮬레이션으로 되돌리기가 사실상 불가능해진다.
 */
export const PLATOON_SAME_HAND = 0.965;
export const PLATOON_OPPOSITE_HAND = 1.02;

export function platoonRadiusMult(batter: Player, pitcher: Player): number {
  return effectiveBatSide(batter, pitcher) === pitcher.throws
    ? PLATOON_SAME_HAND
    : PLATOON_OPPOSITE_HAND;
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
  // 컨택 능력치가 높을수록 배트 판정 반경이 커진다. 좌우 상성이 여기에 곱해진다.
  const radius =
    def.contactRadius * (0.62 + 0.72 * contactStat) * platoonRadiusMult(batter, pitcher);
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
  // 타이밍이 어긋났다고 배트를 헛돌리지는 않는다. 이르면 당겨서, 늦으면 밀어서
  // 파울이 된다. 이 배수가 작으면 파울이 생길 구간 자체가 없어져 타석이
  // 3.3구 만에 끝나고 볼넷이 사라진다 (MLB는 스윙의 38%가 파울, 4구 이상).
  if (timingErr > window * 2.6) return { kind: 'WHIFF' };

  // --- 품질 계산 ---------------------------------------------------------
  // 0.15의 기본값을 주는 이유: 배트에 맞은 이상 최소한의 타구는 나가야 한다.
  // (이 값이 없으면 타구속도 분포 전체가 실제 야구보다 크게 낮아진다)
  // "배트에 닿았는가"(reachQ)와 "정확히 맞았는가"(sweetQ)는 다른 척도다.
  // 타구의 질까지 radius로 나누면, 컨택 판정을 넓히는 순간 모든 타구의 질이
  // 함께 올라가 타율이 통째로 뛴다. 스윗스팟은 판정 반경보다 좁다.
  const reachQ = 1 - clamp(effSpatial / radius, 0, 1);
  const sweetQ = 1 - clamp(effSpatial / (radius * 0.78), 0, 1);
  const timingQ = 1 - clamp(timingErr / window, 0, 1.3);
  let quality = clamp(0.15 + sweetQ * 0.44 + timingQ * 0.5, 0, 1);

  // 헛스윙 보정: 배트가 공의 궤도를 벗어났을 때만 헛친다.
  // 여기에 quality(타이밍 포함)를 쓰면 빗맞아 파울이 될 스윙까지 헛스윙으로
  // 돌려버려 파울이 사라진다. 판단 근거는 공간 오차뿐이다.
  const whiffP = clamp((0.52 - reachQ) * 1.15 + def.whiffBias, 0, 0.8);
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
  pitcher: Player,
  swing: SwingCommand,
  traj: PitchTrajectory,
  quality: number,
  timingErr: number,
): BattedBall {
  const def = SWING_DEFS[swing.type];
  const eb = effectiveBatting(batter);
  const powerStat = norm(eb.power);
  // 당겨치는 방향은 실제로 선 쪽을 따른다 (스위치히터는 투수에 따라 바뀐다)
  const isLefty = effectiveBatSide(batter, pitcher) === 'L';

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
  // 아래 두 상수는 최종 발사각 분포를 MLB 실측 N(11.5도, 27.7도)에 맞춘 값이다.
  // 좁히면 8~26도(라인드라이브) 구간에 타구가 몰려 BABIP이 .34까지 치솟고,
  // 팝업이 사라진다. 헤드리스 시뮬레이션의 "타구 종류 비중"으로 검증할 것.
  //
  // 기준값을 9에서 11로 올린 건 매그너스 도입의 대가다 — 당겨친 뜬공이 파울라인
  // 쪽으로 휘면서 페어 뜬공이 줄어(gb 46 -> 49) 득점이 함께 빠졌다. 발사각을 조금
  // 올려 페어 타구 구성을 원래대로 되돌린다.
  let launch = 11 - vertOffset * 38 + rng.normal(0, 30);
  // 품질이 좋을수록 이상적 발사각으로 수렴하되, 너무 강하게 끌어당기면
  // 잘 맞은 타구가 전부 홈런 각도로 몰린다.
  // 이 수렴 계수가 홈런/뜬공 비율을 정한다 (MLB 13.5%). 타구속도와 비거리가
  // 정상인데 홈런만 많다면, 잘 맞은 타구가 전부 이상적 발사각으로 몰린 것이다.
  launch = lerp(launch, 20 + rng.normal(0, 8), quality * 0.2);
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
  // 이 계수가 파울 비율을 정한다. |spray|>45도가 파울이므로 78이면 타이밍이
  // 63ms 어긋나야 파울이 되는데, 그러면 빗맞은 타구가 전부 페어로 굴러가
  // 인플레이가 51%까지 오르고(MLB 38%) 타석이 3.2구 만에 끝난다.
  let spray = timingRatio * 126 * pullDir;
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
    fairAngle: Math.round(flight.fairAngle * 10) / 10,
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
  /**
   * 실제로 날아간 방향 (도, sprayAngle과 같은 부호 규약).
   *
   * 매그너스로 타구가 휘기 때문에 **발사 방향과 착지 방향이 다르다.** 페어/파울은
   * 공이 떨어진 자리로 정해지므로 이 값으로 판정해야 한다 (@see isFoulBall).
   */
  fairAngle: number;
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

  // ---- 스핀 축 ------------------------------------------------------------
  // 백스핀 축 = 수평 진행 방향에 수직인 수평축. (v_h x ŷ) 로 잡으면 그 축과 v의
  // 외적이 위를 향한다(= 뜨는 힘).
  // (v̂_h x ŷ) = (-v̂z, 0, v̂x). 이 축과 v의 외적이 +Y(위)를 향한다 = 백스핀 양력.
  const hn = Math.hypot(vx, vz) || 1;
  const bx = -(vz / hn);
  const bz = vx / hn;
  // 사이드스핀: 파울라인 쪽으로 휘도록 축을 수직으로 기울인다.
  // sprayDeg가 음수(좌익)면 +Y 성분이 양수가 되어 힘이 +X(3루선)로 간다.
  const side = -SIDESPIN_K * clamp(sprayDeg / 45, -1.6, 1.6);
  const sn = Math.hypot(bx, side, bz) || 1;
  const wx = bx / sn;
  const wy = side / sn;
  const wz = bz / sn;

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
    // 매그너스 = k * |v| * (ŵ x v). 축이 서 있으면 위로, 기울면 옆으로 밀린다.
    const mk = MAGNUS_K * v;
    const mx = mk * (wy * vz - wz * vy);
    const my = mk * (wz * vx - wx * vz);
    const mz = mk * (wx * vy - wy * vx);

    vx += (mx - vx * drag) * dt;
    vz += (mz - vz * drag) * dt;
    vy += (-GRAVITY + my - vy * drag) * dt;

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
  // sprayAngle은 +가 우익, 월드 +X는 좌익이라 부호가 반대다
  const fairAngle = (-Math.atan2(landing.x, landing.z) * 180) / Math.PI;
  return {
    hangTime: fencePoint ? fenceTime : t,
    landing,
    fairAngle,
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

/**
 * 이 타구가 파울인가.
 *
 * **발사 방향이 아니라 착지 방향으로 판단한다.** 매그너스로 당겨친 타구가 파울라인
 * 쪽으로 휘기 때문에, 발사 각도로만 보면 파울 지역에 떨어진 공을 페어로 처리하게 된다
 * (그 상태에서는 담장 판정만 착지 기준이라 홈런이 통째로 사라졌다).
 * fairAngle이 없는 옛 저장 데이터는 예전처럼 발사 각도를 쓴다.
 */
export function isFoulBall(bb: Pick<BattedBall, 'sprayAngle' | 'fairAngle'>): boolean {
  return Math.abs(bb.fairAngle ?? bb.sprayAngle) > 45;
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
