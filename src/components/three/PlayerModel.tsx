'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import { clamp } from '@/lib/game/rng';
import type { AccessoryType, BatType, GloveType, Player, UniformType } from '@/lib/game/types';

export interface UniformSpec {
  primary: string;
  secondary: string;
  accent: string;
  type: UniformType;
}

export type PoseKind =
  | 'IDLE'
  | 'BATTING'
  | 'BATTING_SWING'
  | 'PITCHING_SET'
  | 'PITCHING_RELEASE'
  | 'FIELDING'
  | 'RUNNING'
  | 'CATCHING'
  | 'SLIDING'
  | 'CELEBRATE';

// ---------------------------------------------------------------------------
// 골격 치수 (m). 모델 로컬 좌표: +Y 위, +Z 정면, 발바닥이 y=0.
// ---------------------------------------------------------------------------

const HIP_H = 0.86; // 골반 높이
const HIP_X = 0.13; // 골반에서 고관절까지
const THIGH = 0.42;
const SHIN = 0.4;
const FOOT_DROP = 0.045; // 발목 -> 발바닥
const TORSO_Y = 0.16; // 골반 -> 몸통 원점
const SHOULDER_X = 0.25;
const SHOULDER_Y = 0.2;
const UPPER_ARM = 0.27;
const FOREARM = 0.28;
const ARM_REACH = UPPER_ARM + FOREARM;

const SKIN_TONES = ['#f0c8a0', '#e0ac82', '#c68642', '#8d5524', '#ffdbac'];

function skinFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SKIN_TONES[h % SKIN_TONES.length];
}

/** 유니폼 상의 재질. 종류에 따라 캔버스 텍스처를 만든다. */
function useJerseyMaterial(spec: UniformSpec) {
  return useMemo(() => {
    if (typeof document === 'undefined') {
      return new THREE.MeshStandardMaterial({ color: spec.primary, roughness: 0.8 });
    }
    const w = 128;
    const h = 128;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;

    const base = spec.type === 'VEST' ? spec.secondary : spec.primary;
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);

    switch (spec.type) {
      case 'PINSTRIPE':
        g.strokeStyle = spec.secondary;
        g.lineWidth = 2;
        for (let x = 4; x < w; x += 12) {
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x, h);
          g.stroke();
        }
        break;
      case 'GRADIENT': {
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, spec.primary);
        grad.addColorStop(1, spec.accent);
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
        break;
      }
      case 'SASH':
        g.strokeStyle = spec.accent;
        g.lineWidth = 16;
        g.beginPath();
        g.moveTo(-10, h);
        g.lineTo(w + 10, 0);
        g.stroke();
        break;
      case 'VEST':
        // 몸통 가운데만 팀 컬러
        g.fillStyle = spec.primary;
        g.fillRect(w * 0.16, 0, w * 0.68, h);
        break;
      case 'RAGLAN':
        g.fillStyle = spec.secondary;
        g.fillRect(0, 0, w, h * 0.22);
        break;
      default:
        break;
    }
    const tex = new THREE.CanvasTexture(c);
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82 });
  }, [spec.primary, spec.secondary, spec.accent, spec.type]);
}

/**
 * 몸/장비 재질을 선수 단위로 한 번만 만든다.
 * 메시마다 인라인 머티리얼을 쓰면 선수 12명 x 20메시만큼 머티리얼이 생겨
 * 드로우콜 상태 변경이 늘어난다.
 */
function useBodyMaterials(uniform: UniformSpec, skin: string, gloveColor: string, batColor: string) {
  return useMemo(() => {
    const sleeve =
      uniform.type === 'RAGLAN'
        ? uniform.secondary
        : uniform.type === 'VEST'
          ? skin
          : uniform.primary;
    const mk = (color: string, roughness: number) =>
      new THREE.MeshStandardMaterial({ color, roughness });
    return {
      pants: mk(uniform.type === 'VEST' ? uniform.secondary : uniform.primary, 0.85),
      sleeve: mk(sleeve, 0.85),
      skin: mk(skin, 0.7),
      shoe: mk('#111827', 0.6),
      accent: mk(uniform.accent, 0.7),
      cap: mk(uniform.primary, 0.7),
      glove: mk(gloveColor, 0.9),
      bat: mk(batColor, 0.55),
      dark: mk('#111827', 0.8),
    };
  }, [uniform.type, uniform.primary, uniform.secondary, uniform.accent, skin, gloveColor, batColor]);
}

// ---------------------------------------------------------------------------
// 2본 IK — 어깨 위치와 손 목표만 주면 팔 회전을 역산한다.
// 손을 배트 그립/글러브에 정확히 붙일 수 있어 포즈를 각도로 일일이 맞추지 않아도 된다.
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export interface ArmSolution {
  /** 어깨 그룹의 회전 (몸통 로컬) */
  quat: THREE.Quaternion;
  /** 팔꿈치 굽힘 (X축, 음수 = 앞으로 접힘) */
  elbow: number;
}

/**
 * 어깨(shoulder)에서 목표(target)까지 팔을 뻗는다. 좌표는 모두 몸통 로컬.
 * pole은 팔꿈치가 향할 방향 힌트.
 */
function solveArm(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
): ArmSolution {
  const v = _v.copy(target).sub(shoulder);
  let d = v.length();
  const maxD = ARM_REACH * 0.995;
  const minD = 0.12;
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

  // 코사인 법칙으로 팔꿈치 각도
  const cosPhi = (d * d - UPPER_ARM * UPPER_ARM - FOREARM * FOREARM) / (2 * UPPER_ARM * FOREARM);
  const elbow = -Math.acos(clamp(cosPhi, -1, 1));

  // 굽힌 상태에서 손이 놓이는 방향 (팔 로컬)
  const hand = _v2
    .set(0, -(UPPER_ARM + FOREARM * Math.cos(elbow)), -FOREARM * Math.sin(elbow))
    .normalize();
  const dir = _v3.copy(v).normalize();

  const quat = new THREE.Quaternion().setFromUnitVectors(hand, dir);

  // 팔꿈치가 pole 쪽을 보도록 팔 축(dir) 기준으로 비튼다
  const elbowDir = new THREE.Vector3(0, -UPPER_ARM, 0).applyQuaternion(quat);
  const a = elbowDir.sub(dir.clone().multiplyScalar(elbowDir.dot(dir)));
  const b = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)));
  if (a.lengthSq() > 1e-6 && b.lengthSq() > 1e-6) {
    a.normalize();
    b.normalize();
    let ang = Math.acos(clamp(a.dot(b), -1, 1));
    if (a.cross(b).dot(dir) < 0) ang = -ang;
    quat.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, ang));
  }
  return { quat, elbow };
}

// ---------------------------------------------------------------------------
// 포즈 기술 구조체
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

interface LegPose {
  /** 고관절 회전 [x=앞뒤, y=비틀림, z=벌림] */
  hip: V3;
  /** 무릎 굽힘 (양수 = 뒤로 접힘) */
  knee: number;
  /** 발목 */
  ankle: number;
}

interface ArmPose {
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
interface Anchor {
  pos: V3;
  /** YXZ 순서 오일러 */
  rot: V3;
}

interface Pose {
  /** 루트 이동 (모델 로컬). 스트라이드/슬라이딩 등 */
  root: V3;
  /** 골반 높이 보정 */
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

function basePose(): Pose {
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
function mirrorPose(p: Pose): Pose {
  const mv = (v: V3): V3 => [-v[0], v[1], v[2]];
  const mr = (v: V3): V3 => [v[0], -v[1], -v[2]];
  const mLeg = (l: LegPose): LegPose => ({ hip: mr(l.hip), knee: l.knee, ankle: l.ankle });
  const mArm = (a: ArmPose): ArmPose => ({
    target: a.target ? mv(a.target) : undefined,
    pole: a.pole ? mv(a.pole) : undefined,
    euler: a.euler ? mr(a.euler) : undefined,
    elbow: a.elbow,
  });
  const mAnchor = (a?: Anchor): Anchor | undefined =>
    a ? { pos: mv(a.pos), rot: mr(a.rot) } : undefined;
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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0~1 구간 [a,b]를 0~1로 재매핑 */
const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeIn = (t: number) => t * t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** 빠르게 튀어나갔다가 멈추는 채찍 동작 */
const whip = (t: number) => 1 - Math.pow(1 - t, 3);

/** 키프레임 배열을 시간축으로 보간 */
function track(t: number, keys: [number, number][]): number {
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

// ---------------------------------------------------------------------------
// 포즈 정의
// ---------------------------------------------------------------------------

/**
 * 타격 자세. 기준은 우타자(손이 +X = 포수 쪽).
 * load는 투수의 딜리버리 진행도로, 0이면 대기 1이면 히칭/스트라이드 직전.
 */
function battingPose(player: Player, load: number): Pose {
  const p = basePose();
  const stance = player.stance;
  // 0 스탠다드 1 오픈 2 클로즈드 3 크라우칭 4 레그킥 5 노스텝
  const open = stance === 1 ? -0.24 : stance === 2 ? 0.2 : 0;
  const crouch = stance === 3 ? 0.2 : 0;
  const legKick = stance === 4 ? load : 0;

  p.hipDrop = -0.1 - crouch * 0.5;
  p.hipRot = [0, 0.26 + open, 0];
  p.torso = [0.14 + crouch * 0.4, 0.34 + load * 0.12, 0.04];
  p.head = [0.05, -0.5 - open * 0.5, 0];

  // 앞발(-X)은 투수 쪽, 뒷발(+X)에 체중
  p.legL = { hip: [0.12 - legKick * 1.5, -0.1, -0.3], knee: 0.34 + legKick * 1.3, ankle: 0 };
  p.legR = { hip: [-0.1, 0.12, 0.3], knee: 0.48 + crouch * 0.5, ankle: 0 };
  if (legKick > 0.02) p.root = [-0.02 * legKick, 0, 0];

  // 배트: 뒤쪽 어깨 위에 세우고 살짝 눕힌다
  const wrap = lerp(0, 0.16, load);
  p.bat = {
    pos: [0.21, 0.14 - crouch * 0.05, -0.12],
    rot: [-0.22 - wrap, 0.5, -0.62 - wrap * 0.7],
  };
  p.topHand = 'R';
  p.ground = true;
  return p;
}

/**
 * 스윙. t=0 로드 -> 0.45 임팩트 -> 1 팔로스루.
 * 골반이 먼저 열리고 몸통이 따라 도는 순서(분리)로 회전시킨다.
 */
function swingPose(player: Player, t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const stance = player.stance;
  const crouch = stance === 3 ? 0.18 : 0;

  // 골반 -> 몸통 순서로 열린다
  const hipY = track(k, [
    [0, 0.3],
    [0.16, 0.4],
    [0.45, -0.5],
    [0.7, -1.05],
    [1, -1.2],
  ]);
  const torsoY = track(k, [
    [0, 0.36],
    [0.2, 0.46],
    [0.45, -0.3],
    [0.72, -0.95],
    [1, -1.15],
  ]);

  // 스트라이드: 앞발이 들렸다 내려디디며 몸이 살짝 앞으로
  const stride = track(k, [
    [0, 0],
    [0.18, 0.5],
    [0.4, 1],
    [1, 1],
  ]);

  p.hipDrop = -0.12 - crouch * 0.4 - Math.sin(k * Math.PI) * 0.05;
  p.hipRot = [0, hipY, 0];
  p.torso = [0.16 - k * 0.05, torsoY, 0.05 + k * 0.16];
  // 머리는 임팩트까지 공을 본다 (몸통이 돌아도 시선 고정)
  p.head = [0.08, clamp(-0.55 - torsoY * 0.85, -0.9, 0.9), 0];
  p.root = [lerp(0.04, -0.03, stride), 0, 0];

  p.legL = {
    hip: [lerp(0.2, -0.16, stride), -0.12, lerp(-0.24, -0.36, stride)],
    knee: lerp(0.5, 0.2, stride),
    ankle: 0,
  };
  // 뒷발은 임팩트 이후 뒤꿈치가 들리며 회전한다
  p.legR = {
    hip: [lerp(-0.12, 0.16, k), lerp(0.15, -0.5, k), 0.3],
    knee: lerp(0.44, 0.72, k),
    ankle: lerp(0, -0.7, easeIn(k)),
  };

  // 배트: 뒤에서 지연됐다가(래그) 임팩트에서 앞으로 채고 어깨로 감긴다
  const batYaw = track(k, [
    [0, 0.5],
    [0.2, 0.72],
    [0.45, -0.15],
    [0.68, -1.1],
    [1, -1.9],
  ]);
  const batRoll = track(k, [
    [0, -0.62],
    [0.2, -0.8],
    [0.45, -1.42],
    [0.7, -1.1],
    [1, -0.2],
  ]);
  const batPitch = track(k, [
    [0, -0.22],
    [0.45, 0.12],
    [1, 0.5],
  ]);
  // 손은 몸 앞으로 나오며 임팩트에서 팔이 펴진다.
  // 양손이 모두 배트 그립에 닿아야 하므로 어깨에서 팔 길이(0.55m)를 넘지 않게 잡는다.
  const hx = track(k, [
    [0, 0.2],
    [0.2, 0.23],
    [0.45, 0.02],
    [0.7, -0.16],
    [1, -0.2],
  ]);
  const hz = track(k, [
    [0, -0.14],
    [0.2, -0.18],
    [0.45, 0.24],
    [0.7, 0.2],
    [1, -0.05],
  ]);
  p.bat = { pos: [hx, 0.14, hz], rot: [batPitch, batYaw, batRoll] };
  p.topHand = 'R';
  p.ground = true;
  return p;
}

/** 셋포지션. 글러브를 가슴 앞에 모으고 사인을 본다. */
function pitchingSetPose(breath: number): Pose {
  const p = basePose();
  p.hipDrop = -0.05;
  p.hipRot = [0, 0.12, 0];
  p.torso = [0.08 + breath * 0.02, 0.16, 0];
  p.head = [0.04, -0.14, 0];
  p.legL = { hip: [0.05, -0.08, -0.12], knee: 0.24, ankle: 0 };
  p.legR = { hip: [-0.05, 0.1, 0.14], knee: 0.2, ankle: 0 };

  // 글러브를 가슴 앞에 두고 양손을 그 안에 모은다
  p.glove = { pos: [0.02, 0.14 + breath * 0.02, 0.22], rot: [0.2, -0.2, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.03, 0.1 + breath * 0.02, 0.2], pole: [-0.7, -0.6, -0.3] };
  p.ground = true;
  return p;
}

/**
 * 와인드업 -> 릴리스 -> 팔로스루.
 * 기준은 우투수(던지는 팔이 -X, 글러브가 +X). t는 0~1이고 RELEASE_AT에서 공을 놓는다.
 */
export const RELEASE_AT = 0.56;

function pitchingPose(player: Player, t: number): Pose {
  const p = basePose();
  const k = clamp(t, 0, 1);
  const form = clamp(player.form, 0, 4);

  // 팔 슬롯: 0=수직(오버스로) ~ 2.4=아래(언더핸드)
  const slot = [0.22, 0.62, 1.35, 2.1, 0.3][form];
  // 토네이도는 와인드업에서 등을 크게 보인다
  const turnAway = form === 4 ? 1.25 : 0.55;

  const rel = RELEASE_AT;

  // ---- 몸통/골반 -------------------------------------------------------
  const hipY = track(k, [
    [0, 0.1],
    [0.24, turnAway * 0.55],
    [rel - 0.16, 0.06],
    [rel, -0.42],
    [1, -0.72],
  ]);
  const torsoY = track(k, [
    [0, 0.16],
    [0.26, turnAway],
    [rel - 0.1, 0.42],
    [rel, -0.5],
    [0.8, -0.9],
    [1, -0.8],
  ]);
  const torsoX = track(k, [
    [0, 0.08],
    [0.26, -0.06],
    [rel - 0.08, 0.1],
    [rel, 0.34],
    [0.85, 0.66],
    [1, 0.58],
  ]);
  // 던지는 팔(-X) 반대쪽으로 몸을 기울여야 팔이 위로 선다.
  // Z 회전이 음수면 상체가 글러브 쪽(+X)으로 넘어간다. 슬롯이 낮을수록 크게 기운다.
  const tiltAmt = -(0.12 + slot * 0.34);
  const torsoZ = track(k, [
    [0, 0],
    [0.3, -0.08],
    [rel, tiltAmt],
    [0.85, tiltAmt * 0.7],
    [1, tiltAmt * 0.4],
  ]);

  p.hipRot = [0, hipY, 0];
  p.torso = [torsoX, torsoY, torsoZ];
  p.head = [0.02, clamp(-torsoY * 0.8, -0.7, 0.7), -torsoZ * 0.6];

  // ---- 하체 -------------------------------------------------------------
  // 앞다리(+X 쪽)를 높이 들었다가 홈 쪽으로 내디딘다
  const lift = track(k, [
    [0, 0],
    [0.26, 1],
    [0.42, 0.75],
    [rel, 0],
    [1, 0],
  ]);
  const strideOut = track(k, [
    [0, 0],
    [0.3, 0.1],
    [rel - 0.04, 1],
    [1, 1],
  ]);
  p.legR = {
    hip: [lerp(-0.1, 1.45, lift) - strideOut * 0.55, lerp(0.1, 0.35, lift), 0.16],
    knee: lerp(0.2, 1.75, lift) * (1 - strideOut * 0.72) + 0.12,
    ankle: lerp(0, 0.2, strideOut),
  };
  // 축발(-X)은 밀어내며 뻗었다가 팔로스루에서 뒤로 떠오른다
  const drive = track(k, [
    [0, 0],
    [0.3, 0.15],
    [rel, 0.85],
    [0.78, 1],
    [1, 1],
  ]);
  p.legL = {
    hip: [lerp(0.06, -0.72, drive), -0.12, -0.14 - drive * 0.18],
    knee: lerp(0.28, 1.15, drive),
    ankle: lerp(0, -0.5, drive),
  };

  // 골반 높이: 레그킥에서 살짝 올라갔다가 스트라이드에서 크게 내려앉는다
  p.hipDrop = track(k, [
    [0, -0.04],
    [0.26, 0.03],
    [rel, -0.24],
    [0.8, -0.2],
    [1, -0.12],
  ]);
  // 몸 전체가 홈(+Z) 쪽으로 이동
  p.root = [0, 0, track(k, [
    [0, 0],
    [0.28, -0.06],
    [rel, 0.62],
    [1, 0.95],
  ])];

  // ---- 팔 ---------------------------------------------------------------
  const shoulderL = new THREE.Vector3(-SHOULDER_X, SHOULDER_Y, 0);

  // 던지는 팔: 글러브 안 -> 아래로 분리 -> 뒤로 코킹 -> 릴리스 -> 몸 앞 가로지르기
  const cock = new THREE.Vector3(-0.34, 0.34, -0.44); // 어깨 뒤 높은 곳
  // 릴리스 지점은 어깨에서 슬롯 방향으로 팔을 거의 다 편 곳.
  // 앞(+Z) 성분을 크게 주면 팔이 앞으로 눕기만 하고 "위에서 내리꽂는" 느낌이 사라진다.
  const release = new THREE.Vector3(-Math.sin(slot), Math.cos(slot), 0.22)
    .normalize()
    .multiplyScalar(ARM_REACH * 0.97)
    .add(shoulderL);

  let armLTarget: THREE.Vector3;
  if (k < 0.2) {
    // 글러브 안에 모여 있다
    armLTarget = new THREE.Vector3(-0.04, 0.12, 0.2).lerp(
      new THREE.Vector3(-0.2, -0.14, 0.02),
      span(k, 0.1, 0.2),
    );
  } else if (k < 0.36) {
    // 아래로 크게 내려 뒤로 뺀다
    armLTarget = new THREE.Vector3(-0.2, -0.14, 0.02).lerp(
      new THREE.Vector3(-0.42, -0.16, -0.34),
      easeInOut(span(k, 0.2, 0.36)),
    );
  } else if (k < rel - 0.06) {
    armLTarget = new THREE.Vector3(-0.42, -0.16, -0.34).lerp(
      cock,
      easeOut(span(k, 0.36, rel - 0.06)),
    );
  } else if (k < rel) {
    armLTarget = cock.clone().lerp(release, whip(span(k, rel - 0.06, rel)));
  } else {
    // 팔로스루: 반대쪽 허리까지 채찍처럼 내려온다.
    // 목표를 어깨에서 팔 길이 안쪽으로 잡아야 IK가 포화되지 않는다.
    const finish = new THREE.Vector3(0.78, -0.6, 0.18)
      .normalize()
      .multiplyScalar(ARM_REACH * 0.9)
      .add(shoulderL);
    armLTarget = release.clone().lerp(finish, easeOut(span(k, rel, 0.9)));
  }
  p.armL = {
    target: [armLTarget.x, armLTarget.y, armLTarget.z],
    pole: k > rel - 0.1 && k < rel + 0.2 ? [-0.4, 0.2, -1] : [-1, -0.5, -0.5],
  };

  // 글러브 팔: 타깃을 향해 뻗었다가 릴리스에서 가슴으로 당긴다
  const gloveOut = new THREE.Vector3(0.16, 0.26, 0.46);
  const gloveTuck = new THREE.Vector3(0.3, 0.02, 0.06);
  let gl: THREE.Vector3;
  if (k < 0.22) {
    gl = new THREE.Vector3(0.02, 0.14, 0.22).lerp(gloveOut, easeOut(span(k, 0.12, 0.22)));
  } else if (k < rel) {
    gl = gloveOut.clone();
  } else {
    gl = gloveOut.clone().lerp(gloveTuck, easeOut(span(k, rel, rel + 0.22)));
  }
  p.glove = {
    pos: [gl.x, gl.y, gl.z],
    rot: [0.1, -0.5 + k * 0.5, 0],
  };
  p.gloveHand = 'R';
  // 축발/앞발 중 낮은 쪽이 항상 지면에 닿게 한다 (레그킥·스트라이드 모두 대응)
  p.ground = true;
  return p;
}

/** 수비 준비 자세 */
function fieldingPose(t: number): Pose {
  const p = basePose();
  const bob = Math.sin(t * Math.PI * 2) * 0.5 + 0.5;
  p.hipDrop = -0.05 - bob * 0.04;
  p.torso = [0.42, 0, 0];
  p.head = [-0.26, 0, 0];
  // 무릎을 앞으로 굽혀 발이 몸 아래에 오게 한다
  p.legL = { hip: [-0.15, -0.05, -0.26], knee: 0.95 + bob * 0.08, ankle: -0.5 };
  p.legR = { hip: [-0.15, 0.05, 0.26], knee: 0.95 + bob * 0.08, ankle: -0.5 };
  p.glove = { pos: [0.2, -0.18, 0.34], rot: [0.9, -0.3, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.24, -0.2, 0.3], pole: [-1, -0.4, -0.4] };
  p.ground = true;
  return p;
}

/** 포수 크라우칭 */
function catchingPose(t: number): Pose {
  const p = basePose();
  p.hipDrop = 0;
  p.hipRot = [0, 0, 0];
  p.torso = [0.24, 0, 0];
  p.head = [-0.1, 0, 0];
  // 고관절 X가 음수여야 무릎이 앞으로 나온다. 양수로 주면 발이 엉덩이보다 높아져
  // 접지 보정이 골반을 지면 아래로 끌어내린다.
  p.legL = { hip: [-1.4, -0.12, -0.42], knee: 2.2, ankle: -0.8 };
  p.legR = { hip: [-1.4, 0.12, 0.42], knee: 2.2, ankle: -0.8 };
  p.glove = { pos: [0.12, 0.08, 0.42], rot: [0.1, -0.2, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.3, -0.14, 0.06], pole: [-1, -0.3, -0.5] };
  p.ground = true;
  return p;
}

/**
 * 달리기 사이클. t는 0~1이 한 걸음 주기(양발 1회).
 * intensity로 전력질주(1)와 조깅(0.4)을 구분한다.
 */
function runningPose(t: number, intensity: number): Pose {
  const p = basePose();
  const q = clamp(intensity, 0.25, 1.2);
  const ph = t * Math.PI * 2;
  const amp = 0.55 + 0.35 * q;

  const legPhase = (a: number): LegPose => ({
    hip: [Math.sin(a) * amp, 0, 0],
    // 발이 뒤로 빠진 직후 무릎이 가장 많이 접힌다
    knee: 0.18 + (0.9 + 0.55 * q) * Math.pow(Math.max(0, -Math.sin(a - 0.5)), 1.3),
    ankle: -0.2 + Math.sin(a + 1.2) * 0.25,
  });
  p.legL = legPhase(ph);
  p.legR = legPhase(ph + Math.PI);
  // 다리 벌림
  p.legL.hip[2] = -0.06;
  p.legR.hip[2] = 0.06;

  // 접지 보정 위에 도약(플라이트 구간)을 얹는다. 발이 지면을 뚫지 않으면서도
  // 두 발이 모두 떠 있는 순간이 생겨 걷는 것처럼 보이지 않는다.
  p.root[1] = Math.max(0, Math.sin(ph * 2)) * 0.05 * q;
  p.hipDrop = -0.07 * q;
  p.hipRot = [0, -Math.sin(ph) * 0.16, 0];
  p.torso = [0.2 + 0.18 * q, Math.sin(ph) * 0.24, 0];
  p.head = [-0.16 - 0.1 * q, 0, 0];

  // 팔 펌핑: 다리와 반대 위상, 팔꿈치는 90도 근처로 고정
  const armSwing = 0.55 + 0.45 * q;
  p.armL = { euler: [-Math.sin(ph) * armSwing - 0.15, 0, 0.12], elbow: -1.5 - 0.35 * q };
  p.armR = { euler: [Math.sin(ph) * armSwing - 0.15, 0, -0.12], elbow: -1.5 - 0.35 * q };
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
  p.head = [0.35, 0, 0];
  p.legL = { hip: [-1.5, 0, -0.1], knee: 0.1, ankle: -0.3 };
  p.legR = { hip: [-1.5, 0.1, 0.26], knee: 2.7, ankle: 0 };
  p.armL = { euler: [-1.9, 0.2, 0.5], elbow: -0.5 };
  p.armR = { euler: [-2.1, -0.2, -0.4], elbow: -0.4 };
  p.ground = false;
  return p;
}

/** 홈런/득점 세리머니 */
function celebratePose(t: number): Pose {
  const p = basePose();
  const s = Math.sin(t * Math.PI * 2);
  p.root[1] = Math.max(0, s) * 0.06;
  p.hipDrop = 0;
  p.torso = [-0.1, s * 0.12, 0];
  p.head = [-0.24, s * 0.2, 0];
  p.legL = { hip: [0.1, 0, -0.12], knee: 0.2, ankle: 0 };
  p.legR = { hip: [0.1, 0, 0.12], knee: 0.2, ankle: 0 };
  p.armL = { euler: [-2.5 + s * 0.2, 0, 0.5], elbow: -0.6 };
  p.armR = { euler: [-2.5 - s * 0.2, 0, -0.5], elbow: -0.6 };
  p.ground = true;
  return p;
}

function idlePose(t: number): Pose {
  const p = basePose();
  const b = Math.sin(t * Math.PI * 2) * 0.5 + 0.5;
  p.hipDrop = -0.03 - b * 0.02;
  p.torso = [0.05, 0, 0];
  p.legL = { hip: [0.03, 0, -0.08], knee: 0.16 + b * 0.05, ankle: 0 };
  p.legR = { hip: [0.03, 0, 0.08], knee: 0.16 + b * 0.05, ankle: 0 };
  p.armL = { euler: [0.1 - b * 0.05, 0, 0.14], elbow: -0.35 };
  p.armR = { euler: [0.1 - b * 0.05, 0, -0.14], elbow: -0.35 };
  p.ground = true;
  return p;
}

function buildPose(kind: PoseKind, t: number, player: Player, intensity: number): Pose {
  switch (kind) {
    case 'BATTING':
      return player.bats === 'L' ? mirrorPose(battingPose(player, t)) : battingPose(player, t);
    case 'BATTING_SWING':
      return player.bats === 'L' ? mirrorPose(swingPose(player, t)) : swingPose(player, t);
    case 'PITCHING_SET':
      return player.throws === 'L'
        ? mirrorPose(pitchingSetPose(t))
        : pitchingSetPose(t);
    case 'PITCHING_RELEASE':
      return player.throws === 'L'
        ? mirrorPose(pitchingPose(player, t))
        : pitchingPose(player, t);
    case 'FIELDING':
      return player.throws === 'L'
        ? mirrorPose(fieldingPose(t))
        : fieldingPose(t);
    case 'CATCHING':
      return player.throws === 'L'
        ? mirrorPose(catchingPose(t))
        : catchingPose(t);
    case 'RUNNING':
      return runningPose(t, intensity);
    case 'SLIDING':
      return slidingPose(t);
    case 'CELEBRATE':
      return celebratePose(t);
    default:
      return idlePose(t);
  }
}

// ---------------------------------------------------------------------------
// 포즈 -> 실제 변환 (접지 보정 + 팔 IK)
// ---------------------------------------------------------------------------

interface Rig {
  rootY: number;
  armL: ArmSolution;
  armR: ArmSolution;
  batQuat?: THREE.Quaternion;
  gloveQuat?: THREE.Quaternion;
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

function eulerQuat(r: V3, order: THREE.EulerOrder = 'YXZ'): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], order));
}

/** 다리 FK로 발바닥 높이를 구한다 (골반 로컬) */
function footHeight(leg: LegPose, sign: number, hipQuat: THREE.Quaternion): number {
  _e.set(leg.hip[0], leg.hip[1], leg.hip[2], 'XYZ');
  const hq = _q.setFromEuler(_e);
  const knee = new THREE.Vector3(0, -THIGH, 0).applyQuaternion(hq);
  const kq = new THREE.Quaternion().setFromEuler(new THREE.Euler(leg.knee, 0, 0, 'XYZ'));
  const ankle = new THREE.Vector3(0, -SHIN, 0).applyQuaternion(hq.clone().multiply(kq));
  const foot = new THREE.Vector3(sign * HIP_X, 0, 0).add(knee).add(ankle);
  foot.y -= FOOT_DROP;
  foot.applyQuaternion(hipQuat);
  return foot.y;
}

function solveRig(pose: Pose): Rig {
  const hipQuat = eulerQuat(pose.hipRot, 'XYZ');

  // 낮은 쪽 발이 지면에 닿도록 루트를 올린다
  let rootY = pose.root[1];
  if (pose.ground) {
    const fl = footHeight(pose.legL, -1, hipQuat);
    const fr = footHeight(pose.legR, 1, hipQuat);
    const lowest = HIP_H + pose.hipDrop + Math.min(fl, fr);
    rootY += -lowest;
  }

  // 장비 부착점 -> 손 목표
  const batQuat = pose.bat ? eulerQuat(pose.bat.rot) : undefined;
  const gloveQuat = pose.glove ? eulerQuat(pose.glove.rot) : undefined;

  const armL: ArmPose = { ...pose.armL };
  const armR: ArmPose = { ...pose.armR };

  if (pose.bat && batQuat) {
    const origin = new THREE.Vector3(...pose.bat.pos);
    // 배트 로컬 +Y가 배럴 방향. 그립은 원점 근처 두 지점.
    const lowGrip = new THREE.Vector3(0, -0.02, 0).applyQuaternion(batQuat).add(origin);
    const topGrip = new THREE.Vector3(0, 0.11, 0).applyQuaternion(batQuat).add(origin);
    const top = pose.topHand ?? 'R';
    const pole: V3 = [0, -0.7, -1];
    if (top === 'R') {
      armR.target = [topGrip.x, topGrip.y, topGrip.z];
      armL.target = [lowGrip.x, lowGrip.y, lowGrip.z];
    } else {
      armL.target = [topGrip.x, topGrip.y, topGrip.z];
      armR.target = [lowGrip.x, lowGrip.y, lowGrip.z];
    }
    armL.pole = armL.pole ?? pole;
    armR.pole = armR.pole ?? pole;
  }

  if (pose.glove && gloveQuat && pose.gloveHand) {
    const g = pose.glove.pos;
    if (pose.gloveHand === 'R') armR.target = g;
    else armL.target = g;
  }

  const solve = (arm: ArmPose, sign: number): ArmSolution => {
    if (arm.target) {
      return solveArm(
        new THREE.Vector3(sign * SHOULDER_X, SHOULDER_Y, 0),
        new THREE.Vector3(...arm.target),
        new THREE.Vector3(...(arm.pole ?? [sign, -0.8, -0.6])).normalize(),
      );
    }
    return {
      quat: eulerQuat(arm.euler ?? [0, 0, 0], 'XYZ'),
      elbow: arm.elbow ?? -0.2,
    };
  };

  return {
    rootY,
    armL: solve(armL, -1),
    armR: solve(armR, 1),
    batQuat,
    gloveQuat,
  };
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------

interface Props {
  player: Player;
  uniform: UniformSpec;
  pose?: PoseKind;
  /** 모션 진행도 0~1 (RUNNING은 반복 위상) */
  animT?: number;
  /** 달리기 강도 등 세기 조절 */
  intensity?: number;
  position?: [number, number, number];
  rotationY?: number;
  showName?: boolean;
  scale?: number;
}

/**
 * 저폴리 선수 모델.
 * 외부 3D 파일 없이 기본 도형을 관절 계층(골반-다리-무릎 / 몸통-어깨-팔꿈치-손)으로
 * 묶고, 손 위치는 2본 IK로 풀어 배트·글러브에 정확히 붙인다.
 */
export function PlayerModel({
  player,
  uniform,
  pose = 'IDLE',
  animT = 0,
  intensity = 1,
  position = [0, 0, 0],
  rotationY = 0,
  scale = 1,
}: Props) {
  const jersey = useJerseyMaterial(uniform);
  const skin = useMemo(() => skinFor(player.id), [player.id]);
  const mat = useBodyMaterials(uniform, skin, player.gear.gloveColor, player.gear.batColor);

  const p = buildPose(pose, animT, player, intensity);
  const rig = solveRig(p);

  return (
    <group
      position={[position[0] + p.root[0], position[1] + rig.rootY, position[2] + p.root[2]]}
      rotation={[0, rotationY, 0]}
      scale={scale}
    >
      {/* 골반 */}
      <group position={[0, HIP_H + p.hipDrop, 0]} rotation={p.hipRot}>
        <Leg pose={p.legL} sign={-1} mat={mat} />
        <Leg pose={p.legR} sign={1} mat={mat} />

        {/* 몸통 */}
        <group position={[0, TORSO_Y, 0]} rotation={[p.torso[0], p.torso[1], p.torso[2]]}>
          <mesh castShadow material={jersey}>
            <capsuleGeometry args={[0.2, 0.42, 4, 10]} />
          </mesh>
          {/* 벨트 */}
          <mesh position={[0, -0.24, 0]} material={mat.accent}>
            <cylinderGeometry args={[0.203, 0.203, 0.07, 12]} />
          </mesh>

          <Arm sign={-1} sol={rig.armL} mat={mat} accessory={player.gear.accessory} />
          <Arm sign={1} sol={rig.armR} mat={mat} accessory={player.gear.accessory} />

          {/* 장비는 몸통에 붙여 두 손이 같은 지점을 잡게 한다 */}
          {p.bat && rig.batQuat && (
            <group position={p.bat.pos} quaternion={rig.batQuat}>
              <Bat type={player.gear.bat} mat={mat} />
            </group>
          )}
          {p.glove && rig.gloveQuat && (
            <group position={p.glove.pos} quaternion={rig.gloveQuat}>
              <Glove type={player.gear.glove} mat={mat} />
            </group>
          )}

          {/* 목걸이. 몸통 반지름(0.2)에 맞춰 가슴 표면을 감싸고 앞쪽이 처진다. */}
          {player.gear.accessory === 'NECKLACE' && (
            <>
              <mesh position={[0, 0.19, 0.01]} rotation={[Math.PI / 2 + 0.22, 0, 0]} material={mat.accent}>
                <torusGeometry args={[0.206, 0.011, 6, 22]} />
              </mesh>
              <mesh position={[0, 0.145, 0.204]} material={mat.accent}>
                <sphereGeometry args={[0.025, 8, 6]} />
              </mesh>
            </>
          )}

          {/* 머리 */}
          <group position={[0, 0.42, 0]} rotation={[p.head[0], p.head[1], p.head[2]]}>
            <mesh castShadow material={mat.skin}>
              <sphereGeometry args={[0.145, 14, 12]} />
            </mesh>
            <mesh position={[0, 0.06, 0]} castShadow material={mat.cap}>
              <sphereGeometry args={[0.152, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
            </mesh>
            <mesh position={[0, 0.03, 0.14]} rotation={[0.28, 0, 0]} material={mat.cap}>
              <boxGeometry args={[0.19, 0.02, 0.13]} />
            </mesh>
            {player.gear.accessory === 'EYE_BLACK' && (
              <mesh position={[0, -0.02, 0.135]} material={mat.dark}>
                <boxGeometry args={[0.16, 0.028, 0.01]} />
              </mesh>
            )}
          </group>
        </group>
      </group>
    </group>
  );
}

type Mats = ReturnType<typeof useBodyMaterials>;

/** 허벅지 - 무릎 - 정강이 - 발 */
function Leg({ pose, sign, mat }: { pose: LegPose; sign: number; mat: Mats }) {
  return (
    <group position={[sign * HIP_X, 0, 0]} rotation={pose.hip}>
      <mesh castShadow position={[0, -THIGH / 2, 0]} material={mat.pants}>
        <capsuleGeometry args={[0.093, THIGH - 0.19, 4, 8]} />
      </mesh>
      <group position={[0, -THIGH, 0]} rotation={[pose.knee, 0, 0]}>
        <mesh castShadow position={[0, -SHIN / 2, 0]} material={mat.pants}>
          <capsuleGeometry args={[0.078, SHIN - 0.16, 4, 8]} />
        </mesh>
        <mesh
          castShadow
          position={[0, -SHIN - 0.01, 0.06]}
          rotation={[pose.ankle, 0, 0]}
          material={mat.shoe}
        >
          <boxGeometry args={[0.14, 0.09, 0.27]} />
        </mesh>
      </group>
    </group>
  );
}

/** 상완 - 팔꿈치 - 전완 - 손. 액세서리는 양팔에 같이 붙는다. */
function Arm({
  sign,
  sol,
  mat,
  accessory,
}: {
  sign: number;
  sol: ArmSolution;
  mat: Mats;
  accessory: AccessoryType;
}) {
  return (
    <group position={[sign * SHOULDER_X, SHOULDER_Y, 0]} quaternion={sol.quat}>
      <mesh castShadow position={[0, -UPPER_ARM / 2, 0]} material={mat.sleeve}>
        <capsuleGeometry args={[0.066, UPPER_ARM - 0.13, 4, 8]} />
      </mesh>
      <group position={[0, -UPPER_ARM, 0]} rotation={[sol.elbow, 0, 0]}>
        <mesh castShadow position={[0, -FOREARM / 2, 0]} material={mat.skin}>
          <capsuleGeometry args={[0.058, FOREARM - 0.12, 4, 8]} />
        </mesh>
        {/* 암슬리브: 전완을 살짝 덮는다 */}
        {accessory === 'ARM_SLEEVE' && (
          <mesh position={[0, -FOREARM / 2 + 0.02, 0]} material={mat.dark}>
            <capsuleGeometry args={[0.062, FOREARM - 0.14, 4, 8]} />
          </mesh>
        )}
        {accessory === 'WRISTBAND' && (
          <mesh position={[0, -FOREARM + 0.055, 0]} material={mat.accent}>
            <cylinderGeometry args={[0.066, 0.066, 0.05, 10]} />
          </mesh>
        )}
        <mesh position={[0, -FOREARM, 0]} material={mat.skin}>
          <sphereGeometry args={[0.066, 10, 8]} />
        </mesh>
      </group>
    </group>
  );
}

/** 배트 실루엣. len은 전체 길이, handle은 그립 반지름. */
const BAT_SHAPES: Record<BatType, { barrel: number; handle: number; len: number }> = {
  CLASSIC: { barrel: 0.04, handle: 0.014, len: 0.86 },
  FLARE: { barrel: 0.039, handle: 0.021, len: 0.84 },
  TAPERED: { barrel: 0.037, handle: 0.013, len: 0.9 },
  AXE: { barrel: 0.041, handle: 0.015, len: 0.86 },
  THICK: { barrel: 0.048, handle: 0.015, len: 0.82 },
};

/** 배트. 로컬 +Y가 배럴 방향, 원점이 그립. */
function Bat({ type, mat }: { type: BatType; mat: Mats }) {
  const s = BAT_SHAPES[type];
  return (
    <group>
      <mesh position={[0, s.len / 2 - 0.07, 0]} castShadow material={mat.bat}>
        <cylinderGeometry args={[s.barrel, s.handle, s.len, 10]} />
      </mesh>
      {/* 그립 테이프 */}
      <mesh position={[0, 0.02, 0]} material={mat.dark}>
        <cylinderGeometry args={[s.handle + 0.005, s.handle + 0.004, 0.17, 10]} />
      </mesh>
      {/* 노브 */}
      <mesh position={[0, -0.07, 0]} material={mat.bat}>
        {type === 'AXE' ? (
          <boxGeometry args={[0.05, 0.06, 0.035]} />
        ) : (
          <cylinderGeometry args={[0.026, 0.026, 0.02, 8]} />
        )}
      </mesh>
    </group>
  );
}

/**
 * 글러브 실루엣. scale은 포켓(구) 비율, web은 [폭, 길이].
 * 포수 미트는 웹 대신 테두리(rim)로 둥근 실루엣을 만든다.
 */
const GLOVE_SHAPES: Record<
  GloveType,
  { r: number; scale: [number, number, number]; web: [number, number] | null; rim: boolean }
> = {
  INFIELD: { r: 0.125, scale: [1, 1, 1], web: [0.2, 0.13], rim: false },
  OUTFIELD: { r: 0.132, scale: [0.94, 1.18, 0.86], web: [0.19, 0.21], rim: false },
  PITCHER: { r: 0.128, scale: [1.04, 1.02, 0.94], web: [0.23, 0.1], rim: false },
  CATCHER: { r: 0.15, scale: [1.06, 1.02, 0.72], web: null, rim: true },
  FIRSTBASE: { r: 0.128, scale: [0.86, 1.32, 0.8], web: [0.15, 0.17], rim: false },
};

function Glove({ type, mat }: { type: GloveType; mat: Mats }) {
  const s = GLOVE_SHAPES[type];
  return (
    <group>
      <mesh castShadow scale={s.scale} material={mat.glove}>
        <sphereGeometry args={[s.r, 10, 8]} />
      </mesh>
      {s.web && (
        <mesh
          position={[0, s.r * s.scale[1] * 0.5, 0.05]}
          rotation={[0.4, 0, 0]}
          material={mat.glove}
        >
          <boxGeometry args={[s.web[0], s.web[1], 0.04]} />
        </mesh>
      )}
      {s.rim && (
        <mesh rotation={[Math.PI / 2 - 0.35, 0, 0]} material={mat.glove}>
          <torusGeometry args={[s.r * 1.02, 0.028, 6, 16]} />
        </mesh>
      )}
    </group>
  );
}
