'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp } from '@/lib/game/rng';
import { BODY_BY_ID } from '@/lib/game/constants';
import type {
  AccessoryType,
  BatType,
  GloveType,
  Handedness,
  Player,
  UniformType,
} from '@/lib/game/types';

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
  | 'BATTING_BUNT'
  | 'PITCHING_SET'
  | 'PITCHING_RELEASE'
  | 'FIELDING'
  | 'RUNNING'
  | 'CATCHING'
  | 'SLIDING'
  | 'CELEBRATE';

/** 머리 장비. 지정하지 않으면 포즈에 맞는 기본값을 쓴다. */
export type Headwear = 'CAP' | 'HELMET' | 'MASK';

// ---------------------------------------------------------------------------
// 골격 치수 (리그 단위). 모델 로컬 좌표: +Y 위, +Z 정면, 발바닥이 y=0.
//
// 아래 수치와 포즈 데이터는 한 세트로 튜닝돼 있으므로 손대지 않는다.
// 화면에 그릴 때만 몸 전체를 BODY배로 줄이고 머리를 HEAD_K배로 키워
// SD(3.5등신) 실루엣을 만든다. 이러면 포즈/IK를 다시 맞출 필요가 없다.
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

/**
 * 몸통/팔다리 축소율. 머리를 뺀 나머지에만 걸린다.
 * 이 값으로 키가 약 1.55m, 머리 지름 0.45m (≈3.4등신)가 된다. 스트라이크존
 * (0.45~1.06m)이 무릎~어깨에 오도록 맞춘 값이라 크게 흔들지 않는다.
 */
const BODY = 0.87;
/** 머리 확대율 (월드 기준). BODY로 나눠 몸 스케일을 상쇄한다. */
const HEAD_K = 1.55;
const HEAD_SCALE = HEAD_K / BODY;
/** 몸통 원점에서 머리 중심까지 (리그 단위) */
const HEAD_Y = 0.5;
const HEAD_R = 0.145;
/** 몸통 캡슐 (반지름, 원통 길이) */
const TORSO_R = 0.2;
const TORSO_LEN = 0.24;

// 툰 셰이딩은 가장 밝은 밴드에서 색을 그대로 쓰므로, 흰색에 가까운 톤을 넣으면
// 이마가 하얗게 날아간다. 한 단계씩 내려 잡는다.
const SKIN_TONES = ['#e8b98f', '#d9a375', '#c1885a', '#96603c', '#f0c9a3'];
const HAIR_TONES = ['#20160f', '#2f2118', '#120d0a', '#4a2f1c', '#1a1a1f'];

function hashOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// 재질
// ---------------------------------------------------------------------------

/**
 * 셀 셰이딩용 계단 그라데이션.
 * 단계가 적을수록 만화 같고, 많을수록 부드럽다. 4단계가 캐릭터 실루엣을
 * 뭉개지 않으면서 명암이 또렷하게 나온다.
 */
let gradientMap: THREE.DataTexture | null = null;
function toonGradient(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const steps = [122, 158, 188, 214, 236, 255];
  const data = new Uint8Array(steps);
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientMap = tex;
  return tex;
}

/** 유니폼 상의 재질. 종류에 따라 캔버스 텍스처를 만든다. */
function useJerseyMaterial(spec: UniformSpec) {
  return useMemo(() => {
    const grad = toonGradient();
    if (typeof document === 'undefined') {
      return new THREE.MeshToonMaterial({ color: spec.primary, gradientMap: grad });
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
        const lin = g.createLinearGradient(0, 0, 0, h);
        lin.addColorStop(0, spec.primary);
        lin.addColorStop(1, spec.accent);
        g.fillStyle = lin;
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
    return new THREE.MeshToonMaterial({ map: tex, gradientMap: grad });
  }, [spec.primary, spec.secondary, spec.accent, spec.type]);
}

/** 등번호 패널 텍스처. 몸통 뒤를 감싸는 원통 조각에 붙인다. */
function useNumberMaterial(num: number, color: string, outline: string) {
  return useMemo(() => {
    if (typeof document === 'undefined') return null;
    const w = 128;
    const h = 128;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    // 원통 UV는 뒤에서 보면 좌우가 뒤집히므로 미리 뒤집어 그린다
    g.translate(w, 0);
    g.scale(-1, 1);
    g.font = 'bold 108px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 14;
    g.strokeStyle = outline;
    g.strokeText(String(num), w / 2, h / 2 + 4);
    g.fillStyle = color;
    g.fillText(String(num), w / 2, h / 2 + 4);
    const tex = new THREE.CanvasTexture(c);
    return new THREE.MeshToonMaterial({
      map: tex,
      gradientMap: toonGradient(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
  }, [num, color, outline]);
}

/**
 * 몸/장비 재질을 선수 단위로 한 번만 만든다.
 * 메시마다 인라인 머티리얼을 쓰면 선수 12명 x 25메시만큼 머티리얼이 생겨
 * 드로우콜 상태 변경이 늘어난다.
 */
function useBodyMaterials(
  uniform: UniformSpec,
  skin: string,
  hair: string,
  gloveColor: string,
  batColor: string,
) {
  return useMemo(() => {
    const grad = toonGradient();
    const sleeve =
      uniform.type === 'RAGLAN'
        ? uniform.secondary
        : uniform.type === 'VEST'
          ? skin
          : uniform.primary;
    const toon = (color: string) => new THREE.MeshToonMaterial({ color, gradientMap: grad });
    const flat = (color: string) => new THREE.MeshBasicMaterial({ color });
    return {
      // 야구 바지는 보통 흰/회색이라 서브 컬러를 쓴다
      pants: toon(uniform.secondary),
      sleeve: toon(sleeve),
      skin: toon(skin),
      hair: toon(hair),
      sock: toon(uniform.primary),
      shoe: toon('#16181d'),
      accent: toon(uniform.accent),
      cap: toon(uniform.primary),
      capBrim: toon(uniform.secondary === uniform.primary ? uniform.accent : uniform.secondary),
      glove: toon(gloveColor),
      bat: toon(batColor),
      dark: toon('#111827'),
      metal: toon('#9aa4b2'),
      // 눈/입은 빛을 받지 않아야 어느 각도에서나 표정이 살아 있다
      eyeWhite: flat('#fdfdfd'),
      eyeDark: flat('#171b22'),
    };
  }, [
    uniform.type,
    uniform.primary,
    uniform.secondary,
    uniform.accent,
    skin,
    hair,
    gloveColor,
    batColor,
  ]);
}

type Mats = ReturnType<typeof useBodyMaterials>;

// ---------------------------------------------------------------------------
// 2본 IK — 어깨 위치와 손 목표만 주면 팔 회전을 역산한다.
// 손을 배트 그립/글러브에 정확히 붙일 수 있어 포즈를 각도로 일일이 맞추지 않아도 된다.
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
}

/**
 * 어깨(shoulder)에서 목표(target)까지 팔을 뻗는다. 좌표는 모두 몸통 로컬.
 * pole은 팔꿈치가 향할 방향 힌트.
 */
function solveArm(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  out: ArmSolution,
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

  out.quat.setFromUnitVectors(hand, dir);

  // 팔꿈치가 pole 쪽을 보도록 팔 축(dir) 기준으로 비튼다
  const elbowDir = _v4.set(0, -UPPER_ARM, 0).applyQuaternion(out.quat);
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
  /** 배트를 잡는 아래/위 손의 위치 (배트 로컬 Y). 번트처럼 손을 벌릴 때만 준다. */
  grip?: [number, number];
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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0~1 구간 [a,b]를 0~1로 재매핑 */
const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeIn = (t: number) => t * t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** 빠르게 튀어나갔다가 멈추는 채찍 동작 */
const whip = (t: number) => 1 - Math.pow(1 - t, 3);
const TAU = Math.PI * 2;

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
//
// clock은 모델이 스스로 돌리는 초 단위 시계다. 게임이 t를 물려주지 않는
// 정지 포즈(대기·수비 준비 등)에서도 숨쉬기·체중이동이 계속 살아 있게 한다.
// ---------------------------------------------------------------------------

/**
 * 타석에서 몸통 기준 투수 방향(로컬 +X)까지의 각도.
 * 고개를 정확히 90도 돌리면 목이 부러진 것처럼 보이므로 조금 못 미치게 두고
 * 나머지는 얼굴(눈) 위치가 채운다.
 */
const GAZE_AT_PITCHER = 1.28;

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
  const crouch = stance === 3 ? 0.2 : 0;
  const legKick = stance === 4 ? load : 0;

  // 타이밍을 재는 배트 흔들기. 딜리버리가 진행될수록 잦아들고 몸이 굳는다.
  const calm = 1 - easeIn(clamp(load, 0, 1));
  const wag = Math.sin(clock * 3.3) * calm;
  const sway = Math.sin(clock * 1.65) * calm;

  // 어깨선이 투수를 향하도록 몸통을 살짝 감아 둔다 (음수 = 포수 쪽으로 닫힘)
  const hipY = -0.18 + open - sway * 0.05;
  const torsoY = -0.24 - load * 0.1 + sway * 0.06;

  p.hipDrop = -0.1 - crouch * 0.5 - sway * 0.012;
  p.hipRot = [0, hipY, 0];
  p.torso = [0.14 + crouch * 0.4, torsoY, -0.04];
  // 감긴 몸통 위에서 고개만 투수 쪽으로 돌린다
  p.head = [0.05, GAZE_AT_PITCHER - (hipY + torsoY), 0];

  // 앞발(+X)은 투수 쪽, 뒷발(-X)에 체중
  p.legL = { hip: [-0.1, -0.12, -0.3], knee: 0.48 + crouch * 0.5, ankle: 0 };
  p.legR = { hip: [0.12 - legKick * 1.5, 0.1, 0.3], knee: 0.34 + legKick * 1.3, ankle: 0 };
  // 다리를 들면 체중이 뒤(-X, 포수 쪽)로 실린다
  if (legKick > 0.02) p.root = [-0.02 * legKick, 0, 0];

  // 배트: 뒤쪽(-X) 어깨 위에 세우고 살짝 눕힌다
  const wrap = lerp(0, 0.16, load);
  p.bat = {
    pos: [-0.21, 0.14 - crouch * 0.05, -0.12],
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
  const crouch = stance === 3 ? 0.18 : 0;

  // 골반 -> 몸통 순서로 열린다
  const hipY = track(k, [
    [0, -0.3],
    [0.16, -0.42],
    [0.45, 0.5],
    [0.7, 1.05],
    [1, 1.2],
  ]);
  const torsoY = track(k, [
    [0, -0.36],
    [0.2, -0.5],
    [0.45, 0.3],
    [0.72, 0.95],
    [1, 1.15],
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
  // 어깨선이 임팩트에서 살짝 뒤로 눕는다 (뒤쪽 어깨가 내려가는 축 기울기)
  const shoulderTilt = track(k, [
    [0, 0.05],
    [0.45, 0.2],
    [0.75, 0.06],
    [1, -0.02],
  ]);
  p.torso = [0.16 - k * 0.05, torsoY, -(shoulderTilt + k * 0.1)];
  // 시선: 투수를 보다가 임팩트에서 타격 지점에 고정되고, 그 뒤 몸통을 따라 돈다.
  // 몸통이 얼마나 돌았든 시선의 절대 방향을 먼저 정하고 목 각도를 역산한다.
  const gaze = track(k, [
    [0, GAZE_AT_PITCHER],
    [0.45, 0.68],
    [0.7, 0.3],
    [1, 0],
  ]);
  p.head = [0.08, clamp(gaze - (hipY + torsoY), -1.6, 1.6), 0];
  p.root = [lerp(-0.04, 0.03, stride), 0, 0];

  // 앞발(+X): 들었다가 내려디디며 벽을 만든다
  p.legR = {
    hip: [lerp(0.2, -0.16, stride), 0.12, lerp(0.24, 0.36, stride)],
    knee: lerp(0.5, 0.2, stride),
    ankle: 0,
  };
  // 뒷발(-X)은 임팩트 이후 뒤꿈치가 들리며 회전한다
  p.legL = {
    hip: [lerp(-0.12, 0.16, k), lerp(-0.15, 0.5, k), -0.3],
    knee: lerp(0.44, 0.72, k),
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
  // 손은 몸 앞으로 나오며 임팩트에서 팔이 펴진다.
  // 양손이 모두 배트 그립에 닿아야 하므로 어깨에서 팔 길이(0.55m)를 넘지 않게 잡는다.
  const hx = track(k, [
    [0, -0.2],
    [0.2, -0.24],
    [0.45, -0.02],
    [0.7, 0.16],
    [1, 0.2],
  ]);
  const hz = track(k, [
    [0, -0.14],
    [0.2, -0.19],
    [0.45, 0.24],
    [0.7, 0.2],
    [1, -0.05],
  ]);
  p.bat = { pos: [hx, 0.14, hz], rot: [batPitch, batYaw, batRoll] };
  p.topHand = 'L';
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
  const batX = lerp(-0.21, 0.07, sq);
  const batY = lerp(0.14, 0.13, sq) - crouch * 0.04 - give * 0.02;
  const batZ = lerp(-0.12, 0.31, sq) - give * 0.055;
  p.bat = {
    pos: [batX, batY, batZ],
    rot: [lerp(-0.22, 0.02, sq), lerp(-0.5, 0.3, sq), lerp(0.62, 1.28, sq) + give * 0.07],
    grip: [-0.03, lerp(0.11, 0.3, sq)],
  };
  p.topHand = 'L';
  // 팔꿈치를 아래·바깥으로 떨어뜨려 배트를 눈 아래에서 받친다
  p.armL = { pole: [-0.5, -1, -0.3] };
  p.armR = { pole: [0.5, -1, -0.3] };
  p.ground = true;
  return p;
}

/** 셋포지션. 글러브를 가슴 앞에 모으고 사인을 본다. */
function pitchingSetPose(clock: number): Pose {
  const p = basePose();
  const breath = Math.sin(clock * 1.7) * 0.5 + 0.5;
  // 사인을 확인하는 짧은 고개 움직임
  const peek = Math.sin(clock * 0.62);
  p.hipDrop = -0.05 - breath * 0.015;
  p.hipRot = [0, 0.12, 0];
  p.torso = [0.08 + breath * 0.03, 0.16, 0];
  p.head = [0.04 - breath * 0.03, -0.14 + peek * 0.12, 0];
  p.legL = { hip: [0.05, -0.08, -0.12], knee: 0.24, ankle: 0 };
  p.legR = { hip: [-0.05, 0.1, 0.14], knee: 0.2, ankle: 0 };

  // 글러브를 가슴 앞에 두고 양손을 그 안에 모은다
  p.glove = { pos: [0.02, 0.14 + breath * 0.025, 0.22], rot: [0.2, -0.2, 0] };
  p.gloveHand = 'R';
  p.armL = { target: [-0.03, 0.1 + breath * 0.025, 0.2], pole: [-0.7, -0.6, -0.3] };
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
  // 시선은 계속 포수를 향한다 (몸이 돌아도 머리만 남는다)
  p.head = [0.02, clamp(-torsoY * 0.85, -0.8, 0.8), -torsoZ * 0.6];

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
 * 달리기 사이클. t는 0~1이 한 걸음 주기(양발 1회).
 * intensity로 전력질주(1)와 조깅(0.4)을 구분한다.
 */
function runningPose(t: number, intensity: number): Pose {
  const p = basePose();
  const q = clamp(intensity, 0.25, 1.2);
  const ph = t * TAU;
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
  p.legL = { hip: [-1.5, 0, -0.1], knee: 0.1, ankle: -0.3 };
  p.legR = { hip: [-1.5, 0.1, 0.26], knee: 2.7, ankle: 0 };
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
const SELF_DRIVEN: Partial<Record<PoseKind, true>> = {
  IDLE: true,
  FIELDING: true,
  CATCHING: true,
  CELEBRATE: true,
  PITCHING_SET: true,
};

function buildPose(
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
      return player.throws === 'L' ? mirrorPose(pitchingSetPose(clock)) : pitchingSetPose(clock);
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
    case 'CELEBRATE':
      return celebratePose(clock);
    default:
      return idlePose(clock);
  }
}

// ---------------------------------------------------------------------------
// 포즈 -> 스냅샷 (접지 보정 + 팔 IK). 스냅샷끼리 섞을 수 있어야
// 포즈가 바뀔 때 뚝 끊기지 않고 넘어간다.
// ---------------------------------------------------------------------------

interface LimbSnap {
  quat: THREE.Quaternion;
  knee: number;
  ankle: number;
}

interface Snapshot {
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

function newSnapshot(): Snapshot {
  const limb = (): LimbSnap => ({ quat: new THREE.Quaternion(), knee: 0, ankle: 0 });
  const arm = (): ArmSolution => ({ quat: new THREE.Quaternion(), elbow: 0 });
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

function copySnapshot(src: Snapshot, dst: Snapshot) {
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
  }
  dst.batPos.copy(src.batPos);
  dst.batQuat.copy(src.batQuat);
  dst.glovePos.copy(src.glovePos);
  dst.gloveQuat.copy(src.gloveQuat);
}

/** a -> b 로 u만큼 섞어 dst에 쓴다 (a와 dst가 같아도 안전) */
function mixSnapshot(a: Snapshot, b: Snapshot, u: number, dst: Snapshot) {
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

function setEuler(q: THREE.Quaternion, r: V3, order: THREE.EulerOrder = 'YXZ'): THREE.Quaternion {
  return q.setFromEuler(_e.set(r[0], r[1], r[2], order));
}

/** 다리 FK로 발바닥 높이를 구한다 (골반 로컬) */
function footHeight(leg: LegPose, sign: number, hipQuat: THREE.Quaternion): number {
  const hq = _q.setFromEuler(_e.set(leg.hip[0], leg.hip[1], leg.hip[2], 'XYZ'));
  const foot = _fv.set(0, -THIGH, 0).applyQuaternion(hq);
  const kq = _q2.setFromEuler(_e.set(leg.knee, 0, 0, 'XYZ'));
  const ankle = _fv2.set(0, -SHIN, 0).applyQuaternion(_q3.copy(hq).multiply(kq));
  foot.add(ankle);
  foot.x += sign * HIP_X;
  foot.y -= FOOT_DROP;
  foot.applyQuaternion(hipQuat);
  return foot.y;
}

function writeSnapshot(pose: Pose, out: Snapshot) {
  setEuler(out.hip, pose.hipRot, 'XYZ');

  // 낮은 쪽 발이 지면에 닿도록 루트를 올린다
  let rootY = pose.root[1];
  if (pose.ground) {
    const fl = footHeight(pose.legL, -1, out.hip);
    const fr = footHeight(pose.legR, 1, out.hip);
    rootY += -(HIP_H + pose.hipDrop + Math.min(fl, fr));
  }
  out.root.set(pose.root[0], rootY, pose.root[2]);
  out.hipY = HIP_H + pose.hipDrop;

  setEuler(out.torso, pose.torso);
  setEuler(out.head, pose.head);
  setEuler(out.legL.quat, pose.legL.hip, 'XYZ');
  setEuler(out.legR.quat, pose.legR.hip, 'XYZ');
  out.legL.knee = pose.legL.knee;
  out.legL.ankle = pose.legL.ankle;
  out.legR.knee = pose.legR.knee;
  out.legR.ankle = pose.legR.ankle;

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
    const pole: V3 = [0, -0.7, -1];
    if (top === 'R') {
      armR.target = topArm;
      armL.target = lowArm;
    } else {
      armL.target = topArm;
      armR.target = lowArm;
    }
    armL.pole = armL.pole ?? pole;
    armR.pole = armR.pole ?? pole;
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
      dst.elbow = arm.elbow ?? -0.2;
    }
  };
  solve(armL, -1, out.armL);
  solve(armR, 1, out.armR);
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
  /** 모자/헬멧/포수 마스크. 생략하면 포즈에서 고른다. */
  headwear?: Headwear;
  /**
   * 이 타석에서 실제로 서는 쪽. 생략하면 player.bats를 쓴다.
   *
   * 스위치히터는 상대 투수에 따라 좌우가 바뀌므로 판정과 같은 값을 받아야 한다
   * (@see batting.effectiveBatSide). 이 값이 없으면 "판정은 좌타인데 화면에서는
   * 우타석에 선" 상태가 된다.
   */
  batSide?: Handedness;
  showName?: boolean;
  scale?: number;
}

/** 포즈가 바뀔 때 섞는 시간(초). 짧게 잡아야 스윙/송구가 흐물거리지 않는다. */
const BLEND_SEC = 0.16;

interface Joints {
  root: THREE.Group | null;
  hip: THREE.Group | null;
  torso: THREE.Group | null;
  head: THREE.Group | null;
  legL: LegRefs;
  legR: LegRefs;
  armL: ArmRefs;
  armR: ArmRefs;
  bat: THREE.Group | null;
  glove: THREE.Group | null;
}

interface LegRefs {
  hip: THREE.Group | null;
  knee: THREE.Group | null;
  ankle: THREE.Object3D | null;
}

interface ArmRefs {
  shoulder: THREE.Group | null;
  elbow: THREE.Group | null;
}

function defaultHeadwear(pose: PoseKind): Headwear {
  if (pose === 'CATCHING') return 'MASK';
  if (
    pose === 'BATTING' ||
    pose === 'BATTING_SWING' ||
    pose === 'BATTING_BUNT' ||
    pose === 'RUNNING' ||
    pose === 'SLIDING' ||
    pose === 'CELEBRATE'
  ) {
    return 'HELMET';
  }
  return 'CAP';
}

/**
 * SD 비율(약 3.5등신) 저폴리 선수 모델.
 * 외부 3D 파일 없이 기본 도형을 관절 계층(골반-다리-무릎 / 몸통-어깨-팔꿈치-손)으로
 * 묶고, 손 위치는 2본 IK로 풀어 배트·글러브에 정확히 붙인다.
 *
 * 포즈는 매 프레임 useFrame에서 계산해 오브젝트에 직접 써 넣는다. 리액트
 * 리렌더에 기대지 않으므로 (1) 부모가 다시 그리지 않는 야수도 계속 숨을 쉬고
 * (2) 포즈가 바뀔 때 이전 자세에서 부드럽게 넘어갈 수 있다.
 */
export function PlayerModel({
  player,
  uniform,
  pose = 'IDLE',
  animT = 0,
  intensity = 1,
  position = [0, 0, 0],
  rotationY = 0,
  headwear,
  scale = 1,
  batSide,
}: Props) {
  const jersey = useJerseyMaterial(uniform);
  const h = useMemo(() => hashOf(player.id), [player.id]);
  const skin = SKIN_TONES[h % SKIN_TONES.length];
  // h는 부호 없는 32비트라 >> 를 쓰면 음수가 되어 인덱스가 어긋난다
  const hair = HAIR_TONES[(h >>> 3) % HAIR_TONES.length];
  const mat = useBodyMaterials(uniform, skin, hair, player.gear.gloveColor, player.gear.batColor);
  const numberMat = useNumberMaterial(player.number, uniform.secondary, uniform.accent);
  const head = headwear ?? defaultHeadwear(pose);

  const j = useRef<Joints>({
    root: null,
    hip: null,
    torso: null,
    head: null,
    legL: { hip: null, knee: null, ankle: null },
    legR: { hip: null, knee: null, ankle: null },
    armL: { shoulder: null, elbow: null },
    armR: { shoulder: null, elbow: null },
    bat: null,
    glove: null,
  });

  /**
   * ref 콜백은 한 번만 만든다. 인라인 화살표로 넘기면 리렌더마다 React가
   * 콜백을 다시 호출해(null -> 노드) 프레임 루프가 써 둔 값을 되돌린다.
   */
  const setRef = useMemo(() => {
    const c = j.current;
    return {
      root: (g: THREE.Group | null) => void (c.root = g),
      hip: (g: THREE.Group | null) => void (c.hip = g),
      torso: (g: THREE.Group | null) => void (c.torso = g),
      head: (g: THREE.Group | null) => void (c.head = g),
      bat: (g: THREE.Group | null) => void (c.bat = g),
      glove: (g: THREE.Group | null) => void (c.glove = g),
    };
  }, []);

  // 렌더에서 받은 값을 프레임 루프로 넘긴다
  // 스위치히터는 'S'라 좌우가 정해지지 않는다. 미리보기처럼 상대 투수가 없는 화면에서는
  // 우타로 그린다 — 판정이 걸린 화면은 batSide를 반드시 넘긴다.
  const side: Handedness = batSide ?? (player.bats === 'S' ? 'R' : player.bats);
  const input = useRef({ pose, animT, intensity, position, rotationY, scale, player, side });
  input.current = { pose, animT, intensity, position, rotationY, scale, player, side };

  const anim = useRef({
    // 선수마다 위상을 흩어 12명이 한 몸처럼 움직이지 않게 한다
    clock: (h % 1000) / 137,
    kind: pose as PoseKind,
    blend: 1,
    cur: newSnapshot(),
    from: newSnapshot(),
    next: newSnapshot(),
    started: false,
  });

  useFrame((_, delta) => {
    const a = anim.current;
    const inp = input.current;
    const dt = Math.min(delta, 0.05);
    a.clock += dt;

    const t = SELF_DRIVEN[inp.pose] ? a.clock : inp.animT;
    const p = buildPose(inp.pose, t, inp.player, inp.intensity, a.clock, inp.side);
    writeSnapshot(p, a.next);
    if (j.current.bat) j.current.bat.visible = !!p.bat;
    if (j.current.glove) j.current.glove.visible = !!p.glove;

    if (!a.started) {
      copySnapshot(a.next, a.cur);
      a.started = true;
      a.kind = inp.pose;
      a.blend = 1;
    } else if (inp.pose !== a.kind) {
      copySnapshot(a.cur, a.from);
      a.kind = inp.pose;
      a.blend = 0;
    }

    if (a.blend < 1) {
      a.blend = Math.min(1, a.blend + dt / BLEND_SEC);
      mixSnapshot(a.from, a.next, easeInOut(a.blend), a.cur);
    } else {
      copySnapshot(a.next, a.cur);
    }

    apply(j.current, a.cur, inp.position, inp.rotationY, inp.scale);
  });

  /**
   * 체형에 따른 몸통·팔다리 두께 배율.
   *
   * 굵기만 바꾸고 **키와 머리 비율은 그대로 둔다.** 골격 상수(THIGH/SHIN/UPPER_ARM/BODY/
   * HEAD_K)는 포즈·IK와 한 세트로 튜닝돼 있어서, 키를 건드리면 스트라이크존(0.45~1.06m)
   * 정렬과 카메라가 함께 깨진다.
   */
  const girth = player.kind === 'PITCHER' ? 1 : (BODY_BY_ID[player.body ?? 'NORMAL']?.girth ?? 1);

  /**
   * 뼈대 JSX는 장비/유니폼/체형이 바뀔 때만 다시 만든다. 부모가 매 프레임 리렌더해도
   * 같은 엘리먼트를 돌려주면 React가 하위 트리 재조정을 통째로 건너뛴다.
   * (포즈는 어차피 프레임 루프에서 오브젝트에 직접 쓴다)
   */
  return useMemo(
    () => (
    <group ref={setRef.root}>
      <group scale={BODY}>
        {/* 골반 */}
        <group ref={setRef.hip}>
          <Leg refs={j.current.legL} sign={-1} mat={mat} girth={girth} />
          <Leg refs={j.current.legR} sign={1} mat={mat} girth={girth} />
          {/* 엉덩이 볼륨 */}
          <mesh
            position={[0, -0.055, 0]}
            castShadow
            material={mat.pants}
            scale={[girth, 0.9, 0.9 * girth]}
          >
            <sphereGeometry args={[0.163, 14, 10]} />
          </mesh>

          {/* 몸통 */}
          <group position={[0, TORSO_Y, 0]} ref={setRef.torso}>
            <mesh castShadow material={jersey} scale={[girth, 1, 0.86 * girth]}>
              <capsuleGeometry args={[TORSO_R, TORSO_LEN, 6, 20]} />
            </mesh>
            {/* 등번호 */}
            {numberMat && (
              <mesh
                position={[0, 0.035, 0]}
                material={numberMat}
                scale={[girth, 1, 0.86 * girth]}
                renderOrder={1}
              >
                <cylinderGeometry
                  args={[TORSO_R + 0.004, TORSO_R + 0.004, 0.27, 20, 1, true, Math.PI - 0.62, 1.24]}
                />
              </mesh>
            )}
            {/* 앞섶 */}
            <mesh position={[0, 0.0, 0.172 * girth]} material={mat.accent}>
              <boxGeometry args={[0.028, 0.3, 0.012]} />
            </mesh>
            {/* 벨트 */}
            <mesh position={[0, -0.165, 0]} material={mat.dark} scale={[girth, 1, 0.86 * girth]}>
              <cylinderGeometry args={[TORSO_R + 0.002, TORSO_R + 0.002, 0.075, 20]} />
            </mesh>
            {/* 옷깃 */}
            <mesh
              position={[0, 0.185, 0]}
              rotation={[Math.PI / 2, 0, 0]}
              material={mat.accent}
              scale={[girth, 0.86 * girth, 1]}
            >
              <torusGeometry args={[0.1, 0.021, 6, 18]} />
            </mesh>

            <Arm refs={j.current.armL} sign={-1} mat={mat} accessory={player.gear.accessory} girth={girth} />
            <Arm refs={j.current.armR} sign={1} mat={mat} accessory={player.gear.accessory} girth={girth} />

            {/* 장비는 몸통에 붙여 두 손이 같은 지점을 잡게 한다.
                visible은 프레임 루프에서 켜고 끄므로 JSX prop으로 주면 안 된다
                (부모가 매 프레임 리렌더하면 React가 매번 되돌려 놓는다) */}
            <group ref={setRef.bat}>
              <Bat type={player.gear.bat} mat={mat} />
            </group>
            <group ref={setRef.glove}>
              <Glove type={player.gear.glove} mat={mat} />
            </group>

            {/* 목걸이. 몸통 반지름(0.2)에 맞춰 가슴 표면을 감싸고 앞쪽이 처진다. */}
            {player.gear.accessory === 'NECKLACE' && (
              <>
                <mesh
                  position={[0, 0.16, 0.01]}
                  rotation={[Math.PI / 2 + 0.22, 0, 0]}
                  material={mat.accent}
                  scale={[girth, 0.86 * girth, 1]}
                >
                  <torusGeometry args={[0.2, 0.011, 6, 22]} />
                </mesh>
                <mesh position={[0, 0.12, 0.178 * girth]} material={mat.accent}>
                  <sphereGeometry args={[0.025, 8, 6]} />
                </mesh>
              </>
            )}

            {/* 목 */}
            <mesh position={[0, 0.23, 0]} material={mat.skin}>
              <cylinderGeometry args={[0.07, 0.082, 0.12, 10]} />
            </mesh>

            {/* 머리 (SD 비율을 위해 몸 스케일을 상쇄하고 크게 그린다) */}
            <group
              position={[0, HEAD_Y, 0]}
              scale={HEAD_SCALE}
              ref={setRef.head}
            >
              <Head mat={mat} headwear={head} accessory={player.gear.accessory} />
            </group>
          </group>
        </group>
      </group>
    </group>
    ),
    [setRef, jersey, mat, numberMat, head, player.gear, girth, j],
  );
}

/** 스냅샷을 실제 오브젝트에 써 넣는다 */
function apply(
  j: Joints,
  s: Snapshot,
  position: [number, number, number],
  rotationY: number,
  scale: number,
) {
  const k = BODY * scale;
  if (j.root) {
    // root 이동은 모델 로컬 기준이다. rotationY는 root 그룹 자체에 걸리므로
    // 이동량에는 적용되지 않는다 — 여기서 직접 돌려 준다. (이걸 빼면 투수의
    // 스트라이드가 바라보는 방향과 무관하게 항상 월드 +Z로 나가, 마운드에서
    // 홈을 등지고 뒷걸음질치는 것처럼 보인다)
    const cos = Math.cos(rotationY);
    const sin = Math.sin(rotationY);
    j.root.position.set(
      position[0] + (s.root.x * cos + s.root.z * sin) * k,
      position[1] + s.root.y * k,
      position[2] + (-s.root.x * sin + s.root.z * cos) * k,
    );
    j.root.rotation.y = rotationY;
    j.root.scale.setScalar(scale);
  }
  if (j.hip) {
    j.hip.position.y = s.hipY;
    j.hip.quaternion.copy(s.hip);
  }
  if (j.torso) j.torso.quaternion.copy(s.torso);
  if (j.head) j.head.quaternion.copy(s.head);

  const leg = (refs: LegRefs, snap: LimbSnap) => {
    if (refs.hip) refs.hip.quaternion.copy(snap.quat);
    if (refs.knee) refs.knee.rotation.x = snap.knee;
    if (refs.ankle) refs.ankle.rotation.x = snap.ankle;
  };
  leg(j.legL, s.legL);
  leg(j.legR, s.legR);

  const arm = (refs: ArmRefs, snap: ArmSolution) => {
    if (refs.shoulder) refs.shoulder.quaternion.copy(snap.quat);
    if (refs.elbow) refs.elbow.rotation.x = snap.elbow;
  };
  arm(j.armL, s.armL);
  arm(j.armR, s.armR);

  if (j.bat) {
    j.bat.position.copy(s.batPos);
    j.bat.quaternion.copy(s.batQuat);
  }
  if (j.glove) {
    j.glove.position.copy(s.glovePos);
    j.glove.quaternion.copy(s.gloveQuat);
  }
}

/** 허벅지 - 무릎 - 정강이 - 발 */
function Leg({ refs, sign, mat, girth }: { refs: LegRefs; sign: number; mat: Mats; girth: number }) {
  // 길이(THIGH/SHIN)는 그대로 두고 굵기만 바꾼다. 길이를 건드리면 IK와 포즈가 어긋난다.
  const w: [number, number, number] = [girth, 1, girth];
  return (
    <group position={[sign * HIP_X, 0, 0]} ref={(g) => void (refs.hip = g)}>
      <mesh castShadow position={[0, -THIGH / 2 + 0.02, 0]} material={mat.pants} scale={w}>
        <capsuleGeometry args={[0.105, THIGH - 0.2, 5, 12]} />
      </mesh>
      <group position={[0, -THIGH, 0]} ref={(g) => void (refs.knee = g)}>
        {/* 무릎 위까지 오는 니커 팬츠 + 스타킹 */}
        <mesh castShadow position={[0, -0.07, 0]} material={mat.pants} scale={w}>
          <capsuleGeometry args={[0.093, 0.06, 5, 12]} />
        </mesh>
        <mesh castShadow position={[0, -SHIN / 2 - 0.03, 0]} material={mat.sock} scale={w}>
          <capsuleGeometry args={[0.082, SHIN - 0.19, 5, 12]} />
        </mesh>
        <group position={[0, -SHIN - 0.01, 0.03]} ref={(g) => void (refs.ankle = g)}>
          {/* 앞코가 둥근 스파이크 */}
          <mesh castShadow position={[0, 0.02, 0.035]} rotation={[Math.PI / 2, 0, 0]} material={mat.shoe}>
            <capsuleGeometry args={[0.062, 0.1, 4, 10]} />
          </mesh>
          <mesh position={[0, -0.028, 0.035]} material={mat.dark}>
            <boxGeometry args={[0.125, 0.028, 0.215]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** 상완 - 팔꿈치 - 전완 - 손. 액세서리는 양팔에 같이 붙는다. */
function Arm({
  refs,
  sign,
  mat,
  accessory,
  girth,
}: {
  refs: ArmRefs;
  sign: number;
  mat: Mats;
  accessory: AccessoryType;
  girth: number;
}) {
  const w: [number, number, number] = [girth, 1, girth];
  return (
    <group position={[sign * SHOULDER_X, SHOULDER_Y, 0]} ref={(g) => void (refs.shoulder = g)}>
      {/* 어깨 이음새 */}
      <mesh castShadow material={mat.sleeve} scale={girth}>
        <sphereGeometry args={[0.088, 12, 10]} />
      </mesh>
      <mesh castShadow position={[0, -UPPER_ARM / 2, 0]} material={mat.sleeve} scale={w}>
        <capsuleGeometry args={[0.075, UPPER_ARM - 0.15, 5, 12]} />
      </mesh>
      {/* 소매 끝단 */}
      <mesh position={[0, -UPPER_ARM + 0.035, 0]} material={mat.accent} scale={w}>
        <cylinderGeometry args={[0.077, 0.074, 0.04, 12]} />
      </mesh>
      <group position={[0, -UPPER_ARM, 0]} ref={(g) => void (refs.elbow = g)}>
        <mesh castShadow position={[0, -FOREARM / 2, 0]} material={mat.skin}>
          <capsuleGeometry args={[0.062, FOREARM - 0.13, 5, 12]} />
        </mesh>
        {/* 암슬리브: 전완을 살짝 덮는다 */}
        {accessory === 'ARM_SLEEVE' && (
          <mesh position={[0, -FOREARM / 2 + 0.02, 0]} material={mat.dark}>
            <capsuleGeometry args={[0.066, FOREARM - 0.15, 4, 10]} />
          </mesh>
        )}
        {accessory === 'WRISTBAND' && (
          <mesh position={[0, -FOREARM + 0.058, 0]} material={mat.accent}>
            <cylinderGeometry args={[0.067, 0.067, 0.045, 12]} />
          </mesh>
        )}
        <mesh position={[0, -FOREARM, 0]} castShadow material={mat.skin}>
          <sphereGeometry args={[0.075, 12, 10]} />
        </mesh>
      </group>
    </group>
  );
}

/**
 * 머리. SD 캐릭터는 얼굴이 인상을 결정하므로 눈/눈썹/입을 실제 메시로 붙인다.
 * 눈은 빛을 받지 않는 재질이라 야간 경기에서도 표정이 사라지지 않는다.
 */
function Head({
  mat,
  headwear,
  accessory,
}: {
  mat: Mats;
  headwear: Headwear;
  accessory: AccessoryType;
}) {
  const helmet = headwear === 'HELMET';
  // 모자는 정수리만, 헬멧은 눈썹 위까지 덮는다. phi가 클수록 아래까지 내려온다.
  const shellR = helmet ? HEAD_R + 0.017 : HEAD_R + 0.011;
  const shellPhi = helmet ? 1.36 : 1.14;
  const brimY = Math.cos(shellPhi) * shellR + 0.008;
  return (
    <group>
      {/* 두상 */}
      <mesh castShadow scale={[1, 1.05, 0.97]} material={mat.skin}>
        <sphereGeometry args={[HEAD_R, 18, 14]} />
      </mesh>
      {/* 뒷머리. 얼굴·관자놀이(phi = PI/2 ± 70도)는 비운다 — 앞쪽까지 덮으면
          이마에 검은 머리띠를 두른 것처럼 보인다.
          three.js 구면좌표는 phi가 수평각이고 +Z(정면)가 PI/2다. */}
      <mesh position={[0, -0.004, -0.006]} material={mat.hair}>
        <sphereGeometry
          args={[HEAD_R + 0.007, 18, 12, Math.PI / 2 + 1.22, TAU - 2.44, 0.45, 1.2]}
        />
      </mesh>
      {/* 귀 */}
      {[-1, 1].map((s) => (
        <mesh
          key={s}
          position={[s * (HEAD_R - 0.008), -0.016, -0.004]}
          scale={[0.45, 1, 0.72]}
          material={mat.skin}
        >
          <sphereGeometry args={[0.04, 8, 6]} />
        </mesh>
      ))}

      {/* 눈 */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 0.058, -0.012, HEAD_R - 0.03]}>
          <mesh scale={[1, 1.22, 0.5]} material={mat.eyeWhite}>
            <sphereGeometry args={[0.034, 12, 10]} />
          </mesh>
          <mesh position={[s * 0.005, 0, 0.019]} scale={[1, 1.15, 0.45]} material={mat.eyeDark}>
            <sphereGeometry args={[0.021, 10, 8]} />
          </mesh>
        </group>
      ))}
      {/* 눈썹 */}
      {[-1, 1].map((s) => (
        <mesh
          key={s}
          position={[s * 0.058, 0.03, HEAD_R - 0.03]}
          rotation={[0, 0, s * -0.22]}
          material={mat.hair}
        >
          <boxGeometry args={[0.042, 0.009, 0.01]} />
        </mesh>
      ))}
      {/* 입 */}
      <mesh position={[0, -0.078, HEAD_R - 0.028]} material={mat.eyeDark}>
        <boxGeometry args={[0.036, 0.012, 0.012]} />
      </mesh>
      {accessory === 'EYE_BLACK' && (
        <>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.06, -0.05, HEAD_R - 0.03]} material={mat.dark}>
              <boxGeometry args={[0.052, 0.018, 0.01]} />
            </mesh>
          ))}
        </>
      )}

      {/* 모자 / 헬멧 */}
      <mesh position={[0, 0, helmet ? -0.006 : 0]} castShadow material={mat.cap}>
        <sphereGeometry args={[shellR, 18, 14, 0, TAU, 0, shellPhi]} />
      </mesh>
      {/* 챙 */}
      <mesh
        position={[0, brimY - 0.004, 0.056]}
        rotation={[helmet ? 0.2 : 0.26, 0, 0]}
        scale={[1, 1, 0.92]}
        material={mat.cap}
      >
        {/* theta=0이 +Z(앞)라서 앞쪽 반원은 -PI/2에서 시작한다 */}
        <cylinderGeometry args={[0.124, 0.124, 0.019, 20, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      {!helmet && (
        // 버튼
        <mesh position={[0, shellR + 0.003, 0]} material={mat.capBrim}>
          <sphereGeometry args={[0.016, 8, 6]} />
        </mesh>
      )}
      {helmet && (
        // 귀덮개 (투수를 마주보는 쪽 한 짝)
        <mesh
          position={[-(HEAD_R - 0.028), -0.03, 0.006]}
          scale={[0.42, 0.92, 0.8]}
          material={mat.cap}
        >
          <sphereGeometry args={[0.072, 12, 10]} />
        </mesh>
      )}

      {headwear === 'MASK' && (
        <group position={[0, -0.01, HEAD_R - 0.03]}>
          {/* 마스크 테두리 */}
          <mesh rotation={[0, 0, 0]} material={mat.dark}>
            <torusGeometry args={[0.104, 0.013, 6, 20]} />
          </mesh>
          {[-0.05, 0, 0.05].map((y) => (
            <mesh key={y} position={[0, y, 0.022]} material={mat.metal}>
              <boxGeometry args={[0.17, 0.011, 0.011]} />
            </mesh>
          ))}
          <mesh position={[0, 0, 0.022]} material={mat.metal}>
            <boxGeometry args={[0.011, 0.17, 0.011]} />
          </mesh>
        </group>
      )}
    </group>
  );
}

/** 배트 실루엣. len은 전체 길이, handle은 그립 반지름. */
const BAT_SHAPES: Record<BatType, { barrel: number; handle: number; len: number }> = {
  CLASSIC: { barrel: 0.048, handle: 0.017, len: 0.86 },
  FLARE: { barrel: 0.047, handle: 0.025, len: 0.84 },
  TAPERED: { barrel: 0.044, handle: 0.016, len: 0.9 },
  AXE: { barrel: 0.049, handle: 0.018, len: 0.86 },
  THICK: { barrel: 0.058, handle: 0.018, len: 0.82 },
};

/** 배트. 로컬 +Y가 배럴 방향, 원점이 그립. */
function Bat({ type, mat }: { type: BatType; mat: Mats }) {
  const s = BAT_SHAPES[type];
  return (
    <group>
      <mesh position={[0, s.len / 2 - 0.07, 0]} castShadow material={mat.bat}>
        <cylinderGeometry args={[s.barrel, s.handle, s.len, 14]} />
      </mesh>
      {/* 배럴 끝 */}
      <mesh position={[0, s.len - 0.07, 0]} material={mat.bat}>
        <sphereGeometry args={[s.barrel, 12, 8]} />
      </mesh>
      {/* 그립 테이프 */}
      <mesh position={[0, 0.02, 0]} material={mat.dark}>
        <cylinderGeometry args={[s.handle + 0.007, s.handle + 0.006, 0.17, 12]} />
      </mesh>
      {/* 노브 */}
      <mesh position={[0, -0.07, 0]} material={mat.bat}>
        {type === 'AXE' ? (
          <boxGeometry args={[0.055, 0.06, 0.04]} />
        ) : (
          <cylinderGeometry args={[0.03, 0.03, 0.022, 10]} />
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
  INFIELD: { r: 0.15, scale: [1, 1, 1], web: [0.22, 0.15], rim: false },
  OUTFIELD: { r: 0.158, scale: [0.94, 1.18, 0.86], web: [0.21, 0.23], rim: false },
  PITCHER: { r: 0.154, scale: [1.04, 1.02, 0.94], web: [0.25, 0.12], rim: false },
  CATCHER: { r: 0.178, scale: [1.06, 1.02, 0.72], web: null, rim: true },
  FIRSTBASE: { r: 0.154, scale: [0.86, 1.32, 0.8], web: [0.17, 0.19], rim: false },
};

function Glove({ type, mat }: { type: GloveType; mat: Mats }) {
  const s = GLOVE_SHAPES[type];
  return (
    <group>
      <mesh castShadow scale={s.scale} material={mat.glove}>
        <sphereGeometry args={[s.r, 14, 10]} />
      </mesh>
      {s.web && (
        <mesh
          position={[0, s.r * s.scale[1] * 0.5, 0.05]}
          rotation={[0.4, 0, 0]}
          material={mat.glove}
        >
          <boxGeometry args={[s.web[0], s.web[1], 0.045]} />
        </mesh>
      )}
      {s.rim && (
        <mesh rotation={[Math.PI / 2 - 0.35, 0, 0]} material={mat.glove}>
          <torusGeometry args={[s.r * 1.02, 0.03, 6, 18]} />
        </mesh>
      )}
    </group>
  );
}
