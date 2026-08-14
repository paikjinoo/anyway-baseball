/**
 * 선수 포즈 라이브러리 — 관절 각도를 만드는 순수 코드.
 *
 * PlayerModel에서 떼어낸 이유는 두 가지다.
 * 1. 여긴 React도 JSX도 없어서 Vitest가 그대로 import할 수 있다. 포즈가 사람 관절
 *    가동범위를 지키는지 수치로 검사하는 anatomy.test.ts가 이 파일에 붙는다.
 * 2. PlayerModel은 렌더링만 남는다. 관절 값을 정하는 곳과 그리는 곳이 갈린다.
 *
 * import 방향은 PlayerModel -> poses -> rig 한 방향이라 순환이 없다.
 * (RUN_STRIDE를 constants.ts에 둔 이유도 같다 — 여기 두면 lib이 컴포넌트를 import하게 된다.)
 *
 * 좌표 규약은 rig.ts와 같다: +Y 위, +Z 정면(가슴), 발바닥 y=0.
 */

import * as THREE from 'three';
import { clamp } from '@/lib/game/rng';
import { RUN_STRIDE } from '@/lib/game/constants';
import {
  ARM_REACH,
  BODY,
  ELBOW_MAX_FLEX,
  FOOT_DROP,
  FOREARM,
  HIP_H,
  HIP_X,
  KNEE_MAX_FLEX,
  SHIN,
  SHOULDER_X,
  SHOULDER_Y,
  TAU,
  THIGH,
  TORSO_Y,
  UPPER_ARM,
  WRIST_MAX_SWING,
  WRIST_MAX_TWIST,
} from './rig';
import type { Handedness, Player } from '@/lib/game/types';

export type PoseKind =
  | 'IDLE'
  | 'BATTING'
  | 'BATTING_SWING'
  | 'BATTING_BUNT'
  | 'PITCHING_SET'
  | 'PITCHING_RELEASE'
  | 'FIELDING'
  | 'RUNNING'
  | 'CATCHING'
  | 'SLIDING'
  | 'CELEBRATE'
  // --- 아래는 예전에 없어서 장면이 비어 있던 동작들 ---
  /** 야수 송구. 없을 때는 공이 야수 손에서 순간이동했다. */
  | 'THROWING'
  /** 다이빙 캐치 */
  | 'DIVING'
  /** 헤드퍼스트 슬라이딩 */
  | 'SLIDING_HEAD'
  /** 베이스에서 태그를 기다리는 자세 */
  | 'TAG'
  /** 점프 캐치 */
  | 'JUMP'
  /** 삼진·실책 후 낙담 */
  | 'REACT_DOWN'
  /** 짧은 환호 */
  | 'REACT_UP'
  /** 주심 크라우칭 */
  | 'UMPIRE'
  /** 스트라이크·아웃 콜 */
  | 'CALL_STRIKE'
  /** 세이프 콜 */
  | 'CALL_SAFE';

// ---------------------------------------------------------------------------
// 2본 IK — 뿌리 위치와 끝 목표만 주면 관절 회전을 역산한다.
//
// 팔에서는 손을 배트 그립/글러브에 정확히 붙이는 데 쓰고, 다리에서는 **발을 지면에
// 고정**하는 데 쓴다. 달리기를 고관절 각도의 사인파로만 흔들면 발이 반드시 미끄러지는데
// (보폭과 이동 거리가 서로 모르는 값이라 맞출 방법이 없다), 접지한 발의 위치를 직접
// 지정하면 그 문제가 정의상 사라진다.
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _qa = new THREE.Quaternion();

export interface ArmSolution {
  /** 어깨 그룹의 회전 (몸통 로컬) */
  quat: THREE.Quaternion;
  /** 팔꿈치 굽힘 (X축, 음수 = 앞으로 접힘) */
  elbow: number;
  /**
   * 손목 회전 (아래팔 로컬). 손에 든 장비 방향에서 역산한다.
   *
   * 다리(LimbSnap)에는 없는 채널이다 — 발은 잡을 게 없어서 ankle 하나로 충분하다.
   */
  wrist: THREE.Quaternion;
}

/**
 * 굽힘 한계각에서 두 뼈의 끝점이 뿌리로부터 떨어지는 거리 (코사인 법칙).
 * 목표가 이보다 가까우면 관절이 사람보다 더 접혀야 하므로, 목표를 여기까지 밀어낸다.
 */
function reachAtMaxFlex(upper: number, lower: number, maxFlex: number): number {
  return Math.sqrt(
    Math.max(0, upper * upper + lower * lower + 2 * upper * lower * Math.cos(maxFlex)),
  );
}

/**
 * root에서 target까지 2본 체인을 뻗는다. 좌표는 모두 그 체인의 부모 로컬.
 * pole은 가운데 관절(팔꿈치/무릎)이 향할 방향 힌트.
 *
 * bend는 굽힘 부호다. 팔꿈치는 앞으로(-), 무릎은 뒤로(+) 접힌다.
 *
 * maxFlex는 그 관절이 접힐 수 있는 한계각이다. 예전엔 최소 도달거리가 0.12이라는
 * 매직넘버였는데, 그 값이면 팔꿈치가 155°까지 꺾여서 사람 관절 범위를 넘었다.
 * 지금은 한계각에서 거리를 역산하므로 **뼈 길이를 바꿔도 한계가 따라온다.**
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  upper: number,
  lower: number,
  bend: number,
  maxFlex: number,
  out: ArmSolution,
): ArmSolution {
  const v = _v.copy(target).sub(root);
  let d = v.length();
  const maxD = (upper + lower) * 0.995;
  const minD = reachAtMaxFlex(upper, lower, maxFlex);
  if (d < 1e-4) {
    v.set(0, -minD, 0);
    d = minD;
  } else if (d > maxD) {
    v.multiplyScalar(maxD / d);
    d = maxD;
  } else if (d < minD) {
    v.multiplyScalar(minD / d);
    d = minD;
  }

  // 코사인 법칙으로 가운데 관절 각도
  const cosPhi = (d * d - upper * upper - lower * lower) / (2 * upper * lower);
  const elbow = bend * Math.acos(clamp(cosPhi, -1, 1));

  // 굽힌 상태에서 끝점이 놓이는 방향 (체인 로컬)
  const hand = _v2
    .set(0, -(upper + lower * Math.cos(elbow)), -lower * Math.sin(elbow))
    .normalize();
  const dir = _v3.copy(v).normalize();

  out.quat.setFromUnitVectors(hand, dir);

  // 가운데 관절이 pole 쪽을 보도록 체인 축(dir) 기준으로 비튼다
  const elbowDir = _v4.set(0, -upper, 0).applyQuaternion(out.quat);
  const a = elbowDir.sub(_v5.copy(dir).multiplyScalar(elbowDir.dot(dir)));
  const b = _v5.copy(pole).sub(_v2.copy(dir).multiplyScalar(pole.dot(dir)));
  if (a.lengthSq() > 1e-6 && b.lengthSq() > 1e-6) {
    a.normalize();
    b.normalize();
    let ang = Math.acos(clamp(a.dot(b), -1, 1));
    if (a.cross(b).dot(dir) < 0) ang = -ang;
    out.quat.premultiply(_qa.setFromAxisAngle(dir, ang));
  }
  out.elbow = elbow;
  return out;
}

/** 어깨에서 손까지. 좌표는 몸통 로컬. */
export function solveArm(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  out: ArmSolution,
): ArmSolution {
  return solveTwoBone(shoulder, target, pole, UPPER_ARM, FOREARM, -1, ELBOW_MAX_FLEX, out);
}

// ---------------------------------------------------------------------------
// 포즈 기술 구조체
// ---------------------------------------------------------------------------

export type V3 = [number, number, number];

export interface LegPose {
  /** 고관절 회전 [x=앞뒤, y=비틀림, z=벌림] */
  hip: V3;
  /** 무릎 굽힘 (양수 = 뒤로 접힘) */
  knee: number;
  /** 발목 */
  ankle: number;
  /**
   * 발목 목표. 있으면 hip/knee 대신 IK로 푼다.
   *
   * 좌표계는 **골반 원점을 중심으로 한 루트 축**이다 (hipRot의 영향을 받지 않는다).
   * 골반이 비틀려도 접지한 발은 그 자리에 남아야 하므로 — 그게 이 좌표계를 쓰는 이유다.
   * y는 발목 높이라, 지면 접지 보정은 `y - FOOT_DROP`을 그대로 발바닥 높이로 쓴다.
   */
  ikTarget?: V3;
  /** 무릎이 향할 방향 힌트 (기본 앞) */
  ikPole?: V3;
}

export interface ArmPose {
  /** 손 목표 (몸통 로컬). 있으면 IK로 푼다. */
  target?: V3;
  /** 팔꿈치 방향 힌트 */
  pole?: V3;
  /** IK를 쓰지 않을 때의 어깨 오일러 */
  euler?: V3;
  /** euler를 쓸 때의 팔꿈치 굽힘 */
  elbow?: number;
}

/** 손에 드는 장비의 부착 지점 (몸통 로컬) */
export interface Anchor {
  pos: V3;
  /** YXZ 순서 오일러 */
  rot: V3;
  /** 배트를 잡는 아래/위 손의 위치 (배트 로컬 Y). 번트처럼 손을 벌릴 때만 준다. */
  grip?: [number, number];
}

export interface Pose {
  /** 루트 이동 (모델 로컬). 스트라이드/슬라이딩 등 */
  root: V3;
  /**
   * 골반 높이 보정.
   *
   * **`ground: true`면 이 값은 골반 높이에 아무 영향이 없다.** writeSnapshot이
   * `rootY += -(HIP_H + hipDrop + min(발바닥))`으로 접지 보정을 걸기 때문에,
   * 골반의 최종 높이는 `root.y - min(발바닥)`이 되어 hipDrop이 정확히 상쇄된다.
   * 다리가 FK로 골반에 매달려 있으니 당연한 결과다 — 골반을 내리면 발도 같이
   * 내려가고, 보정이 그만큼 도로 올린다.
   *
   * 그래서 **웅크리는 동작은 반드시 무릎으로 만들어야 한다.** 무릎을 접으면 다리가
   * 짧아져서 발이 제자리에 남은 채로 골반이 내려온다. 실제로 크라우칭 타격 자세가
   * 이 함정에 빠져 있었다 — hipDrop을 10cm 내렸는데 골반은 1.2cm만 낮아졌고,
   * 그 1.2cm조차 뒷무릎을 조금 굽힌 부수효과였다.
   *
   * (`ground: false`인 포즈에서는 정상적으로 골반만 내린다. 대신 발이 지면을 뚫는다.)
   */
  hipDrop: number;
  hipRot: V3;
  /** L = -X 쪽 다리/팔, R = +X 쪽 */
  legL: LegPose;
  legR: LegPose;
  torso: V3;
  head: V3;
  armL: ArmPose;
  armR: ArmPose;
  bat?: Anchor;
  /** 글러브를 든 손 ('L' | 'R') */
  gloveHand?: 'L' | 'R';
  glove?: Anchor;
  /** 배트를 잡는 위쪽 손 */
  topHand?: 'L' | 'R';
  /** 낮은 발이 지면에 닿도록 자동 보정할지 */
  ground: boolean;
}

const DEFAULT_LEG: LegPose = { hip: [0, 0, 0], knee: 0.06, ankle: 0 };

export function basePose(): Pose {
  return {
    root: [0, 0, 0],
    hipDrop: 0,
    hipRot: [0, 0, 0],
    legL: { ...DEFAULT_LEG, hip: [0, 0, -0.03] },
    legR: { ...DEFAULT_LEG, hip: [0, 0, 0.03] },
    torso: [0.03, 0, 0],
    head: [0, 0, 0],
    armL: { euler: [0.08, 0, 0.1], elbow: -0.25 },
    armR: { euler: [0.08, 0, -0.1], elbow: -0.25 },
    ground: true,
  };
}

/** X축 기준으로 포즈를 좌우 반전한다 (좌투/좌타 처리) */
export function mirrorPose(p: Pose): Pose {
  const mv = (v: V3): V3 => [-v[0], v[1], v[2]];
  const mr = (v: V3): V3 => [v[0], -v[1], -v[2]];
  // ikTarget/ikPole을 빠뜨리면 좌우를 뒤집는 순간 그 다리가 hip:[0,0,0], knee:0 으로
  // 떨어져 **작대기처럼 펴진다.** 지금은 RUNNING만 IK 다리를 쓰고 그건 미러링을 타지
  // 않아 드러나지 않지만, IK 다리를 쓰는 포즈가 하나만 더 생기면 바로 터진다.
  const mLeg = (l: LegPose): LegPose => ({
    hip: mr(l.hip),
    knee: l.knee,
    ankle: l.ankle,
    ikTarget: l.ikTarget ? mv(l.ikTarget) : undefined,
    ikPole: l.ikPole ? mv(l.ikPole) : undefined,
  });
  const mArm = (a: ArmPose): ArmPose => ({
    target: a.target ? mv(a.target) : undefined,
    pole: a.pole ? mv(a.pole) : undefined,
    euler: a.euler ? mr(a.euler) : undefined,
    elbow: a.elbow,
  });
  const mAnchor = (a?: Anchor): Anchor | undefined =>
    a ? { pos: mv(a.pos), rot: mr(a.rot), grip: a.grip } : undefined;
  const flip = (h?: 'L' | 'R') => (h === 'L' ? 'R' : h === 'R' ? 'L' : undefined);
  return {
    ...p,
    root: mv(p.root),
    hipRot: mr(p.hipRot),
    legL: mLeg(p.legR),
    legR: mLeg(p.legL),
    torso: mr(p.torso),
    head: mr(p.head),
    armL: mArm(p.armR),
    armR: mArm(p.armL),
    bat: mAnchor(p.bat),
    glove: mAnchor(p.glove),
    gloveHand: flip(p.gloveHand),
    topHand: flip(p.topHand),
  };
}

// ---------------------------------------------------------------------------
// 보간 도우미
// ---------------------------------------------------------------------------

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0~1 구간 [a,b]를 0~1로 재매핑 */
export const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
export const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
export const easeIn = (t: number) => t * t;
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/**
 * 코킹에서 릴리스로 채찍처럼 **가속**한다.
 *
 * 원래는 `1 - (1-t)³`(빠르게 나갔다가 멈춤)이었는데, 이걸 코킹→릴리스 구간에 쓰면
 * 팔이 릴리스 **직전에 가장 느려진다.** 던지는 동작은 정확히 그 반대다 — 릴리스가
 * 최고 속도이고 그 뒤로 팔로스루가 받아 감속한다. 뒤집힌 탓에 릴리스 지점에서
 * 속도가 푹 꺼졌다가 팔로스루에서 다시 튀어, 팔이 한 번 멈칫하고 나갔다.
 */
export const whip = (t: number) => t * t;

/** 키프레임 배열을 시간축으로 보간 */
export function track(t: number, keys: [number, number][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      const u = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return lerp(v0, v1, easeInOut(u));
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * track과 같은 키프레임이지만 **키를 지날 때 속도가 끊기지 않는다.**
 *
 * track은 구간마다 easeInOut을 따로 걸기 때문에 키마다 속도가 0으로 떨어진다.
 * 몸통 각도처럼 천천히 변하는 값에서는 그게 "부드러움"으로 보이지만, 던지는 팔처럼
 * 빠른 궤적에 쓰면 **키마다 멈췄다 다시 출발한다.** 실제로 예전 투구 포즈의 손 속도는
 * 3.8 → 0.6 → 5.3 → 0.4 → 10.0 m/s 로 릴리스까지 네 번 멈췄다 튀었고, 그게
 * "던지는 게 아니라 네 토막으로 끊어 옮긴다"는 인상의 정체였다.
 *
 * 여기서는 이웃 키의 기울기를 평균해 접선을 만들고(Catmull-Rom), Fritsch-Carlson
 * 조건으로 접선을 깎아 **구간 밖으로 튀지 않게** 한다. 오버슛을 막는 게 중요한 이유는
 * 값이 한 번 되올라가면 다리를 내리는 구간에서 무릎이 두 번 차올라가기 때문이다.
 */
export function smoothTrack(t: number, keys: [number, number][]): number {
  const n = keys.length;
  if (n < 2 || t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 1;
  while (i < n - 1 && t > keys[i][0]) i++;
  const [t0, v0] = keys[i - 1];
  const [t1, v1] = keys[i];
  const h = t1 - t0;
  if (h <= 0) return v1;

  const slope = (a: number, b: number) =>
    keys[b][0] === keys[a][0] ? 0 : (keys[b][1] - keys[a][1]) / (keys[b][0] - keys[a][0]);
  const d = slope(i - 1, i);
  // 양 끝 키는 이웃이 한쪽뿐이라 그 구간 기울기를 그대로 접선으로 쓴다
  let m0 = i >= 2 ? (slope(i - 2, i - 1) + d) / 2 : d;
  let m1 = i + 1 < n ? (d + slope(i, i + 1)) / 2 : d;
  if (d === 0) {
    // 값이 같은 두 키 사이 — 접선을 남기면 평평해야 할 구간이 부풀어 오른다
    m0 = 0;
    m1 = 0;
  } else {
    // 방향이 뒤집힌 접선은 극값 바로 옆에서 값을 되돌린다 (= 무릎이 두 번 차오른다)
    if (m0 / d < 0) m0 = 0;
    if (m1 / d < 0) m1 = 0;
    const a = m0 / d;
    const b = m1 / d;
    const s = a * a + b * b;
    if (s > 9) {
      const f = 3 / Math.sqrt(s);
      m0 = f * m0;
      m1 = f * m1;
    }
  }

  const u = (t - t0) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * v0 +
    (u3 - 2 * u2 + u) * h * m0 +
    (-2 * u3 + 3 * u2) * v1 +
    (u3 - u2) * h * m1
  );
}

// ---------------------------------------------------------------------------
// 포즈 정의
//
// clock은 모델이 스스로 돌리는 초 단위 시계다. 게임이 t를 물려주지 않는
// 정지 포즈(대기·수비 준비 등)에서도 숨쉬기·체중이동이 계속 살아 있게 한다.
// ---------------------------------------------------------------------------

/**
 * 타석에서 몸통 기준 투수 방향(로컬 +X)까지의 각도.
 * 고개를 정확히 90도 돌리면 목이 부러진 것처럼 보이므로 조금 못 미치게 두고
 * 나머지는 얼굴(눈) 위치가 채운다.
 */
export const GAZE_AT_PITCHER = 1.28;

/**
 * 던지는 팔(-X)의 팔꿈치 방향 두 극. 코킹 구간에서는 아래·바깥, 릴리스 전후에는
 * 뒤·위로 선다. 둘 사이를 오갈 때는 반드시 `mixDir`로 섞어야 한다 — 갈아 끼우면
 * 축 비틀림이 한 프레임에 뒤집혀 팔꿈치가 순간이동한다.
 */
const POLE_SLOT_DOWN: V3 = [-1, -0.5, -0.5];
const POLE_SLOT_UP: V3 = [-0.4, 0.2, -1];
/** 손이 아직 글러브 앞(가슴 앞)에 있을 때. 팔꿈치를 옆으로 크게 벌려 갈비뼈를 피한다. */
const POLE_SLOT_OUT: V3 = [-1, -0.35, 0.25];

/** 두 방향을 섞는다. 길이는 solveTwoBone이 정규화하므로 성분 보간으로 충분하다. */
function mixDir(a: V3, b: V3, t: number): V3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * 경유점을 이어 손이 지나갈 곡선을 만든다.
 *
 * 예전에는 구간마다 `lerp`를 갈아 끼웠는데, 그러면 경유점에서 궤적이 **꺾인다**.
 * 팔이 부드러운 원을 그리는 게 아니라 각진 다각형을 따라간다는 뜻이다.
 * centripetal Catmull-Rom은 경유점을 정확히 지나면서 접선이 이어지고, uniform과 달리
 * 간격이 들쭉날쭉해도 고리(cusp)를 만들지 않는다.
 *
 * `u = i/(N-1)`이 정확히 i번째 경유점이므로 **어느 시각에 어느 경유점에 있을지**를
 * 시간 매핑만으로 지정할 수 있다. 경유점 간 시간 간격을 릴리스 쪽으로 좁히면
 * 속도가 저절로 채찍처럼 붙는다.
 */
function makePath(n: number) {
  const pts = Array.from({ length: n }, () => new THREE.Vector3());
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const out = new THREE.Vector3();
  return {
    pts,
    /** i번째 경유점을 지정한다 (프레임마다 갈아 쓴다 — 새로 할당하지 않는다) */
    set(i: number, x: number, y: number, z: number) {
      pts[i].set(x, y, z);
      return this;
    },
    setV(i: number, v: THREE.Vector3) {
      pts[i].copy(v);
      return this;
    },
    at(u: number): THREE.Vector3 {
      return curve.getPoint(clamp(u, 0, 1), out);
    },
  };
}

/** 던지는 팔: 글러브 → 분리 → 스윙 최저점 → 코킹 → 릴리스 → 가로지르기 → 반대쪽 허리 */
const _throwPath = makePath(7);
/** 글러브 팔: 가슴 → 들어올림 → 타깃으로 뻗기 → 당기기 → 옆구리 */
const _glovePath = makePath(5);
/** 경유점을 계산할 때 쓰는 임시 벡터 (프레임마다 할당하지 않기 위한 것) */
const _tmpShoulder = new THREE.Vector3();
const _tmpRelease = new THREE.Vector3();
const _tmpAcross = new THREE.Vector3();
const _tmpFinish = new THREE.Vector3();
const _tmpCock = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();
const _tmpE = new THREE.Euler();

/**
 * 타격 자세. 기준은 우타자.
 *
 * 모델 로컬은 +Z가 가슴 방향이고, GameScene이 우타자를 rotationY=-90도로 세우므로
 * **로컬 +X가 월드 +Z(투수), 로컬 -X가 포수 쪽**이 된다. 따라서
 *   - 앞발/앞어깨 = legR·armR (+X)
 *   - 뒷발(체중)과 배트 = legL·armL (-X)
 *   - 고개는 +X(투수)를 향해 돌린다
 * 좌타자는 mirrorPose로 통째로 뒤집는다.
 *
 * load는 투수의 딜리버리 진행도로, 0이면 대기 1이면 히칭/스트라이드 직전.
 */
function battingPose(player: Player, load: number, clock: number): Pose {
  const p = basePose();
  const stance = player.stance;
  // 0 스탠다드 1 오픈 2 클로즈드 3 크라우칭 4 레그킥 5 노스텝
  // 오픈은 몸을 투수 쪽으로 열고(+), 클로즈드는 더 감는다(-)
  const open = stance === 1 ? 0.24 : stance === 2 ? -0.2 : 0;
  const crouch = stance === 3 ? 1 : 0;
  const legKick = stance === 4 ? load : 0;
  /**
   * 웅크림은 **양 무릎으로만** 만든다 (`Pose.hipDrop` 주석 참고 — 접지 보정이
   * hipDrop을 상쇄하므로 골반을 직접 내리는 건 아무 일도 하지 않는다).
   *
   * 그리고 반드시 **두 무릎을 같이** 굽혀야 한다. 예전엔 뒷무릎에만 걸려 있었는데,
   * 한쪽만 굽히면 그 발이 올라가면서 접지 기준(둘 중 낮은 발)에서 빠져 버려
   * 골반이 거의 그대로 남는다. 실제로 1.2cm밖에 안 내려갔다.
   */
  const crouchKnee = crouch * 0.62;

  // 타이밍을 재는 배트 흔들기. 딜리버리가 진행될수록 잦아들고 몸이 굳는다.
  const calm = 1 - easeIn(clamp(load, 0, 1));
  const wag = Math.sin(clock * 3.3) * calm;
  const sway = Math.sin(clock * 1.65) * calm;

  // 어깨선이 투수를 향하도록 몸통을 살짝 감아 둔다 (음수 = 포수 쪽으로 닫힘)
  const hipY = -0.18 + open - sway * 0.05;
  const torsoY = -0.24 - load * 0.1 + sway * 0.06;

  p.hipDrop = -0.1 - sway * 0.012;
  p.hipRot = [0, hipY, 0];
  p.torso = [0.14 + crouch * 0.16, torsoY, -0.04];
  // 감긴 몸통 위에서 고개만 투수 쪽으로 돌린다
  p.head = [0.05, GAZE_AT_PITCHER - (hipY + torsoY), 0];

  // 앞발(+X)은 투수 쪽, 뒷발(-X)에 체중.
  // 무릎을 접으면 정강이가 뒤로 돌아 발이 몸 아래로 당겨진다. 고관절을 그만큼 더
  // 굽혀 줘야 웅크려도 스탠스 폭이 유지된다 (안 그러면 발이 모여 좁아진다).
  p.legL = {
    hip: [-0.1 - crouchKnee * 0.3, -0.12, -0.3],
    knee: 0.48 + crouchKnee,
    ankle: 0,
  };
  p.legR = {
    hip: [0.12 - legKick * 1.5 - crouchKnee * 0.3, 0.1, 0.3],
    knee: 0.34 + legKick * 1.3 + crouchKnee,
    ankle: 0,
  };
  // 다리를 들면 체중이 뒤(-X, 포수 쪽)로 실린다.
  // 웅크리면 무릎이 접히며 발이 몸 뒤(-Z)로 빠지므로, 그만큼 몸을 앞으로 보내
  // **발자리를 스탠스 그대로 유지한다** (실제로도 쪼그리면 상체가 발 위로 나온다).
  p.root = [-0.02 * legKick, 0, crouch * 0.1];

  // 배트: 뒤쪽(-X) 어깨 위에 세우고 살짝 눕힌다.
  //
  // 손은 가슴 **앞**(+Z)에 둬야 한다. 예전엔 z=-0.12로 가슴 뒤에 있었는데, 그러면
  // 리드암이 몸통을 가로질러 뒤로 뻗느라 팔꿈치가 몸 안에 박혔고(몸통축까지 0.06),
  // 위손은 어깨에서 0.17밖에 안 떨어져 가만히 선 자세가 이미 144° 굴곡이었다.
  const wrap = lerp(0, 0.16, load);
  p.bat = {
    pos: [-0.18, 0.22 - crouch * 0.02, 0.26],
    rot: [-0.22 - wrap + wag * 0.09, -0.5 - wag * 0.07, 0.62 + wrap * 0.7 + wag * 0.12],
  };
  p.topHand = 'L';
  p.ground = true;
  return p;
}

/**
 * 스윙. t=0 로드 -> 0.45 임팩트 -> 1 팔로스루.
 * 골반이 먼저 열리고 몸통이 따라 도는 순서(분리)로 회전시킨다.
 *
 * 좌표 규약은 battingPose와 같다(+X = 투수). 몸통은 포수 쪽으로 감겼다가
 * **+방향으로** 돌아 나가고, 팔로스루에서 가슴이 투수 쪽을 지나 좌중간을 향한다.
 */
function swingPose(player: Player, t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const stance = player.stance;
  // 스탠스는 **스윙까지 이어져야 한다.** 예전에는 여기서 stance를 crouch 하나에만
  // 쓰고 그 crouch마저 hipDrop(= ground:true에서 무효)에 걸려 있어서, 여섯 자세의
  // 임팩트 포즈가 소수점까지 완전히 같았다. 커스터마이징에서 고른 자세가 정작
  // 스윙에서는 사라졌다는 뜻이다.
  const crouch = stance === 3 ? 1 : 0;
  const crouchKnee = crouch * 0.62;
  const open = stance === 1 ? 0.24 : stance === 2 ? -0.2 : 0;
  /** 노스텝은 이름 그대로 **발을 내딛지 않는다.** 회전만으로 친다. */
  const noStep = stance === 5;
  /** 레그킥은 들어 올린 다리에서 시작해 내려디디며 그 체중을 싣는다. */
  const legKick = stance === 4;

  // 스트라이드: 앞발이 들렸다 내려디디며 몸이 살짝 앞으로
  const stride = track(k, [
    [0, 0],
    [0.18, 0.5],
    [0.4, 1],
    [1, 1],
  ]);
  // 오픈/클로즈드는 착지하면서 절반쯤 정렬되지만 완전히 사라지지는 않는다.
  // 남은 차이가 곧 "클로즈드가 더 감고 돈다"는 회전량 차이가 된다.
  const openW = open * lerp(1, 0.45, stride);

  // 골반 -> 몸통 순서로 열린다
  const hipY =
    track(k, [
      [0, -0.3],
      [0.16, -0.42],
      [0.45, 0.5],
      [0.7, 1.05],
      [1, 1.2],
    ]) + openW;
  const torsoY =
    track(k, [
      [0, -0.36],
      [0.2, -0.5],
      [0.45, 0.3],
      [0.72, 0.95],
      [1, 1.15],
    ]) +
    openW * 0.85;

  p.hipDrop = -0.12 - Math.sin(k * Math.PI) * 0.05;
  p.hipRot = [0, hipY, 0];
  // 어깨선이 임팩트에서 살짝 뒤로 눕는다 (뒤쪽 어깨가 내려가는 축 기울기)
  const shoulderTilt = track(k, [
    [0, 0.05],
    [0.45, 0.2],
    [0.75, 0.06],
    [1, -0.02],
  ]);
  p.torso = [0.16 - k * 0.05 + crouch * 0.14, torsoY, -(shoulderTilt + k * 0.1)];
  // 시선: 투수를 보다가 임팩트에서 타격 지점에 고정되고, 그 뒤 몸통을 따라 돈다.
  // 몸통이 얼마나 돌았든 시선의 절대 방향을 먼저 정하고 목 각도를 역산한다.
  const gaze = track(k, [
    [0, GAZE_AT_PITCHER],
    [0.45, 0.68],
    [0.7, 0.3],
    [1, 0],
  ]);
  p.head = [0.08, clamp(gaze - (hipY + torsoY), -1.6, 1.6), 0];
  // 몸이 앞으로 나가는 양도 자세를 따른다 — 노스텝은 제자리, 레그킥은 크게 싣는다
  p.root = [
    lerp(legKick ? -0.06 : noStep ? -0.012 : -0.04, noStep ? 0.008 : 0.03, stride),
    0,
    crouch * 0.1,
  ];

  // 앞발(+X): 들었다가 내려디디며 벽을 만든다.
  //
  // 시작 자세가 스탠스마다 다르다 — 레그킥은 무릎을 든 채로 시작해 내려디디고,
  // 노스텝은 처음부터 디딘 자리에 있어 **거의 움직이지 않는다.** 예전에는 이 값들이
  // 상수라 노스텝 타자도 다른 자세와 똑같이 20.3cm를 내디뎠다(= 이름과 정반대).
  const frontHip = legKick ? -1.32 : noStep ? -0.02 : 0.2;
  const frontKnee = legKick ? 1.58 : noStep ? 0.3 : 0.5;
  // 웅크린 타자는 스윙 내내 낮은 자세를 유지한다.
  //
  // **접지한 발이 골반 높이를 정한다** (writeSnapshot이 둘 중 낮은 발을 지면에 맞춘다).
  // 임팩트에서 땅에 붙어 있는 쪽은 내디딘 **앞발**이므로, 앞무릎을 접어야 실제로
  // 낮아진다. 뒷무릎까지 같은 양을 접으면 뒷발만 허공으로 15cm 떠오르고 골반은
  // 그대로다 — 대기 자세에서 한쪽 무릎만 굽혀 1.2cm밖에 안 내려갔던 것과 같은 함정이다.
  // 접지하는 발이 스트라이드 전후로 바뀌므로(초반 뒷발 → 임팩트 앞발) 굽힘도 같이 넘긴다.
  const braceF = crouchKnee * lerp(0.12, 0.8, stride);
  const braceB = crouchKnee * lerp(0.85, 0.3, stride);
  p.legR = {
    hip: [lerp(frontHip, noStep ? -0.04 : -0.16, stride), 0.12, lerp(0.24, noStep ? 0.28 : 0.36, stride)],
    knee: lerp(frontKnee, noStep ? 0.28 : 0.2, stride) + braceF,
    ankle: 0,
  };
  // 뒷발(-X)은 임팩트 이후 뒤꿈치가 들리며 회전한다
  p.legL = {
    hip: [lerp(-0.12, 0.16, k), lerp(-0.15, 0.5, k), -0.3],
    knee: lerp(0.44, 0.72, k) + braceB,
    ankle: lerp(0, -0.7, easeIn(k)),
  };

  // 배트: 뒤에서 지연됐다가(래그) 임팩트에서 앞으로 채고 어깨로 감긴다
  const batYaw = track(k, [
    [0, -0.5],
    [0.2, -0.74],
    [0.45, 0.15],
    [0.68, 1.1],
    [1, 1.9],
  ]);
  const batRoll = track(k, [
    [0, 0.62],
    [0.2, 0.82],
    [0.45, 1.42],
    [0.7, 1.1],
    [1, 0.2],
  ]);
  const batPitch = track(k, [
    [0, -0.22],
    [0.45, 0.12],
    [1, 0.5],
  ]);
  // 손이 지나는 길.
  //
  // 어깨에서의 거리에 **위아래 한계가 둘 다** 있다. 팔 길이(0.55)를 넘으면 손이
  // 배트에서 떨어지고, 너무 가까워도(0.17 미만) 팔꿈치가 사람 한계보다 접혀야 해서
  // 역시 떨어진다 — 예전 팔로스루가 0.12까지 붙어 손이 그립에서 8cm 빠졌다.
  //
  // 그리고 손은 스윙 내내 가슴 앞(+Z)에 있어야 한다. 배럴은 팔로스루에서 등 뒤로
  // 감기지만 그건 배트 회전이 하는 일이지, 손이 등 뒤로 돌아가는 게 아니다.
  const hx = track(k, [
    [0, -0.18],
    [0.2, -0.22],
    [0.45, 0.0],
    [0.7, 0.14],
    [1, 0.12],
  ]);
  const hy = track(k, [
    [0, 0.22],
    [0.2, 0.2],
    [0.45, 0.12],
    [0.7, 0.16],
    [1, 0.22],
  ]);
  const hz = track(k, [
    [0, 0.26],
    [0.2, 0.22],
    [0.45, 0.34],
    [0.7, 0.3],
    [1, 0.24],
  ]);
  p.bat = { pos: [hx, hy, hz], rot: [batPitch, batYaw, batRoll] };
  p.topHand = 'L';

  // 팔꿈치가 놓이는 평면은 스윙 내내 돈다. 로드에서 위손 팔꿈치는 뒤(-Z)로 세워
  // 있다가, 임팩트에서 아래로 내려오고, 팔로스루에서는 몸을 가로지르며 앞(+Z)으로
  // 빠져나간다. 이걸 한 값으로 고정하면 팔로스루에서 위팔이 가슴을 스치고 지나간다.
  const topZ = track(k, [
    [0, -0.42],
    [0.45, -0.05],
    [1, 0.75],
  ]);
  p.armL = { pole: [-0.72, -0.55, topZ] };
  p.armR = { pole: [0.85, -0.8, lerp(0.3, 0.6, k)] };
  p.ground = true;
  return p;
}

/**
 * 번트. t=0 타격 자세 -> 0.3 스퀘어 완료 -> 0.34 임팩트 -> 1 유지.
 *
 * 좌표 규약은 battingPose와 같다(+X = 투수). 골반부터 돌려 가슴을 투수 쪽으로
 * 세우고(스퀘어), 무릎을 접어 눈높이를 공 높이까지 내린 뒤 배트를 몸 앞에
 * 가로로 내민다. 임팩트에서는 손을 뒤로 빼 타구를 죽인다.
 *
 * 스윙과 달리 배트를 휘두르지 않으므로 위쪽 손이 배럴까지 미끄러져 올라간다
 * (grip). 손이 모여 있으면 그냥 배트를 세워 든 것처럼 보여 번트로 안 읽힌다.
 */
function buntPose(player: Player, t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const crouch = player.stance === 3 ? 0.12 : 0;

  // 스퀘어 진행도. 공이 오기 전에 자세를 다 잡아야 하므로 앞쪽에 몰아 넣는다.
  const sq = track(k, [
    [0, 0],
    [0.06, 0.1],
    [0.3, 1],
    [1, 1],
  ]);
  // 임팩트에서 배트를 몸쪽으로 당겨 반발을 죽인다
  const give = track(k, [
    [0.3, 0],
    [0.42, 1],
    [0.66, 0.3],
    [1, 0.18],
  ]);

  const hipY = lerp(-0.18, 0.56, sq);
  const torsoY = lerp(-0.24, 0.7, sq);

  p.hipDrop = lerp(-0.1, -0.24, sq) - crouch * 0.3;
  p.hipRot = [0, hipY, 0];
  p.torso = [lerp(0.14, 0.27, sq) + give * 0.04, torsoY, lerp(-0.04, 0, sq)];
  // 고개는 배트 위로 공을 끝까지 따라본다 (절대 시선을 먼저 정하고 목을 역산)
  p.head = [lerp(0.05, -0.14, sq), GAZE_AT_PITCHER - (hipY + torsoY), 0];
  // 플레이트 쪽으로 반 발 붙으며 상체가 앞으로 나간다
  p.root = [0.03 * sq, 0, 0.05 * sq];

  // 두 발이 투수를 향해 나란해지고, 낮추는 일은 전부 무릎이 한다
  p.legL = {
    hip: [lerp(-0.1, -0.2, sq), lerp(-0.12, -0.34, sq), lerp(-0.3, -0.36, sq)],
    knee: lerp(0.48, 0.95, sq) + crouch,
    ankle: lerp(0, -0.42, sq),
  };
  p.legR = {
    hip: [lerp(0.12, -0.12, sq), lerp(0.1, 0.3, sq), lerp(0.3, 0.36, sq)],
    knee: lerp(0.34, 0.9, sq) + crouch,
    ankle: lerp(0, -0.42, sq),
  };

  // 배트: 어깨에서 내려와 가슴 앞에 가로로 눕는다.
  // 배트 로컬 +Y가 배럴이므로 Z를 +90도 가까이 돌리면 배럴이 몸통 -X(1루 쪽)를
  // 향하고 노브가 +X(3루 쪽)에 남는다. 90도에서 조금 모자라게 둬야 배럴이
  // 손보다 위에 서서 타구가 땅으로 깔린다.
  // 시작값은 battingPose의 배트 앵커와 같아야 한다 — 두 포즈가 블렌드로 이어지므로
  // 여기만 옛 위치(가슴 뒤)에 남으면 스퀘어로 들어가는 동안 팔이 몸을 뚫고 지나간다.
  const batX = lerp(-0.18, 0.07, sq);
  const batY = lerp(0.22, 0.13, sq) - crouch * 0.04 - give * 0.02;
  const batZ = lerp(0.26, 0.31, sq) - give * 0.055;
  p.bat = {
    pos: [batX, batY, batZ],
    rot: [lerp(-0.22, 0.02, sq), lerp(-0.5, 0.3, sq), lerp(0.62, 1.28, sq) + give * 0.07],
    grip: [-0.03, lerp(0.11, 0.3, sq)],
  };
  p.topHand = 'L';
  // 팔꿈치를 아래·바깥으로 떨어뜨려 배트를 눈 아래에서 받친다.
  // 배트를 몸 앞에 두는 자세이므로 팔꿈치도 앞(+Z)으로 나와야 팔이 가슴을 안 스친다.
  //
  // 출발점은 타격 스탠스의 팔꿈치 방향이어야 한다 — sq=0이면 아직 스탠스 그대로인데
  // 여기서만 다른 pole을 쓰면 첫 몇 프레임 동안 팔이 가슴을 스치고 지나간다.
  const squarePole = (from: V3, sign: number): V3 => [
    lerp(from[0], sign * 0.6, sq),
    lerp(from[1], -1, sq),
    lerp(from[2], 0.35, sq),
  ];
  p.armL = { pole: squarePole(sideRole(-1, true), -1) };
  p.armR = { pole: squarePole(sideRole(1, false), 1) };
  p.ground = true;
  return p;
}

/**
 * 셋포지션. 글러브를 가슴 앞에 모으고 사인을 본다.
 *
 * **폼마다 다르다.** 실제로도 슬롯이 낮은 투수는 셋에서 이미 낮게 앉아 글러브를
 * 허리 앞에 두고(거기서 몸을 더 기울여 던진다), 오버스로는 꼿꼿이 서서 가슴 높이에
 * 모은다. 예전에는 이 함수가 `clock`만 받아 **다섯 폼이 완전히 같았고**, 커스터마이징
 * 미리보기에서 셋 구간(루프의 27%) 내내 무엇을 골라도 같은 그림이었다.
 *
 * 웅크림은 **양 무릎으로** 만든다 — `hipDrop`은 ground:true에서 접지 보정과 상쇄되어
 * 아무 효과가 없고, 한쪽 무릎만 굽히면 그 발이 접지 기준에서 빠진다
 * (`Pose.hipDrop` 주석 참고).
 */
function pitchingSetPose(player: Player, clock: number): Pose {
  const p = basePose();
  const form = clamp(player.form, 0, 4);
  const sink = SET_SINK[form];
  const coil = SET_COIL[form];

  const breath = Math.sin(clock * 1.7) * 0.5 + 0.5;
  // 사인을 확인하는 짧은 고개 움직임
  const peek = Math.sin(clock * 0.62);

  const hipY = 0.12 + coil * 0.5;
  const torsoY = 0.16 + coil * 0.4;
  p.hipDrop = -0.05 - breath * 0.015;
  p.hipRot = [0, hipY, 0];
  // 낮게 앉을수록 상체가 앞으로 나오고 던지는 팔 쪽으로 살짝 기운다
  p.torso = [0.08 + breath * 0.03 + sink * 0.34, torsoY, -sink * 0.1];
  // 몸을 숙이든 감든 시선은 포수에 남는다 (절대 방향을 정하고 목을 역산)
  p.head = [
    0.04 - breath * 0.03 - sink * 0.34,
    clamp(-0.14 + peek * 0.12 - (hipY + torsoY - 0.28), -0.85, 0.85),
    0,
  ];
  // 무릎을 접어 낮아지고, 그만큼 발을 조금 넓게 벌린다
  p.legL = {
    hip: [0.05 - sink * 0.3, -0.08, -0.12 - sink * 0.1],
    knee: 0.24 + sink * 1.0,
    ankle: 0,
  };
  p.legR = {
    hip: [-0.05 - sink * 0.3, 0.1, 0.14 + sink * 0.1],
    knee: 0.2 + sink * 1.0,
    ankle: 0,
  };

  // 글러브를 몸 앞에 두고 양손을 그 안에 모은다.
  // 오버스로는 가슴, 서브마린은 허리 앞이다.
  const gy = 0.14 - sink * 0.14 + breath * 0.025;
  const gz = 0.22 + sink * 0.05;
  p.glove = { pos: [0.02, gy, gz], rot: [0.2 + sink * 0.35, -0.2, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.03, gy - 0.04, gz - 0.02], pole: [-0.7, -0.6, -0.3] };
  p.ground = true;
  return p;
}

/**
 * 와인드업 -> 릴리스 -> 팔로스루.
 * 기준은 우투수(던지는 팔이 -X, 글러브가 +X). t는 0~1이고 RELEASE_AT에서 공을 놓는다.
 */
export const RELEASE_AT = 0.56;

/**
 * 폼별 "셋에서 이미 앉아 있는 정도" (0=꼿꼿이 섬, 1=깊게 앉음).
 *
 * 셋포즈와 딜리버리의 **시작 손 위치가 이 값을 함께 봐야** 한다. 안 그러면
 * 셋에서 허리 앞에 모아 둔 손이 딜리버리 첫 프레임에 가슴으로 순간이동한다
 * (서브마린에서 24cm였다).
 */
const SET_SINK = [0, 0.1, 0.42, 0.8, 0.16];
/** 토네이도만 앞어깨를 닫고 선다 (곧바로 등을 크게 보이므로) */
const SET_COIL = [0, 0, 0, 0, 0.3];

/**
 * 릴리스 순간의 골반·몸통 각도. 아래 트랙의 `rel` 키와 **반드시 같은 값이어야 한다** —
 * 팔 슬롯을 이 자세에서 역산하기 때문이다.
 */
const REL_HIP_Y = -0.42;
const REL_TORSO_Y = -0.5;
const REL_TORSO_X = 0.34;

function pitchingPose(player: Player, t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const form = clamp(player.form, 0, 4);

  /**
   * 팔 슬롯 — 릴리스에서 팔이 **월드 수직에서 벗어나는 각도**다.
   * 0=머리 위(오버스로), π/2=수평(사이드암), 그 이상=수평 아래(언더핸드).
   *
   * 예전에는 이 값을 몸통 **로컬** 방향으로 그대로 썼는데, 그러면 상체 기울기가
   * 슬롯을 먹어 버린다. tiltAmt가 슬롯에 비례해 커지고, 기울면 던지는 어깨가 올라가
   * 팔이 다시 서기 때문이다. 두 효과가 상쇄해서 **화면에서 실제로 측정한 팔 각도가
   * 오버스로 31.9° / 스리쿼터 35.8°로 붙어 버렸고**(설정값은 23° 차이였다),
   * 언더핸드는 78.2°로 사이드암 자리에 있었다. 다섯 폼이 사실상 세 개였던 셈이다.
   *
   * 지금은 시선(p.head)과 같은 방식이다 — 월드에서 원하는 각도를 먼저 정하고
   * 몸통 회전을 역산해 로컬 목표로 되돌린다. 기울기를 어떻게 바꾸든 슬롯은 유지된다.
   */
  const slot = [0.22, 0.72, 1.42, 1.86, 0.28][form];
  // 토네이도는 와인드업에서 등을 크게 보인다
  const turnAway = form === 4 ? 1.25 : 0.55;

  const rel = RELEASE_AT;

  /**
   * 딜리버리는 **그 폼의 셋포지션에서 출발한다.**
   *
   * 셋 -> 릴리스 전환 블렌드는 0.06초뿐이다(터지는 동작이라 일부러 짧다). 그래서
   * 시작 자세가 셋과 어긋나면 그 차이를 60ms 만에 메우느라 튄다 — 낮게 앉아 있던
   * 서브마린이 첫 프레임에 벌떡 일어서며 손이 16cm 순간이동했다.
   * 셋의 자세 편차를 여기에 얹고 레그킥이 시작되는 0.22까지 자연스럽게 푼다.
   */
  const sink = SET_SINK[form];
  const coil = SET_COIL[form];
  const fromSet = smoothTrack(k, [
    [0, 1],
    [0.22, 0],
    [1, 0],
  ]);

  // ---- 몸통/골반 -------------------------------------------------------
  // 여기부터 아래까지 전부 smoothTrack이다. track(구간마다 easeInOut)을 쓰면 키를
  // 지날 때마다 각속도가 0으로 떨어져서, 몸이 "돌다 멈추다"를 반복하는 스톱모션이 된다.
  // 골반이 먼저 열리고 몸통이 따라 도는 분리(separation)는 키 시각으로 유지된다.
  const hipY = smoothTrack(k, [
    [0, 0.1],
    [0.24, turnAway * 0.55],
    [rel - 0.16, 0.06],
    [rel, REL_HIP_Y],
    [1, -0.72],
  ]);
  const torsoY = smoothTrack(k, [
    [0, 0.16],
    [0.26, turnAway],
    [rel - 0.1, 0.42],
    [rel, REL_TORSO_Y],
    [0.8, -0.9],
    [1, -0.8],
  ]);
  const torsoX = smoothTrack(k, [
    [0, 0.08],
    [0.26, -0.06],
    [rel - 0.08, 0.1],
    [rel, REL_TORSO_X],
    [0.85, 0.66],
    [1, 0.58],
  ]);
  // 던지는 팔(-X) 반대쪽으로 몸을 기울여야 팔이 위로 선다.
  // Z 회전이 음수면 상체가 글러브 쪽(+X)으로 넘어간다. 슬롯이 낮을수록 크게 기운다.
  const tiltAmt = -(0.12 + slot * 0.34);
  const torsoZ = smoothTrack(k, [
    [0, 0],
    [0.3, -0.08],
    [rel, tiltAmt],
    [0.85, tiltAmt * 0.7],
    [1, tiltAmt * 0.4],
  ]);

  p.hipRot = [0, hipY + coil * 0.5 * fromSet, 0];
  p.torso = [
    torsoX + sink * 0.34 * fromSet,
    torsoY + coil * 0.4 * fromSet,
    torsoZ - sink * 0.1 * fromSet,
  ];
  // 시선은 계속 포수를 향한다 — 몸이 돌아도 머리만 남는다.
  //
  // 머리는 몸통 **아래** 골반에도 매달려 있으므로 되돌릴 각도는 둘의 합이다. 예전엔
  // 몸통만 상쇄해서 릴리스 순간 골반이 돌린 0.42rad이 그대로 남았고, 결과적으로
  // **공을 놓는 순간 포수가 아니라 1루 쪽을 보고 있었다**(28도). 타격 포즈들이
  // GAZE_AT_PITCHER로 하는 것과 같은 방식으로 절대 시선을 먼저 정하고 목을 역산한다.
  // 토네이도(form 4)처럼 등을 크게 보이는 폼은 한계각에 걸려 자연히 고개도 같이 돈다.
  p.head = [
    0.02 - sink * 0.34 * fromSet,
    clamp(-(hipY + torsoY + coil * 0.9 * fromSet) * 0.92, -0.85, 0.85),
    -torsoZ * 0.6,
  ];

  // ---- 하체 -------------------------------------------------------------
  // 앞다리(+X 쪽)를 높이 들었다가 홈 쪽으로 내디딘다.
  //
  // lift는 **한 번 올라갔다 한 번 내려와야** 한다. 예전엔 중간에 0.75로 잡아 두는
  // 키가 있었고, 거기에 무릎을 펴는 항이 겹쳐서 들린 발이 0.34 → 0.25 → 0.42로
  // **두 번 차올랐다.** 그게 다리가 덜덜거리는 것처럼 보이던 원인이다.
  const lift = smoothTrack(k, [
    [0, 0],
    [0.3, 1],
    [rel, 0],
    [1, 0],
  ]);
  const strideOut = smoothTrack(k, [
    [0, 0],
    [0.3, 0.08],
    [rel - 0.04, 1],
    [1, 1],
  ]);
  p.legR = {
    // 고관절 X는 **음수여야 무릎이 앞으로 나온다** (다른 무릎 드는 포즈는 전부 음수다:
    // 타자 레그킥 -1.38, 포수 -1.4, 점프 -0.6). 여기만 +1.45라서 허벅지가 골반 뒤로
    // 눕고 정강이가 위로 서는, 무릎을 드는 게 아니라 다리를 뒤로 접어 올리는 자세였다.
    // 스트라이드 항(-strideOut)은 원래부터 맞았으므로 리프트 항만 뒤집는다.
    hip: [
      lerp(-0.1, -1.35, lift) - strideOut * 0.55 - sink * 0.3 * fromSet,
      lerp(0.1, 0.35, lift),
      0.16 + sink * 0.1 * fromSet,
    ],
    // 무릎은 **다리를 든 동안만** 접혀 있다. 펴는 일을 strideOut에 맡기면 허벅지가
    // 아직 최고점일 때 정강이가 펴져서 발끝이 위로 솟는다 — 내딛는 게 아니라 걷어차는
    // 모양이 된다. lift로 접었다 풀고, 스트라이드는 마지막 마무리만 거든다.
    // sink 항은 뒷무릎에도 같이 걸려 있다 — **양쪽을 같이 굽혀야** 골반이 실제로
    // 낮아진다 (한쪽만 굽히면 그 발이 접지 기준에서 빠진다).
    knee: lerp(0.18, 1.7, lift) * (1 - strideOut * 0.35) + 0.12 + sink * fromSet,
    ankle: lerp(0, 0.2, strideOut),
  };
  // 축발(-X)은 밀어내며 뻗었다가 팔로스루에서 뒤로 떠오른다
  const drive = smoothTrack(k, [
    [0, 0],
    [0.3, 0.15],
    [rel, 0.85],
    [0.78, 1],
    [1, 1],
  ]);
  p.legL = {
    hip: [lerp(0.06, -0.72, drive) - sink * 0.3 * fromSet, -0.12, -0.14 - drive * 0.18 - sink * 0.1 * fromSet],
    knee: lerp(0.28, 1.15, drive) + sink * fromSet,
    ankle: lerp(0, -0.5, drive),
  };

  // 골반 높이: 레그킥에서 살짝 올라갔다가 스트라이드에서 크게 내려앉는다
  p.hipDrop = smoothTrack(k, [
    [0, -0.04],
    [0.26, 0.03],
    [rel, -0.24],
    [0.8, -0.2],
    [1, -0.12],
  ]);
  // 몸 전체가 홈(+Z) 쪽으로 이동
  p.root = [0, 0, smoothTrack(k, [
    [0, 0],
    [0.28, -0.06],
    [rel, 0.62],
    [1, 0.95],
  ])];

  // ---- 팔 ---------------------------------------------------------------
  //
  // 던지는 팔은 **하나의 곡선을 하나의 시간축으로** 지난다.
  //
  // 예전에는 구간마다 lerp를 갈아 끼우고 조각마다 easeIn/easeOut을 따로 걸었다.
  // 그 결과 이음매에서 속도가 매번 0으로 떨어져 손이 3.8 → 0.6 → 5.3 → 0.4 → 10.0 m/s로
  // **릴리스까지 네 번 멈췄다 튀었고**, 최고 속도가 릴리스가 아니라 팔을 들어 올리는
  // 중간(11.3 m/s)에 있었다. 던지는 게 아니라 네 토막으로 끊어 옮기는 동작이었다.
  //
  // 지금은 경유점을 곡선으로 잇고 k → 곡선 파라미터만 매핑한다. 경유점 사이 시간을
  // 릴리스로 갈수록 좁혀 두면 속도가 저절로 붙어, 코킹까지 느리게 감다가 릴리스에서
  // 최고가 되고 팔로스루가 받아 감속하는 순서가 나온다.
  const shoulderL = _tmpShoulder.set(-SHOULDER_X, SHOULDER_Y, 0);
  /** 슬롯이 낮을수록 코킹도 낮아진다 (0=오버스로, 1=서브마린) */
  const cockLow = clamp((slot - 0.7) / 1.2, 0, 1);
  /**
   * 낮은 슬롯은 코킹→릴리스 호가 길다(팔을 뒤로 길게 뺐다가 낮게 훑고 나온다).
   * 시간을 오버스로와 똑같이 주면 그 구간만 24 m/s로 튄다 — 60fps에서 한 프레임에
   * 팔 길이만큼 간다는 뜻이다. 그만큼 일찍 감기 시작해 속도를 맞춘다.
   */
  const early = cockLow * 0.035;

  // 릴리스 지점은 어깨에서 슬롯 방향으로 팔을 거의 다 편 곳.
  // 앞(+Z) 성분을 크게 주면 팔이 앞으로 눕기만 하고 "위에서 내리꽂는" 느낌이 사라진다.
  //
  // 방향은 **월드(모델 로컬) 기준**으로 세운 뒤, 릴리스 순간의 골반·몸통 회전을
  // 벗겨서 몸통 로컬로 되돌린다. 이렇게 해야 상체를 아무리 기울여도 팔이 놓이는
  // 각도가 슬롯 그대로 남는다 (역산 방향: 월드 = 골반 · 몸통 · 로컬).
  // **이 식을 건드리면 pitching.ts의 releasePoint 표를 다시 재야 한다.**
  const relRot = _tmpQ
    .setFromEuler(_tmpE.set(0, REL_HIP_Y, 0, 'XYZ'))
    .multiply(_tmpQ2.setFromEuler(_tmpE.set(REL_TORSO_X, REL_TORSO_Y, tiltAmt, 'YXZ')))
    .invert();
  const release = _tmpRelease
    .set(-Math.sin(slot), Math.cos(slot), 0.26)
    .normalize()
    .applyQuaternion(relRot)
    .multiplyScalar(ARM_REACH * 0.97)
    .add(shoulderL);

  // 시작점은 **그 폼의 셋포지션 손 위치**다. 서브마린은 허리 앞에서 출발한다.
  _throwPath
    .set(0, -0.04, 0.12 - sink * 0.14, 0.2 + sink * 0.05) // 글러브 안에 모은 손
    .set(1, -0.22, -0.11, 0.05) // 분리 — 손이 갈라져 아래로
    // 스윙 최저점. 낮은 슬롯은 코킹이 이 근처까지 내려오므로, 최저점을 몸 아래로
    // 당겨 둘을 떼어 놓는다. 붙여 두면 그 구간에서 손이 0.8m/s로 기어간다.
    .set(2, -0.44, -0.18 - cockLow * 0.06, -0.3 + cockLow * 0.16) // 팔 스윙 최저점 (엉덩이 뒤)
    // 코킹도 슬롯을 따라간다. 낮은 슬롯이 오버스로처럼 어깨 위로 팔을 올렸다가
    // 아래로 던지면, 그 한 구간에서만 손이 20 m/s를 넘고(다른 폼의 두 배다) 무엇보다
    // 그렇게 던지는 투수가 없다 — 낮은 슬롯은 처음부터 낮은 원을 그린다.
    // 코킹 — 오버스로는 어깨 위, 서브마린은 옆으로 뻗어 뒤로. 릴리스와 마찬가지로
    // **어깨에서 방향+거리로** 잡는다. 절대 좌표로 두면 슬롯을 낮출 때 팔 길이를
    // 넘어서 IK가 포화되고, 궤적이 한 점에서 되꺾여 손이 거기서 멈춘다.
    // (cockLow=0이면 예전 값 (-0.34, 0.34, -0.44)과 정확히 같다)
    .setV(
      3,
      _tmpCock
        .set(-0.19 - cockLow * 0.43, 0.296 - cockLow * 0.58, -0.931 + cockLow * 0.2)
        .normalize()
        .multiplyScalar(ARM_REACH * 0.86)
        .add(shoulderL),
    )
    .setV(4, release)
    // 팔로스루는 반대쪽 허리까지 채찍처럼 내려온다. 릴리스에서 곧장 허리로 이으면
    // 그 선이 **자기 어깨에서 13cm 이내를 지나가** 팔이 어깨 관절을 뚫는다.
    // 몸 앞·아래의 경유점으로 바깥으로 돌려 내린다.
    .setV(5, _tmpAcross.set(-0.16, -0.5, 0.85).normalize().multiplyScalar(ARM_REACH * 0.92).add(shoulderL))
    // 끝점은 반대쪽 허리 **앞**이다. Z가 작으면 손이 배 옆구리에 파묻힌다.
    .setV(6, _tmpFinish.set(0.78, -0.6, 0.7).normalize().multiplyScalar(ARM_REACH * 0.9).add(shoulderL));

  // 경유점 i는 u = i/6에 있다. 코킹(3)까지는 넉넉히 주고 릴리스(4)까지를 가장 짧게
  // 잡아 그 구간에서만 속도가 치솟게 한다 (코킹→릴리스가 80ms, 실제 투수의
  // 가속 구간과 같은 정도다).
  //
  // 마지막 두 키가 둘 다 u=1인 건 오타가 아니다 — 값이 같은 구간에서는 접선이 0이
  // 되므로, 팔이 끝점에 **감속하며 안착한다.** 이게 없으면 손이 1.6 m/s로 움직이던
  // 채로 k=1에서 딱 멈춰서 마지막에 한 번 튄다.
  const armLTarget = _throwPath.at(
    smoothTrack(k, [
      [0, 0],
      [0.18, 1 / 6],
      [0.35 - early * 0.7, 2 / 6],
      [0.48 - early, 3 / 6],
      [rel, 4 / 6],
      [0.75, 5 / 6],
      [0.92, 1],
      [1, 1],
    ]),
  );
  p.armL = {
    target: [armLTarget.x, armLTarget.y, armLTarget.z],
    // 릴리스 전후로 팔꿈치가 서는 평면이 바뀐다. 예전엔 이걸 삼항 연산자로 **한
    // 프레임에** 뒤집어서 팔꿈치가 25cm씩 순간이동했다. 방향끼리 섞어 넘어간다.
    pole: mixDir(POLE_SLOT_DOWN, POLE_SLOT_UP, smoothTrack(k, [
      [0, 0],
      [rel - 0.18, 0],
      [rel - 0.02, 1],
      [rel + 0.08, 1],
      [rel + 0.32, 0],
    ])),
  };

  // 글러브 팔도 같은 방식이다. 예전엔 k=0.22부터 릴리스까지 **한 자리에 굳어 있었다**
  // (전체의 3분의 1인 0.3초). 실제로는 타깃을 향해 뻗었다가 릴리스에 맞춰 가슴으로
  // 세게 당기는 이 팔이 회전을 만든다 — 여기가 멈춰 있으면 상체가 혼자 도는 것처럼 보인다.
  const gl = _glovePath
    .set(0, 0.02, 0.14 - sink * 0.14, 0.22 + sink * 0.05) // 셋에서 모아 둔 자리
    .set(1, 0.22, 0.29, 0.35) // 레그킥에서 함께 들어 올린다
    .set(2, 0.17, 0.23, 0.5) // 스트라이드 — 타깃 쪽으로 뻗는다
    .set(3, 0.27, 0.07, 0.2) // 릴리스에 맞춰 당기기 시작
    .set(4, 0.3, -0.02, 0.04) // 옆구리에 붙는다
    .at(
      smoothTrack(k, [
        [0, 0],
        [0.26, 0.25],
        [0.48, 0.5],
        [rel + 0.06, 0.75],
        [0.86, 1],
        [1, 1],
      ]),
    );
  p.glove = {
    pos: [gl.x, gl.y, gl.z],
    rot: [0.1, -0.5 + k * 0.5, 0],
  };
  p.gloveHand = 'R';
  // 축발/앞발 중 낮은 쪽이 항상 지면에 닿게 한다 (레그킥·스트라이드 모두 대응)
  p.ground = true;
  return p;
}

/**
 * 수비 준비 자세.
 * 무릎을 굽힌 채 좌우로 체중을 옮기고 잔발을 밟는다 — 가만히 서 있으면
 * 마네킹처럼 보이는 게 야수 9명 중 8명이라 화면 전체가 죽는다.
 */
function fieldingPose(clock: number): Pose {
  const p = basePose();
  const bob = Math.sin(clock * 3.4) * 0.5 + 0.5;
  const shift = Math.sin(clock * 1.15);
  const peek = Math.sin(clock * 0.47);

  p.hipDrop = -0.05 - bob * 0.05;
  p.hipRot = [0, shift * 0.07, shift * 0.05];
  p.torso = [0.42 - bob * 0.04, -shift * 0.1, -shift * 0.04];
  p.head = [-0.26 + bob * 0.03, peek * 0.16, 0];
  // 무릎을 앞으로 굽혀 발이 몸 아래에 오게 한다
  p.legL = { hip: [-0.15, -0.05, -0.26], knee: 0.95 + bob * 0.1, ankle: -0.5 };
  p.legR = { hip: [-0.15, 0.05, 0.26], knee: 0.95 + bob * 0.1 * 0.6, ankle: -0.5 };
  p.glove = { pos: [0.2 + shift * 0.04, -0.18 + bob * 0.03, 0.34], rot: [0.9, -0.3, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.24 + shift * 0.04, -0.2 + bob * 0.03, 0.3], pole: [-1, -0.4, -0.4] };
  p.ground = true;
  return p;
}

/** 포수 크라우칭 */
function catchingPose(clock: number): Pose {
  const p = basePose();
  const breath = Math.sin(clock * 2.1) * 0.5 + 0.5;
  const target = Math.sin(clock * 0.83);
  p.hipDrop = 0.02 - breath * 0.02;
  p.hipRot = [0, 0, 0];
  p.torso = [0.24 - breath * 0.03, 0, 0];
  p.head = [-0.1, 0, 0];
  // 고관절 X가 음수여야 무릎이 앞으로 나온다. 양수로 주면 발이 엉덩이보다 높아져
  // 접지 보정이 골반을 지면 아래로 끌어내린다.
  p.legL = { hip: [-1.4, -0.12, -0.42], knee: 2.2, ankle: -0.8 };
  p.legR = { hip: [-1.4, 0.12, 0.42], knee: 2.2, ankle: -0.8 };
  // 미트로 코스를 잡아 준다
  p.glove = { pos: [0.12 + target * 0.08, 0.08 + breath * 0.03, 0.42], rot: [0.1, -0.2, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.3, -0.14, 0.06], pole: [-1, -0.3, -0.5] };
  p.ground = true;
  return p;
}

/**
 * 접지 보폭의 절반 (모델 로컬). 발은 스탠스 동안 +RUN_REACH에서 -RUN_REACH까지 뒤로 흐른다.
 *
 * 한 주기(양발 1회)에 몸이 나아가는 거리는 4 x RUN_REACH x BODY 이고, playback의
 * RUN_STRIDE가 그 값이다. **둘이 어긋나면 그만큼 발이 미끄러진다** — 한쪽만 고치지 말 것.
 *
 * 이 다리 길이(0.82)로 이만큼 뻗으려면 골반이 상당히 내려앉아야 한다(아래 hipDrop).
 * SD 비율에서는 그게 오히려 "힘껏 달린다"로 읽혀서 잘 맞는다.
 */
const RUN_REACH = RUN_STRIDE / (4 * BODY);
/** 한 걸음 중 발이 땅에 붙어 있는 비율. 나머지가 유각기이고, 겹치지 않는 틈이 도약 구간이다. */
const RUN_STANCE = 0.46;

/**
 * 달리기 사이클. t는 0~1이 한 걸음 주기(양발 1회).
 * intensity로 전력질주(1)와 조깅(0.4)을 구분한다.
 *
 * **발은 고관절 각도가 아니라 IK 목표로 놓는다.** 각도를 사인파로 흔들면 보폭이
 * 이동 거리와 무관해져서 발이 반드시 미끄러진다(그게 예전 모습이었다). 접지한 발의
 * 좌표를 직접 지정하면 미끄러짐이 정의상 0이 된다.
 */
function runningPose(t: number, intensity: number): Pose {
  const p = basePose();
  const q = clamp(intensity, 0.25, 1.2);
  const ph = t * TAU;

  // 보폭을 내려면 골반이 내려앉아야 한다 (다리를 다 뻗으면 IK가 포화된다)
  const hipDrop = -0.15 - 0.05 * q;
  /** 발목이 지면에 놓일 때의 높이 (골반 원점 기준) */
  const gy = -(HIP_H + hipDrop) + FOOT_DROP;

  /** phase 0 = 앞발 접지 순간 */
  const legPhase = (u: number, sign: number): LegPose => {
    const k = ((u % 1) + 1) % 1;
    let z: number;
    let y: number;
    if (k < RUN_STANCE) {
      // 접지: 발은 그 자리에 있고 몸이 지나간다 → 모델 로컬에서는 등속으로 뒤로 흐른다
      z = RUN_REACH - 2 * RUN_REACH * (k / RUN_STANCE);
      y = gy;
    } else {
      // 유각: 뒤에서 걷어 올려 무릎을 접었다가 앞으로 뻗어 내려놓는다
      const s = (k - RUN_STANCE) / (1 - RUN_STANCE);
      z = track(s, [
        [0, -RUN_REACH],
        [0.32, -RUN_REACH * 0.2],
        [0.72, RUN_REACH * 0.86],
        [1, RUN_REACH],
      ]);
      y =
        gy +
        track(s, [
          [0, 0],
          [0.18, 0.16 + 0.14 * q],
          [0.45, 0.2 + 0.16 * q],
          [0.78, 0.1 + 0.08 * q],
          [1, 0],
        ]);
    }
    return {
      hip: [0, 0, 0],
      knee: 0,
      // 접지 후반부터 발끝으로 밀어낸다. IK가 정강이 기울기를 상쇄해 주므로 여기엔 추가분만 준다.
      // (상쇄만 있으면 뒤로 뻗은 발이 끝까지 바닥에 납작하게 붙어 밀어내는 힘이 안 보인다)
      ankle: track(k, [
        [0, -0.14],
        [0.12, 0],
        [0.28, 0.08],
        [0.4, 0.34],
        [RUN_STANCE, 0.62 + 0.2 * q],
        [RUN_STANCE + 0.14, 0.05],
        [0.86, -0.2],
        [1, -0.14],
      ]),
      ikTarget: [sign * 0.085, y, z],
      ikPole: [sign * 0.28, 0.18, 1],
    };
  };
  // L(-X)과 R(+X)은 반 주기 엇갈린다
  p.legL = legPhase(t, -1);
  p.legR = legPhase(t + 0.5, 1);

  // 두 발이 모두 떠 있는 구간에서는 접지 보정이 알아서 몸을 띄운다 (도약).
  p.hipDrop = hipDrop;
  // 골반은 비틀리고 동시에 착지 쪽으로 기운다 (트렌델렌버그)
  p.hipRot = [0, -Math.sin(ph) * 0.16, Math.cos(ph) * 0.07 * q];
  p.torso = [0.2 + 0.18 * q, Math.sin(ph) * 0.26, -Math.cos(ph) * 0.06 * q];
  // 머리는 흔들리는 몸통 위에서 수평을 유지한다
  p.head = [-0.16 - 0.1 * q, -Math.sin(ph) * 0.1, Math.cos(ph) * 0.05 * q];

  // 팔 펌핑: 다리와 반대 위상. 앞으로 나올 때 팔꿈치가 더 접히고 몸 안쪽으로 들어온다.
  const armSwing = 0.55 + 0.45 * q;
  const fold = (s: number) => -1.35 - 0.3 * q - Math.max(0, s) * (0.45 + 0.25 * q);
  const sL = -Math.sin(ph);
  const sR = Math.sin(ph);
  p.armL = {
    euler: [sL * armSwing - 0.15, Math.max(0, sL) * 0.3, 0.12 + Math.max(0, sL) * 0.1],
    elbow: fold(sL),
  };
  p.armR = {
    euler: [sR * armSwing - 0.15, -Math.max(0, sR) * 0.3, -0.12 - Math.max(0, sR) * 0.1],
    elbow: fold(sR),
  };
  p.ground = true;
  return p;
}

/**
 * 야수 송구. t=0 글러브에서 공을 빼고 -> THROW_RELEASE_AT 릴리스 -> 1 팔로스루.
 *
 * **이 동작이 없어서 공이 야수 손에서 순간이동했다.** 투구(pitchingPose)와 같은 좌표
 * 규약을 쓴다 — 던지는 팔이 -X, 글러브가 +X이고 좌투는 buildPose가 통째로 뒤집는다.
 * 투구와 달리 와인드업이 없고 스텝이 짧다(크로우홉).
 *
 * playback이 이 값으로 릴리스 순간을 공이 손을 떠나는 시각에 맞춘다.
 */
export const THROW_RELEASE_AT = 0.44;

function throwingPose(t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const rel = THROW_RELEASE_AT;

  // 몸통: 던지는 팔 쪽으로 감았다가 홈 쪽으로 열린다
  const torsoY = track(k, [
    [0, 0.2],
    [0.22, 0.62],
    [rel - 0.06, 0.3],
    [rel, -0.45],
    [0.75, -0.8],
    [1, -0.7],
  ]);
  const torsoX = track(k, [
    [0, 0.12],
    [0.24, -0.02],
    [rel, 0.3],
    [0.8, 0.62],
    [1, 0.52],
  ]);
  // 던지는 팔 반대쪽으로 기울어야 팔이 위에서 나온다
  const torsoZ = track(k, [
    [0, 0],
    [rel, -0.24],
    [0.85, -0.18],
    [1, -0.1],
  ]);
  p.hipRot = [0, track(k, [
    [0, 0.14],
    [0.24, 0.42],
    [rel, -0.34],
    [1, -0.58],
  ]), 0];
  p.torso = [torsoX, torsoY, torsoZ];
  p.head = [0.02, clamp(-torsoY * 0.9, -0.8, 0.8), -torsoZ * 0.5];

  // 하체: 앞발(+X)을 내디디며 체중을 옮긴다
  const stride = track(k, [
    [0, 0],
    [0.2, 0.3],
    [rel - 0.04, 1],
    [1, 1],
  ]);
  p.legR = {
    hip: [lerp(0.24, -0.5, stride), 0.22, 0.2],
    knee: lerp(0.7, 0.3, stride),
    ankle: 0,
  };
  p.legL = {
    hip: [lerp(-0.1, 0.36, stride), -0.16, -0.2],
    knee: lerp(0.34, 0.9, stride),
    ankle: lerp(0, -0.42, stride),
  };
  p.hipDrop = track(k, [
    [0, -0.08],
    [0.24, -0.02],
    [rel, -0.2],
    [1, -0.12],
  ]);
  p.root = [0, 0, track(k, [
    [0, 0],
    [0.22, 0.04],
    [rel, 0.42],
    [1, 0.6],
  ])];

  // 던지는 팔: 글러브 -> 아래로 빼서 뒤로 -> 위로 채고 -> 몸 앞을 가로지른다
  const shoulderL = new THREE.Vector3(-SHOULDER_X, SHOULDER_Y, 0);
  const cock = new THREE.Vector3(-0.32, 0.32, -0.4);
  const release = new THREE.Vector3(-0.34, 0.92, 0.24)
    .normalize()
    .multiplyScalar(ARM_REACH * 0.96)
    .add(shoulderL);
  let armLTarget: THREE.Vector3;
  if (k < 0.16) {
    // 글러브 앞에 모았다가 아래로 뺀다. 손이 가슴 앞을 지나므로 팔꿈치도 바깥으로
    // 벌려 줘야 위팔이 갈비뼈를 스치지 않는다 (그래서 여기만 pole을 따로 준다).
    armLTarget = new THREE.Vector3(0.02, 0.14, 0.24).lerp(
      new THREE.Vector3(-0.24, -0.1, 0.02),
      easeInOut(span(k, 0, 0.16)),
    );
  } else if (k < rel - 0.14) {
    armLTarget = new THREE.Vector3(-0.2, -0.1, -0.06).lerp(cock, easeOut(span(k, 0.16, rel - 0.14)));
  } else if (k < rel) {
    armLTarget = cock.clone().lerp(release, whip(span(k, rel - 0.14, rel)));
  } else {
    // 투구와 같은 이유로 경유점을 둔다 — 릴리스에서 반대쪽 허리로 직선을 그으면
    // 그 선분이 자기 어깨와 머리를 스치고 지나간다.
    const across = new THREE.Vector3(-0.16, -0.45, 0.88)
      .normalize()
      .multiplyScalar(ARM_REACH * 0.92)
      .add(shoulderL);
    const finish = new THREE.Vector3(0.74, -0.62, 0.7)
      .normalize()
      .multiplyScalar(ARM_REACH * 0.9)
      .add(shoulderL);
    const mid = rel + 0.2;
    armLTarget =
      k < mid
        ? release.clone().lerp(across, easeOut(span(k, rel, mid)))
        : across.clone().lerp(finish, easeInOut(span(k, mid, 0.9)));
  }
  p.armL = {
    target: [armLTarget.x, armLTarget.y, armLTarget.z],
    pole: mixDir(
      mixDir(POLE_SLOT_OUT, POLE_SLOT_DOWN, span(k, 0.06, 0.24)),
      POLE_SLOT_UP,
      track(k, [
        [0, 0],
        [rel - 0.2, 0],
        [rel - 0.02, 1],
        [rel + 0.08, 1],
        [rel + 0.3, 0],
      ]),
    ),
  };

  // 글러브 팔: 목표를 겨눴다가 릴리스에서 가슴으로 당긴다
  const gl = new THREE.Vector3(0.2, 0.24, 0.42).lerp(
    new THREE.Vector3(0.3, 0.0, 0.04),
    easeOut(span(k, rel - 0.04, rel + 0.2)),
  );
  p.glove = { pos: [gl.x, gl.y, gl.z], rot: [0.15, -0.4 + k * 0.4, 0] };
  p.gloveHand = 'R';
  p.ground = true;
  return p;
}

/**
 * 다이빙 캐치. t=0 도약 -> 0.4 최대 신장(공중) -> 0.7 착지 -> 1 지면.
 *
 * 글러브 쪽(+X)으로 몸을 던진다. 공중에 있는 동안은 접지 보정을 끈다.
 */
function divingPose(t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  // 몸이 수평으로 눕는 정도
  const lay = track(k, [
    [0, 0],
    [0.35, 1],
    [1, 1],
  ]);
  // 공중에 뜬 높이
  const air = track(k, [
    [0, 0],
    [0.2, 0.34],
    [0.42, 0.3],
    [0.72, 0],
    [1, -0.02],
  ]);
  // 눕기 전(lay=0)에는 아직 수비 자세로 서 있는데 접지 보정이 꺼져 있어 발이 2cm
  // 잠긴다. 그 구간만 세워 주고, 몸이 눕기 시작하면 air가 높이를 넘겨받는다.
  p.root = [lerp(0, 0.5, lay), air + lerp(0.027, 0, lay), lerp(0, 0.34, lay)];
  p.hipDrop = lerp(-0.25, -0.62, lay);
  p.hipRot = [0, -0.2 * lay, -0.5 * lay];
  // Z 회전이 음수면 몸이 +X(글러브 쪽)로 넘어간다
  p.torso = [0.5 - 0.2 * lay, -0.3 * lay, -0.85 * lay];
  p.head = [-0.5 - 0.2 * lay, 0.3 * lay, 0.4 * lay];
  // 다리는 뒤로 뻗어 채찍처럼 따라온다.
  // 몸이 눕는 만큼 고관절도 같이 펴져야 발이 지면 위에 남는다.
  p.legL = { hip: [0.5 + 0.95 * lay, -0.1, -0.22], knee: 0.5 - 0.35 * lay, ankle: 0.2 };
  p.legR = { hip: [0.35 + 1.0 * lay, 0.12, 0.3], knee: 0.8 - 0.2 * lay, ankle: 0.2 };
  // 글러브를 진행 방향 끝까지 뻗는다
  p.glove = { pos: [0.34 + 0.12 * lay, 0.1 - 0.34 * lay, 0.4], rot: [0.5, -0.5, -0.4] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.3, -0.18 - 0.1 * lay, 0.24], pole: [-1, -0.4, -0.4] };
  p.ground = false;
  return p;
}

/** 헤드퍼스트 슬라이딩. 두 팔을 베이스로 뻗고 배로 미끄러진다. */
function headSlidePose(t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  // 낮게 깔리는 정도
  const dive = track(k, [
    [0, 0.3],
    [0.35, 1],
    [1, 1],
  ]);
  p.root = [0, lerp(0.12, 0, dive), 0];
  p.hipDrop = lerp(-0.35, -0.66, dive);
  p.hipRot = [0, 0, 0];
  // 몸통을 엎어 눕힌다.
  //
  // 부호가 반대로 들어가 있었다. 몸통 X가 **양수**여야 로컬 +Y가 진행 방향(+Z)을
  // 가리키고 가슴이 아래를 본다. 음수면 가슴이 하늘을 보고 로컬 +Y가 뒤를 가리켜서,
  // 아래 팔 목표(+Y 방향)가 통째로 **뒤로** 뻗는다 — 베이스로 손을 뻗는 게 아니라
  // 뒤로 젖히고 미끄러지는 자세였다. 다른 포즈들도 전부 양수로 가슴을 숙인다
  // (수비 0.42, 주심 0.62).
  p.torso = [lerp(0.6, 1.15, dive), 0, 0];
  // 고개는 들어 베이스를 본다 (엎드린 몸통 기준이라 음수가 '든다')
  p.head = [lerp(-0.5, -0.95, dive), 0, 0];
  // 다리는 몸을 따라 **수평으로** 끌려간다. 0.6 정도로는 허벅지가 여전히 아래를
  // 향해서, 골반이 낮아진 만큼 무릎과 발이 그대로 지면 밑으로 들어갔다(발바닥 -0.41m).
  // 엎드린 자세에서는 고관절이 거의 직각으로 펴져야 한다.
  p.legL = { hip: [lerp(0.62, 1.42, dive), -0.05, -0.16], knee: 0.5 - 0.2 * dive, ankle: 0.3 };
  p.legR = { hip: [lerp(0.5, 1.32, dive), 0.05, 0.2], knee: 0.7 - 0.3 * dive, ankle: 0.3 };
  // 두 팔을 앞으로 쭉 (몸통이 누웠으므로 몸통 로컬 +Y가 진행 방향이다)
  // 팔은 머리 **옆**으로 지나가야 한다. SD 비율이라 머리 반지름이 0.26이나 돼서
  // ±0.22로는 팔뚝이 머리를 관통했다.
  const reach = lerp(0.4, 0.62, dive);
  p.armL = { target: [-0.31, reach, 0.12], pole: [-1, 0.2, -0.6] };
  p.armR = { target: [0.31, reach, 0.12], pole: [1, 0.2, -0.6] };
  p.ground = false;
  return p;
}

/** 베이스를 밟고 글러브를 낮게 대는 태그 자세 */
function tagPose(clock: number): Pose {
  const p = basePose();
  const b = Math.sin(clock * 2.6) * 0.5 + 0.5;
  p.hipDrop = -0.24 - b * 0.03;
  p.hipRot = [0, 0.12, 0];
  p.torso = [0.5, -0.1, 0];
  p.head = [-0.34, 0.08, 0];
  p.legL = { hip: [-0.34, -0.1, -0.34], knee: 0.95, ankle: -0.5 };
  p.legR = { hip: [-0.1, 0.14, 0.36], knee: 0.7, ankle: -0.3 };
  // 미트를 발치 앞에 붙여 태그를 기다린다
  p.glove = { pos: [0.14, -0.34, 0.34], rot: [1.2, -0.2, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.34, -0.02, 0.14], pole: [-1, -0.2, -0.6] };
  p.ground = true;
  return p;
}

/** 점프 캐치. t=0 웅크림 -> 0.35 최고점 -> 1 착지 */
function jumpPose(t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const air = track(k, [
    [0, 0],
    [0.12, 0],
    [0.38, 0.52],
    [0.7, 0.2],
    [0.9, 0],
    [1, 0],
  ]);
  const up = clamp(air / 0.52, 0, 1);
  // 도약 전 웅크림. 예전엔 air를 -0.06까지 내려 표현했는데, 접지 보정이 꺼져 있어
  // 그게 그대로 **발을 지면 밑으로 밀어넣었다**(발바닥 -0.25m). 웅크림은 무릎으로 한다.
  const dip = track(k, [
    [0, 0],
    [0.12, 1],
    [0.32, 0],
    [1, 0],
  ]);
  // 접지 보정을 켜 둔다. 그래야 무릎을 접는 만큼 골반이 내려앉고 발은 지면에 남으며,
  // 착지에서도 발이 정확히 지면에 닿는다. 공중 높이는 root가 얹는다(세리머니와 같은 방식).
  p.root = [0, air, 0];
  p.hipDrop = lerp(-0.24, -0.06, up);
  p.torso = [0.24 - 0.2 * up + dip * 0.22, 0, -0.08 * up];
  p.head = [-0.3 - 0.25 * up, 0, 0];
  // 공중에서 다리를 접는다
  p.legL = {
    hip: [-0.1 - 0.5 * up - dip * 0.45, -0.06, -0.16],
    knee: 0.5 + 0.9 * up + dip * 0.8,
    ankle: 0.35 * up,
  };
  p.legR = {
    hip: [-0.1 - 0.3 * up - dip * 0.45, 0.06, 0.2],
    knee: 0.5 + 0.6 * up + dip * 0.8,
    ankle: 0.3 * up,
  };
  // 글러브를 머리 위로. 머리(반지름 0.145 x 1.55배)를 피해 바깥으로 벌린다.
  p.glove = { pos: [0.3, lerp(0.1, 0.62, up), lerp(0.34, 0.14, up)], rot: [-0.3 * up, -0.3, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.32, lerp(-0.16, 0.3, up), 0.2], pole: [-1, -0.2, -0.5] };
  p.ground = true;
  return p;
}

/**
 * 낙담 (삼진 · 실책 · 피홈런). 어깨가 처지고 고개를 떨군다.
 * 결과가 나온 뒤 잠깐 서 있는 시간이 죽어 있으면 경기가 통째로 무표정해진다.
 */
function reactDownPose(clock: number): Pose {
  const p = basePose();
  const b = Math.sin(clock * 1.4) * 0.5 + 0.5;
  p.hipDrop = -0.09 - b * 0.02;
  p.hipRot = [0, 0.04, 0];
  p.torso = [0.22 + b * 0.03, -0.05, 0];
  p.head = [0.42 + b * 0.05, 0.1, 0];
  p.legL = { hip: [0.02, -0.02, -0.1], knee: 0.24, ankle: 0 };
  p.legR = { hip: [0.02, 0.02, 0.1], knee: 0.2, ankle: 0 };
  p.armL = { euler: [0.24 - b * 0.04, 0, 0.1], elbow: -0.2 };
  p.armR = { euler: [0.24 - b * 0.04, 0, -0.1], elbow: -0.18 };
  p.ground = true;
  return p;
}

/** 짧은 환호 (아웃을 잡은 야수 · 안타를 친 타자). CELEBRATE보다 작다. */
function reactUpPose(clock: number): Pose {
  const p = basePose();
  const s = Math.sin(clock * 5.2);
  const pump = Math.max(0, s);
  p.root[1] = pump * 0.03;
  p.hipDrop = -0.03;
  p.torso = [-0.1, -0.08 * s, 0];
  p.head = [-0.2, 0.06 * s, 0];
  p.legL = { hip: [0.03, 0, -0.1], knee: 0.2, ankle: 0 };
  p.legR = { hip: [0.03, 0, 0.1], knee: 0.2, ankle: 0 };
  // 오른팔만 짧게 끌어내리는 주먹질
  p.armR = { target: [0.36, lerp(0.16, 0.34, pump), lerp(0.3, 0.16, pump)], pole: [1, -0.3, -0.4] };
  p.armL = { euler: [0.1, 0, -0.16], elbow: -0.5 };
  p.ground = true;
  return p;
}

/**
 * 주심. 포수 뒤에서 무릎에 손을 얹고 낮춘 자세.
 *
 * 포수 뒤가 텅 비어 있는 게 "경기가 아니라 연습 화면" 같은 인상의 큰 몫이었다.
 * 포수 크라우칭과 달리 글러브가 없고, 코스를 보려고 한쪽으로 몸을 튼다.
 */
function umpirePose(clock: number): Pose {
  const p = basePose();
  const b = Math.sin(clock * 1.6) * 0.5 + 0.5;
  p.hipDrop = -0.38 - b * 0.03;
  p.hipRot = [0, 0.16, 0];
  p.torso = [0.62 - b * 0.03, -0.14, 0];
  p.head = [-0.42, 0.06, 0];
  p.legL = { hip: [-0.78, -0.14, -0.34], knee: 1.42, ankle: -0.62 };
  p.legR = { hip: [-0.6, 0.16, 0.4], knee: 1.2, ankle: -0.55 };
  // 두 손을 무릎 위에 얹는다
  p.armL = { target: [-0.3, -0.34, 0.3], pole: [-1, -0.3, -0.2] };
  p.armR = { target: [0.28, -0.36, 0.34], pole: [1, -0.3, -0.2] };
  p.ground = true;
  return p;
}

/**
 * 스트라이크·아웃 콜. t=0 크라우칭 -> 0.35 일어서며 오른팔을 꺾어 올림 -> 1 유지.
 * 야구에서 가장 자주 보는 동작인데 화면에 한 번도 나온 적이 없었다.
 */
function callStrikePose(t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const up = track(k, [
    [0, 0],
    [0.3, 1],
    [0.62, 0.92],
    [1, 0.88],
  ]);
  p.hipDrop = lerp(-0.34, -0.06, up);
  p.hipRot = [0, 0.16 - 0.24 * up, 0];
  p.torso = [lerp(0.56, 0.06, up), lerp(-0.12, -0.42, up), -0.14 * up];
  p.head = [lerp(-0.4, -0.14, up), 0.24 * up, 0];
  p.legL = { hip: [lerp(-0.7, 0.04, up), -0.12, -0.28], knee: lerp(1.3, 0.2, up), ankle: lerp(-0.6, 0, up) };
  p.legR = { hip: [lerp(-0.55, 0.04, up), 0.14, 0.3], knee: lerp(1.1, 0.18, up), ankle: lerp(-0.5, 0, up) };
  // 오른팔을 옆으로 들고 팔꿈치를 꺾어 주먹을 세운다
  p.armR = {
    target: [lerp(0.3, 0.5, up), lerp(-0.3, 0.34, up), lerp(0.3, 0.02, up)],
    pole: [1, -0.6, -0.2],
  };
  p.armL = { euler: [0.12, 0, 0.16 + 0.1 * up], elbow: -0.4 };
  p.ground = true;
  return p;
}

/** 세이프 콜. 두 팔을 수평으로 쓸어 벌린다. */
function callSafePose(t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const open = track(k, [
    [0, 0],
    [0.26, 1],
    [0.6, 0.86],
    [1, 0.82],
  ]);
  p.hipDrop = -0.1 - 0.06 * (1 - open);
  p.torso = [0.16 - 0.1 * open, 0, 0];
  p.head = [-0.16, 0, 0];
  p.legL = { hip: [0.02, 0, -0.14], knee: 0.3, ankle: 0 };
  p.legR = { hip: [0.02, 0, 0.14], knee: 0.28, ankle: 0 };
  const reach = (sign: number): V3 => [sign * lerp(0.24, 0.52, open), lerp(-0.2, 0.16, open), lerp(0.24, 0.06, open)];
  p.armL = { target: reach(-1), pole: [-1, -0.2, -0.5] };
  p.armR = { target: reach(1), pole: [1, -0.2, -0.5] };
  p.ground = true;
  return p;
}

/** 헤드퍼스트가 아닌 발부터 슬라이딩 */
function slidingPose(t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  p.root = [0, 0, 0];
  // 엉덩이를 지면 가까이 내리고 다리를 앞(+Z)으로 뻗는다.
  // 고관절 X 회전이 양수면 다리가 뒤로 가므로 슬라이딩은 음수여야 한다.
  p.hipDrop = -0.6;
  p.hipRot = [0, 0.2, 0];
  p.torso = [-0.42 - k * 0.2, 0.1, 0];
  p.head = [0.52, -0.2, 0];
  // 앞으로 뻗은 다리. -1.5로는 허벅지가 아직 아래를 향해 뒤꿈치가 6cm 잠겼다.
  // 지면과 나란해지도록 조금 더 들고, 발끝도 세워 올린다.
  p.legL = { hip: [-1.66, 0, -0.1], knee: 0.1, ankle: -0.5 };
  // 몸 밑으로 접어 넣은 다리. 지면을 뚫고 있던 건 이쪽이다 — 무릎을 접어도 고관절이
  // -1.5면 정강이가 아래로 뻗어 발이 6cm 잠긴다. 허벅지를 더 들어 정강이가 엉덩이
  // 옆으로 눕게 한다. (2.7=155°는 사람 무릎 한계를 넘어 정강이가 허벅지를 파고들었다)
  p.legR = { hip: [-1.9, 0.1, 0.26], knee: 2.55, ankle: -0.5 };
  // 팔은 균형을 잡느라 위로 벌어진다
  p.armL = { euler: [-1.9 - k * 0.25, 0.2, 0.5], elbow: -0.5 };
  p.armR = { euler: [-2.1 - k * 0.2, -0.2, -0.4], elbow: -0.4 };
  p.ground = false;
  return p;
}

/**
 * 홈런/득점 세리머니: 두 팔을 번갈아 치켜올린다.
 * 팔은 오일러가 아니라 IK 목표로 준다 — SD 비율은 머리가 커서 어깨 각도로
 * 올리면 손이 머리 속으로 파고든다.
 */
function celebratePose(clock: number): Pose {
  const p = basePose();
  const s = Math.sin(clock * 4.4);
  const c = Math.cos(clock * 4.4);
  p.root[1] = Math.max(0, s) * 0.07;
  p.hipDrop = 0;
  p.hipRot = [0, s * 0.1, 0];
  p.torso = [-0.12, -s * 0.16, 0];
  p.head = [-0.26, s * 0.24, 0];
  p.legL = {
    hip: [0.1 - Math.max(0, s) * 0.3, 0, -0.12],
    knee: 0.2 + Math.max(0, s) * 0.5,
    ankle: 0,
  };
  p.legR = {
    hip: [0.1 - Math.max(0, -s) * 0.3, 0, 0.12],
    knee: 0.2 + Math.max(0, -s) * 0.5,
    ankle: 0,
  };
  // 머리 중심(0, 0.5)에서 0.3 이상 떨어뜨려 팔을 벌린 채 올린다
  const fist = (sign: number, up: number): V3 => [
    sign * 0.44,
    lerp(0.3, 0.66, up),
    lerp(0.22, 0.06, up),
  ];
  p.armL = { target: fist(-1, Math.max(0, c)), pole: [-1, -0.3, -0.4] };
  p.armR = { target: fist(1, Math.max(0, -c)), pole: [1, -0.3, -0.4] };
  p.ground = true;
  return p;
}

/** 대기: 숨쉬기 + 좌우 체중이동 */
function idlePose(clock: number): Pose {
  const p = basePose();
  const b = Math.sin(clock * 1.9) * 0.5 + 0.5;
  const s = Math.sin(clock * 0.72);
  const peek = Math.sin(clock * 0.41);
  p.hipDrop = -0.03 - b * 0.022;
  p.hipRot = [0, s * 0.05, s * 0.05];
  p.torso = [0.05 + b * 0.02, -s * 0.09, -s * 0.03];
  p.head = [-0.02 + b * 0.02, peek * 0.24, 0];
  p.legL = { hip: [0.03, 0, -0.08 - Math.max(0, s) * 0.03], knee: 0.16 + b * 0.05 + Math.max(0, s) * 0.12, ankle: 0 };
  p.legR = { hip: [0.03, 0, 0.08 + Math.max(0, -s) * 0.03], knee: 0.16 + b * 0.05 + Math.max(0, -s) * 0.12, ankle: 0 };
  p.armL = { euler: [0.1 - b * 0.05, 0, 0.14 + s * 0.03], elbow: -0.35 - b * 0.06 };
  p.armR = { euler: [0.1 - b * 0.05, 0, -0.14 + s * 0.03], elbow: -0.35 - b * 0.06 };
  p.ground = true;
  return p;
}

/**
 * 게임이 진행도를 물려주지 않는 포즈들. 모델이 자기 시계로 계속 움직인다.
 * (이 포즈의 선수는 부모가 리렌더하지 않으므로 animT가 0에 멈춰 있다)
 */
export const SELF_DRIVEN: Partial<Record<PoseKind, true>> = {
  IDLE: true,
  FIELDING: true,
  CATCHING: true,
  CELEBRATE: true,
  PITCHING_SET: true,
  TAG: true,
  REACT_DOWN: true,
  REACT_UP: true,
  UMPIRE: true,
};

export function buildPose(
  kind: PoseKind,
  t: number,
  player: Player,
  intensity: number,
  clock: number,
  batSide: Handedness,
): Pose {
  const lefty = batSide === 'L';
  switch (kind) {
    case 'BATTING':
      return lefty
        ? mirrorPose(battingPose(player, t, clock))
        : battingPose(player, t, clock);
    case 'BATTING_SWING':
      return lefty ? mirrorPose(swingPose(player, t)) : swingPose(player, t);
    case 'BATTING_BUNT':
      return lefty ? mirrorPose(buntPose(player, t)) : buntPose(player, t);
    case 'PITCHING_SET':
      return player.throws === 'L'
        ? mirrorPose(pitchingSetPose(player, clock))
        : pitchingSetPose(player, clock);
    case 'PITCHING_RELEASE':
      return player.throws === 'L'
        ? mirrorPose(pitchingPose(player, t))
        : pitchingPose(player, t);
    case 'FIELDING':
      return player.throws === 'L' ? mirrorPose(fieldingPose(clock)) : fieldingPose(clock);
    case 'CATCHING':
      return player.throws === 'L' ? mirrorPose(catchingPose(clock)) : catchingPose(clock);
    case 'RUNNING':
      return runningPose(t, intensity);
    case 'SLIDING':
      return slidingPose(t);
    case 'SLIDING_HEAD':
      return headSlidePose(t);
    case 'CELEBRATE':
      return celebratePose(clock);
    // 송구·수비 동작은 던지는 팔 기준이라 좌투는 통째로 뒤집는다 (투구와 같은 규약)
    case 'THROWING':
      return player.throws === 'L' ? mirrorPose(throwingPose(t)) : throwingPose(t);
    case 'DIVING':
      return player.throws === 'L' ? mirrorPose(divingPose(t)) : divingPose(t);
    case 'TAG':
      return player.throws === 'L' ? mirrorPose(tagPose(clock)) : tagPose(clock);
    case 'JUMP':
      return player.throws === 'L' ? mirrorPose(jumpPose(t)) : jumpPose(t);
    case 'REACT_DOWN':
      return reactDownPose(clock);
    case 'UMPIRE':
      return umpirePose(clock);
    case 'CALL_STRIKE':
      return callStrikePose(t);
    case 'CALL_SAFE':
      return callSafePose(t);
    case 'REACT_UP':
      return player.throws === 'L' ? mirrorPose(reactUpPose(clock)) : reactUpPose(clock);
    default:
      return idlePose(clock);
  }
}

// ---------------------------------------------------------------------------
// 포즈 -> 스냅샷 (접지 보정 + 팔 IK). 스냅샷끼리 섞을 수 있어야
// 포즈가 바뀔 때 뚝 끊기지 않고 넘어간다.
// ---------------------------------------------------------------------------

export interface LimbSnap {
  quat: THREE.Quaternion;
  knee: number;
  ankle: number;
}

export interface Snapshot {
  root: THREE.Vector3;
  hipY: number;
  hip: THREE.Quaternion;
  torso: THREE.Quaternion;
  head: THREE.Quaternion;
  legL: LimbSnap;
  legR: LimbSnap;
  armL: ArmSolution;
  armR: ArmSolution;
  batPos: THREE.Vector3;
  batQuat: THREE.Quaternion;
  glovePos: THREE.Vector3;
  gloveQuat: THREE.Quaternion;
}

export function newSnapshot(): Snapshot {
  const limb = (): LimbSnap => ({ quat: new THREE.Quaternion(), knee: 0, ankle: 0 });
  const arm = (): ArmSolution => ({
    quat: new THREE.Quaternion(),
    elbow: 0,
    wrist: new THREE.Quaternion(),
  });
  return {
    root: new THREE.Vector3(),
    hipY: HIP_H,
    hip: new THREE.Quaternion(),
    torso: new THREE.Quaternion(),
    head: new THREE.Quaternion(),
    legL: limb(),
    legR: limb(),
    armL: arm(),
    armR: arm(),
    batPos: new THREE.Vector3(),
    batQuat: new THREE.Quaternion(),
    glovePos: new THREE.Vector3(),
    gloveQuat: new THREE.Quaternion(),
  };
}

export function copySnapshot(src: Snapshot, dst: Snapshot) {
  dst.root.copy(src.root);
  dst.hipY = src.hipY;
  dst.hip.copy(src.hip);
  dst.torso.copy(src.torso);
  dst.head.copy(src.head);
  for (const k of ['legL', 'legR'] as const) {
    dst[k].quat.copy(src[k].quat);
    dst[k].knee = src[k].knee;
    dst[k].ankle = src[k].ankle;
  }
  for (const k of ['armL', 'armR'] as const) {
    dst[k].quat.copy(src[k].quat);
    dst[k].elbow = src[k].elbow;
    dst[k].wrist.copy(src[k].wrist);
  }
  dst.batPos.copy(src.batPos);
  dst.batQuat.copy(src.batQuat);
  dst.glovePos.copy(src.glovePos);
  dst.gloveQuat.copy(src.gloveQuat);
}

/** a -> b 로 u만큼 섞어 dst에 쓴다 (a와 dst가 같아도 안전) */
export function mixSnapshot(a: Snapshot, b: Snapshot, u: number, dst: Snapshot) {
  dst.root.copy(a.root).lerp(b.root, u);
  dst.hipY = lerp(a.hipY, b.hipY, u);
  dst.hip.copy(a.hip).slerp(b.hip, u);
  dst.torso.copy(a.torso).slerp(b.torso, u);
  dst.head.copy(a.head).slerp(b.head, u);
  for (const k of ['legL', 'legR'] as const) {
    dst[k].quat.copy(a[k].quat).slerp(b[k].quat, u);
    dst[k].knee = lerp(a[k].knee, b[k].knee, u);
    dst[k].ankle = lerp(a[k].ankle, b[k].ankle, u);
  }
  for (const k of ['armL', 'armR'] as const) {
    dst[k].quat.copy(a[k].quat).slerp(b[k].quat, u);
    dst[k].elbow = lerp(a[k].elbow, b[k].elbow, u);
    dst[k].wrist.copy(a[k].wrist).slerp(b[k].wrist, u);
  }
  dst.batPos.copy(a.batPos).lerp(b.batPos, u);
  dst.batQuat.copy(a.batQuat).slerp(b.batQuat, u);
  dst.glovePos.copy(a.glovePos).lerp(b.glovePos, u);
  dst.gloveQuat.copy(a.gloveQuat).slerp(b.gloveQuat, u);
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _fv = new THREE.Vector3();
const _fv2 = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _armTmp: ArmPose = {};
const _armTmp2: ArmPose = {};

/** 모듈 스크래치를 재사용하므로 이전 프레임 값이 남지 않게 매번 초기화한다 */
function loadArm(dst: ArmPose, src: ArmPose): ArmPose {
  dst.target = src.target;
  dst.pole = src.pole;
  dst.euler = src.euler;
  dst.elbow = src.elbow;
  return dst;
}

export function setEuler(q: THREE.Quaternion, r: V3, order: THREE.EulerOrder = 'YXZ'): THREE.Quaternion {
  return q.setFromEuler(_e.set(r[0], r[1], r[2], order));
}

/**
 * 발목 관절에서 신발 밑판 아래 모서리까지 (발목 그룹 기준 오프셋).
 *
 * 예전에는 FK 다리가 `FOOT_DROP`(0.045)이라는 어림치로 접지했는데, 발목을 꺾는
 * 포즈에서는 밑판이 실제로 2~3cm 더 내려가 **모든 FK 포즈의 신발이 지면에 파묻혀
 * 있었다.** IK 다리만 실제 지오메트리를 쓰고 있어서 두 방식이 서로 어긋나기도 했다.
 * 지금은 양쪽 다 이 값을 쓴다.
 * @see Leg 컴포넌트의 ankle 그룹과 shoeSole 배치
 */
const ANKLE_OFFSET = new THREE.Vector3(0, -0.01, 0.03);
const SOLE_OFFSET = new THREE.Vector3(0, -0.042, 0.035);

/** 다리 FK로 발바닥 높이를 구한다 (골반 로컬) */
export function footHeight(snap: LimbSnap, sign: number, hipQuat: THREE.Quaternion): number {
  const kq = _q2.setFromEuler(_e.set(snap.knee, 0, 0, 'XYZ'));
  const aq = _q3.setFromEuler(_e.set(snap.ankle, 0, 0, 'XYZ'));
  // 발목 그룹 안 -> 무릎 기준 -> 고관절 기준 -> 골반 기준 순으로 올라간다.
  const p = _fv.copy(SOLE_OFFSET).applyQuaternion(aq).add(ANKLE_OFFSET);
  p.add(_fv2.set(0, -SHIN, 0));
  p.applyQuaternion(kq);
  p.add(_fv2.set(0, -THIGH, 0));
  p.applyQuaternion(snap.quat);
  p.x += sign * HIP_X;
  return p.applyQuaternion(hipQuat).y;
}

const _invHip = new THREE.Quaternion();
const _legSol: ArmSolution = {
  quat: new THREE.Quaternion(),
  elbow: 0,
  wrist: new THREE.Quaternion(),
};
const _sole = new THREE.Vector3();
const DEFAULT_KNEE_POLE: V3 = [0, 0.15, 1];

const _kneeQ = new THREE.Quaternion();
const _ankleQ = new THREE.Quaternion();

/**
 * 다리를 풀고 (IK 또는 FK) 발바닥 높이를 함께 돌려준다.
 * 반환값은 **골반 원점 기준, 루트 축**의 발바닥 y다.
 */
export function solveLeg(leg: LegPose, sign: number, hip: THREE.Quaternion, dst: LimbSnap): number {
  if (!leg.ikTarget) {
    setEuler(dst.quat, leg.hip, 'XYZ');
    dst.knee = clamp(leg.knee, 0, KNEE_MAX_FLEX);
    dst.ankle = leg.ankle;
    return footHeight(dst, sign, hip);
  }

  // 목표는 루트 축 기준이므로 골반 회전을 벗겨 골반 로컬로 옮긴다
  _target.set(leg.ikTarget[0], leg.ikTarget[1], leg.ikTarget[2]).applyQuaternion(_invHip);
  _shoulder.set(sign * HIP_X, 0, 0);
  const pl = leg.ikPole ?? DEFAULT_KNEE_POLE;
  _pole.set(pl[0], pl[1], pl[2]).normalize();
  solveTwoBone(_shoulder, _target, _pole, THIGH, SHIN, 1, KNEE_MAX_FLEX, _legSol);
  dst.quat.copy(_legSol.quat);
  dst.knee = _legSol.elbow;

  // 발바닥을 지면과 나란히: 정강이가 기운 만큼 발목으로 되돌린다.
  // 이게 없으면 접지한 발이 다리를 따라 까딱거려 발끝으로 미끄러지는 것처럼 보인다.
  _fv.set(0, -THIGH, 0).applyQuaternion(_legSol.quat).add(_shoulder);
  _fv2.copy(_target).sub(_fv);
  dst.ankle = leg.ankle + Math.atan2(_fv2.z, Math.max(1e-4, -_fv2.y));

  // 발바닥의 실제 높이. 체인 전체 회전을 태워 신발 밑판까지 내려간다.
  _kneeQ.setFromEuler(_e.set(dst.knee, 0, 0, 'XYZ'));
  _ankleQ.setFromEuler(_e.set(dst.ankle, 0, 0, 'XYZ'));
  _sole.copy(SOLE_OFFSET).applyQuaternion(_ankleQ).add(ANKLE_OFFSET);
  _sole.applyQuaternion(_kneeQ).applyQuaternion(_legSol.quat).add(_target);
  return _sole.applyQuaternion(hip).y;
}

// --- 손목 -------------------------------------------------------------------

const _fq = new THREE.Quaternion();
const _des = new THREE.Quaternion();
const _elbowQ = new THREE.Quaternion();
const _twist = new THREE.Quaternion();
const _swing = new THREE.Quaternion();
const _hx = new THREE.Vector3();
const _hold = new THREE.Vector3();

/** 회전각만 max로 자른다 (축은 그대로) */
function limitAngle(q: THREE.Quaternion, max: number) {
  // w가 음수면 같은 회전을 반대 축으로 표현한 것이라 각도가 뒤집혀 나온다
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const w = clamp(q.w, -1, 1);
  if (2 * Math.acos(w) <= max) return;
  const s = Math.sqrt(Math.max(1e-12, 1 - w * w));
  const k = Math.sin(max / 2) / s;
  q.set(q.x * k, q.y * k, q.z * k, Math.cos(max / 2));
}

/**
 * 손목을 사람 가동범위로 자른다.
 *
 * 아래팔 축(-Y) 둘레의 비틀림(회내/회외)과 그 외 꺾임은 한계가 크게 다르므로
 * swing-twist로 분해해 따로 자른다. 한 각도로 뭉뚱그리면 비틀기만 해도 꺾임 한계에
 * 걸리거나, 반대로 손목이 접히다 못해 부러진 것처럼 보인다.
 */
function clampWrist(q: THREE.Quaternion) {
  // 회전축을 아래팔 축(0,-1,0)에 투영한 성분이 비틀림이다
  _twist.set(0, q.y, 0, q.w);
  if (_twist.lengthSq() < 1e-12) _twist.identity();
  else _twist.normalize();
  _swing.copy(q).multiply(_qa.copy(_twist).invert());
  limitAngle(_twist, WRIST_MAX_TWIST);
  limitAngle(_swing, WRIST_MAX_SWING);
  q.copy(_swing).multiply(_twist);
}

/**
 * 손에 든 장비를 실제로 쥐도록 손목을 돌린다.
 *
 * 손 그룹에는 회전 채널이 아예 없었다. 그래서 손 방향은 IK 비틀림의 부산물이었고,
 * 배트·글러브는 (양손이 같은 지점을 잡게 하려고) 손이 아니라 몸통에 붙어 있어서
 * 손이 그립을 향한다는 보장이 없었다. 엄지가 배트와 무관한 쪽을 가리키던 이유다.
 *
 * `barrel`이면 손 로컬 X를 배트 축에 맞춘다 — 샤프트가 손바닥을 가로지르고 엄지가
 * 그 위에 얹힌다. 글러브는 포켓 방향을 그대로 따라간다.
 */
function solveWrist(arm: ArmSolution, hold: THREE.Quaternion | null, barrel: boolean) {
  if (!hold) {
    arm.wrist.identity();
    return;
  }
  _elbowQ.setFromEuler(_e.set(arm.elbow, 0, 0, 'XYZ'));
  _fq.copy(arm.quat).multiply(_elbowQ); // 아래팔의 몸통 로컬 방향
  if (barrel) {
    _hold.set(0, 1, 0).applyQuaternion(hold); // 배럴 방향
    _hx.set(1, 0, 0).applyQuaternion(_fq); // 지금 손 로컬 X가 향한 곳
    if (_hx.dot(_hold) < 0) _hold.negate(); // 180도 뒤집어 잡지 않게
    _des.setFromUnitVectors(_hx, _hold).multiply(_fq);
  } else {
    _des.copy(hold);
  }
  arm.wrist.copy(_fq).invert().multiply(_des);
  clampWrist(arm.wrist);
}

/**
 * 배트를 잡은 팔의 기본 팔꿈치 방향.
 *
 * 위손(백암)은 팔꿈치를 아래·바깥·뒤로 세우고, 아래손(리드암)은 가슴 **앞**으로 감아
 * 내린다. sign은 그 팔이 달린 어깨의 부호라, 좌우 어느 쪽이든 몸 바깥으로 나간다.
 */
function sideRole(sign: number, isTop: boolean): V3 {
  return isTop ? [sign * 0.72, -0.55, -0.42] : [sign * 0.85, -0.8, 0.3];
}

export function writeSnapshot(pose: Pose, out: Snapshot) {
  setEuler(out.hip, pose.hipRot, 'XYZ');
  _invHip.copy(out.hip).invert();

  // 다리를 먼저 풀어야 발바닥 높이를 알 수 있고, 그래야 접지 보정을 걸 수 있다
  const fl = solveLeg(pose.legL, -1, out.hip, out.legL);
  const fr = solveLeg(pose.legR, 1, out.hip, out.legR);

  // 낮은 쪽 발이 지면에 닿도록 루트를 올린다
  let rootY = pose.root[1];
  if (pose.ground) rootY += -(HIP_H + pose.hipDrop + Math.min(fl, fr));
  out.root.set(pose.root[0], rootY, pose.root[2]);
  out.hipY = HIP_H + pose.hipDrop;

  setEuler(out.torso, pose.torso);
  setEuler(out.head, pose.head);

  // 장비 부착점 -> 손 목표
  const armL = loadArm(_armTmp, pose.armL);
  const armR = loadArm(_armTmp2, pose.armR);

  if (pose.bat) {
    setEuler(out.batQuat, pose.bat.rot);
    out.batPos.set(...pose.bat.pos);
    // 배트 로컬 +Y가 배럴 방향. 그립은 원점 근처 두 지점.
    const [gLow, gTop] = pose.bat.grip ?? [-0.02, 0.11];
    const lowGrip = _fv.set(0, gLow, 0).applyQuaternion(out.batQuat).add(out.batPos);
    const lowArm: V3 = [lowGrip.x, lowGrip.y, lowGrip.z];
    const topGrip = _fv2.set(0, gTop, 0).applyQuaternion(out.batQuat).add(out.batPos);
    const topArm: V3 = [topGrip.x, topGrip.y, topGrip.z];
    const top = pose.topHand ?? 'R';
    if (top === 'R') {
      armR.target = topArm;
      armL.target = lowArm;
    } else {
      armL.target = topArm;
      armR.target = lowArm;
    }
    // 위손과 아래손은 팔꿈치가 놓이는 평면이 다르다. 예전엔 양팔에 같은 [0,-0.7,-1]을
    // 줬는데, X 성분이 없어 팔꿈치가 바깥으로 벌어지지 않고 Z가 음수라 둘 다 가슴
    // **뒤쪽**을 향했다 — 그래서 팔이 등 쪽으로 꺾인 것처럼 보였다. 어깨 부호를 곱해
    // 각자 자기 바깥쪽으로 내보낸다.
    armL.pole = armL.pole ?? sideRole(-1, top === 'L');
    armR.pole = armR.pole ?? sideRole(1, top === 'R');
  }

  if (pose.glove && pose.gloveHand) {
    setEuler(out.gloveQuat, pose.glove.rot);
    out.glovePos.set(...pose.glove.pos);
    if (pose.gloveHand === 'R') armR.target = pose.glove.pos;
    else armL.target = pose.glove.pos;
  }

  const solve = (arm: ArmPose, sign: number, dst: ArmSolution) => {
    if (arm.target) {
      _shoulder.set(sign * SHOULDER_X, SHOULDER_Y, 0);
      _target.set(arm.target[0], arm.target[1], arm.target[2]);
      const pl = arm.pole ?? [sign, -0.8, -0.6];
      _pole.set(pl[0], pl[1], pl[2]).normalize();
      solveArm(_shoulder, _target, _pole, dst);
    } else {
      setEuler(dst.quat, arm.euler ?? [0, 0, 0], 'XYZ');
      // FK로 직접 준 값에도 같은 한계를 건다. 안전망이라 평소엔 물리지 않아야 한다 —
      // 물린다면 그 포즈의 원본 각도가 사람 범위를 넘었다는 뜻이다.
      dst.elbow = clamp(arm.elbow ?? -0.2, -ELBOW_MAX_FLEX, 0);
    }
  };
  solve(armL, -1, out.armL);
  solve(armR, 1, out.armR);

  // 손목은 팔이 다 풀린 뒤에야 정할 수 있다 (아래팔 방향을 알아야 역산이 된다)
  const gloveOn = pose.glove ? pose.gloveHand : undefined;
  const hold = (side: 'L' | 'R'): [THREE.Quaternion | null, boolean] =>
    gloveOn === side
      ? [out.gloveQuat, false]
      : pose.bat
        ? [out.batQuat, true]
        : [null, false];
  solveWrist(out.armL, ...hold('L'));
  solveWrist(out.armR, ...hold('R'));
}

// ---------------------------------------------------------------------------
// 포즈 전환
// ---------------------------------------------------------------------------

/** 포즈가 바뀔 때 섞는 기본 시간(초). 짧게 잡아야 스윙/송구가 흐물거리지 않는다. */
export const BLEND_SEC = 0.16;

/**
 * 포즈 쌍별 전환 시간.
 *
 * 하나의 값으로 다 덮으면 어느 쪽이든 어색해진다. **터지는 동작**(스윙 시작, 다이빙,
 * 슬라이딩 돌입)은 섞는 순간이 곧 힘이 빠지는 순간이라 최대한 짧아야 하고,
 * **멈추는 동작**(무엇이든 -> IDLE)은 길게 끌어야 급정거처럼 보이지 않는다.
 */
const BLEND_OVERRIDE: Record<string, number> = {
  'BATTING>BATTING_SWING': 0.05,
  'BATTING>BATTING_BUNT': 0.07,
  'PITCHING_SET>PITCHING_RELEASE': 0.06,
  'RUNNING>SLIDING': 0.07,
  'RUNNING>SLIDING_HEAD': 0.07,
  'RUNNING>DIVING': 0.06,
  'FIELDING>DIVING': 0.06,
  'FIELDING>JUMP': 0.06,
  'RUNNING>JUMP': 0.06,
  'CATCHING>THROWING': 0.1,
  'FIELDING>THROWING': 0.1,
  'RUNNING>THROWING': 0.12,
};

export function blendTime(from: PoseKind, to: PoseKind): number {
  const k = BLEND_OVERRIDE[`${from}>${to}`];
  if (k !== undefined) return k;
  return to === 'IDLE' || to === 'REACT_DOWN' ? 0.28 : BLEND_SEC;
}

// ---------------------------------------------------------------------------
// 스냅샷 -> 관절 위치 (검사·디버그용 FK)
// ---------------------------------------------------------------------------

/**
 * 스냅샷이 실제로 어디에 관절을 놓는지 되짚어 계산한다.
 *
 * 오프셋은 PlayerModel의 JSX가 쓰는 것과 **같은 rig.ts 상수**를 읽으므로, 계층이
 * 바뀌면 양쪽이 같이 바뀐다. 눈으로 스크린샷을 보는 대신 "팔꿈치가 몸통 안에 있나",
 * "발바닥이 지면에 닿나"를 수치로 판정할 수 있게 하는 게 목적이다.
 */
export interface JointPoints {
  /**
   * 몸통 로컬. **팔이 몸통·머리를 뚫는지는 반드시 이 좌표계에서** 본다 —
   * 몸통 캡슐의 축이 곧 이 좌표계의 Y축이라 반경을 바로 잴 수 있다.
   */
  shoulderL: THREE.Vector3;
  elbowL: THREE.Vector3;
  handL: THREE.Vector3;
  shoulderR: THREE.Vector3;
  elbowR: THREE.Vector3;
  handR: THREE.Vector3;
  /** 모델 로컬 (접지 포즈면 낮은 쪽 soleY가 0). 높이·접지 판정용 */
  soleLY: number;
  soleRY: number;
  hipY: number;
}

const _jp = {
  q: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  e: new THREE.Euler(),
  v: new THREE.Vector3(),
};

/** 어깨 -> 팔꿈치 -> 손 (몸통 로컬) */
function armPoints(snap: ArmSolution, sign: number) {
  const shoulder = new THREE.Vector3(sign * SHOULDER_X, SHOULDER_Y, 0);
  const elbow = new THREE.Vector3(0, -UPPER_ARM, 0).applyQuaternion(snap.quat).add(shoulder);
  const fore = _jp.q
    .copy(snap.quat)
    .multiply(_jp.q2.setFromEuler(_jp.e.set(snap.elbow, 0, 0, 'XYZ')));
  const hand = new THREE.Vector3(0, -FOREARM, 0).applyQuaternion(fore).add(elbow);
  return { shoulder, elbow, hand };
}

/** 신발 밑판 y (골반 원점 기준, 루트 축). solveLeg의 IK 분기와 같은 식이다. */
function soleY(snap: LimbSnap, sign: number, hip: THREE.Quaternion): number {
  const kneeQ = _jp.q.setFromEuler(_jp.e.set(snap.knee, 0, 0, 'XYZ'));
  const ankleQ = _jp.q2.setFromEuler(_jp.e.set(snap.ankle, 0, 0, 'XYZ'));
  const p = _jp.v.copy(SOLE_OFFSET).applyQuaternion(ankleQ).add(ANKLE_OFFSET);
  p.add(new THREE.Vector3(0, -SHIN, 0));
  p.applyQuaternion(kneeQ);
  p.add(new THREE.Vector3(0, -THIGH, 0));
  p.applyQuaternion(snap.quat);
  p.x += sign * HIP_X;
  return p.applyQuaternion(hip).y;
}

/**
 * 몸통 로컬 좌표를 모델 로컬(발바닥 y=0, 아직 BODY로 줄이기 전)로 옮긴다.
 *
 * 손이 월드 어디에 놓이는지 재려면 이게 필요하다 — 투수 릴리스 포인트
 * (`pitching.releasePoint`)가 바로 그 값이라, 포즈를 고치면 같이 다시 재야 한다.
 */
export function torsoToModel(s: Snapshot, p: THREE.Vector3): THREE.Vector3 {
  return p
    .applyQuaternion(s.torso)
    .add(_jp.v.set(0, TORSO_Y, 0))
    .applyQuaternion(s.hip)
    .add(_jp.v.set(0, s.hipY, 0))
    .add(s.root);
}

export function jointPositions(s: Snapshot): JointPoints {
  const l = armPoints(s.armL, -1);
  const r = armPoints(s.armR, 1);
  return {
    shoulderL: l.shoulder,
    elbowL: l.elbow,
    handL: l.hand,
    shoulderR: r.shoulder,
    elbowR: r.elbow,
    handR: r.hand,
    soleLY: s.root.y + s.hipY + soleY(s.legL, -1, s.hip),
    soleRY: s.root.y + s.hipY + soleY(s.legR, 1, s.hip),
    hipY: s.root.y + s.hipY,
  };
}
