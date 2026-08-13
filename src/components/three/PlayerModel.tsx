'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp } from '@/lib/game/rng';
import { BODY_BY_ID } from '@/lib/game/constants';
import {
  BODY,
  FOREARM,
  HEAD_R,
  HEAD_SCALE,
  HEAD_Y,
  HIP_X,
  SHIN,
  SHOULDER_X,
  SHOULDER_Y,
  TAU,
  THIGH,
  TORSO_Y,
  UPPER_ARM,
} from './rig';
import {
  BLEND_SEC,
  SELF_DRIVEN,
  blendTime,
  buildPose,
  copySnapshot,
  easeInOut,
  lerp,
  mixSnapshot,
  newSnapshot,
  writeSnapshot,
  type ArmSolution,
  type LimbSnap,
  type PoseKind,
  type Snapshot,
} from './poses';
import {
  BAT_GEO,
  BEARD_GEO,
  G,
  GLOVE_GEO,
  HAIR_GEO,
  HAIR_SPIKE,
  HAIR_STYLES,
  HAIR_TAIL,
  SHELL,
  type HairStyle,
} from './geometry';
import { BLOB_GEO, OUTLINE, OUTLINE_SET, createBlobShadowMaterial, type OutlineWeight } from './toon';
import { useQuality } from './quality';
import type {
  AccessoryType,
  BatType,
  GloveType,
  Handedness,
  Player,
  UniformType,
} from '@/lib/game/types';

// 포즈 데이터와 IK는 poses.ts로 옮겼다. 다만 쓰는 쪽에서 보면 여전히 이 컴포넌트의
// prop 타입/타이밍이므로 이름은 여기서 그대로 다시 내보낸다.
export { RELEASE_AT, THROW_RELEASE_AT, type PoseKind } from './poses';

export interface UniformSpec {
  primary: string;
  secondary: string;
  accent: string;
  type: UniformType;
}

/** 머리 장비. 지정하지 않으면 포즈에 맞는 기본값을 쓴다. */
export type Headwear = 'CAP' | 'HELMET' | 'MASK';

// 골격 치수는 rig.ts로 옮겼다 (geometry.ts가 같은 값으로 지오메트리를 굽기 때문).

// 툰 셰이딩은 가장 밝은 밴드에서 색을 그대로 쓰므로, 흰색에 가까운 톤을 넣으면
// 이마가 하얗게 날아간다. 한 단계씩 내려 잡는다.
const SKIN_TONES = ['#e8b98f', '#d9a375', '#c1885a', '#96603c', '#f0c9a3'];
const HAIR_TONES = ['#20160f', '#2f2118', '#120d0a', '#4a2f1c', '#1a1a1f'];

function hashOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 선수 id에서 뽑아내는 생김새.
 *
 * 데이터를 늘리지 않고 **id 해시만으로** 정한다 — 저장 포맷이 그대로라 마이그레이션이
 * 없고, 같은 선수는 어느 화면에서나 같은 얼굴이다. 이게 없으면 그라운드에 선 12명이
 * 머리색만 다른 같은 사람으로 보인다.
 */
export interface Looks {
  skin: string;
  hair: string;
  style: HairStyle;
  beard: boolean;
  /** 두상 가로세로 비 (크기는 건드리지 않는다 — 존 정렬과 카메라가 걸려 있다) */
  headWide: number;
  headLong: number;
  /** 눈 크기·간격 */
  eyeSize: number;
  eyeGap: number;
  /** 눈 깜빡임 위상 (초). 12명이 동시에 깜빡이지 않게 흩는다. */
  blinkPhase: number;
}

export function looksOf(id: string): Looks {
  const h = hashOf(id);
  // h는 부호 없는 32비트라 >> 를 쓰면 음수가 되어 인덱스가 어긋난다
  const pick = <T,>(shift: number, arr: readonly T[]): T => arr[(h >>> shift) % arr.length];
  const unit = (shift: number) => (((h >>> shift) % 1000) / 1000) * 2 - 1; // -1~1
  return {
    skin: SKIN_TONES[h % SKIN_TONES.length],
    hair: pick(3, HAIR_TONES),
    style: pick(7, HAIR_STYLES),
    beard: (h >>> 11) % 5 === 0,
    headWide: 1 + unit(13) * 0.06,
    headLong: 1.05 + unit(17) * 0.05,
    eyeSize: 1 + unit(19) * 0.12,
    eyeGap: 0.058 + unit(23) * 0.005,
    blinkPhase: ((h >>> 5) % 1000) / 200,
  };
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
      // 헬멧을 쓴 선수(타자·주자)의 손. 맨손보다 배팅 글러브가 야구 선수로 읽힌다.
      batGlove: toon(uniform.accent),
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
  /**
   * 몸 전체 기울기 [앞으로 눕는 각(rad), 옆으로 기우는 각(rad)].
   * 출발 가속과 베이스 회전에서 쓴다 — 곧게 선 채로 곡선을 따라가면 미끄러지는 것처럼 보인다.
   */
  tilt?: [number, number];
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
  /** 표정. 생략하면 포즈에서 고른다. */
  expression?: Expression;
  showName?: boolean;
  scale?: number;
}


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
  /** 발밑 블롭 그림자 */
  shadow: THREE.Mesh | null;
  face: FaceRefs;
  /**
   * 외곽선 셸. 멀어지면 통째로 끈다.
   *
   * 셸은 실루엣 파트를 한 벌 더 그리는 것이라 드로우콜이 사실상 두 배가 되는데,
   * 선 굵기는 뷰 공간 고정이라 **32m 밖에서는 반 픽셀도 안 된다** — 보이지도 않는 선을
   * 위해 야수 6명 몫의 드로우콜을 내는 셈이다. 뼈대를 다시 만들 때 비우고 다시 모은다.
   */
  outlines: THREE.Mesh[];
  scanned: boolean;
}

/** 이 거리(m)를 넘으면 외곽선을 끈다. 이 지점에서 선 굵기가 0.4px 아래로 떨어진다. */
const OUTLINE_CULL = 32;

interface LegRefs {
  hip: THREE.Group | null;
  knee: THREE.Group | null;
  ankle: THREE.Object3D | null;
}

interface ArmRefs {
  shoulder: THREE.Group | null;
  elbow: THREE.Group | null;
  hand: THREE.Group | null;
}

/** 얼굴 부품. 프레임 루프가 눈 깜빡임·표정·시선을 여기에 써 넣는다. */
interface FaceRefs {
  /** [0] = -X 쪽, [1] = +X 쪽 */
  eye: [THREE.Object3D | null, THREE.Object3D | null];
  pupil: [THREE.Object3D | null, THREE.Object3D | null];
  brow: [THREE.Object3D | null, THREE.Object3D | null];
  mouth: THREE.Object3D | null;
}

function newFaceRefs(): FaceRefs {
  return { eye: [null, null], pupil: [null, null], brow: [null, null], mouth: null };
}

function defaultHeadwear(pose: PoseKind): Headwear {
  if (pose === 'CATCHING' || pose === 'UMPIRE') return 'MASK';
  if (
    pose === 'BATTING' ||
    pose === 'BATTING_SWING' ||
    pose === 'BATTING_BUNT' ||
    pose === 'RUNNING' ||
    pose === 'SLIDING' ||
    pose === 'SLIDING_HEAD' ||
    pose === 'CELEBRATE'
  ) {
    return 'HELMET';
  }
  return 'CAP';
}

// ---------------------------------------------------------------------------
// 표정
//
// SD 캐릭터는 인상의 거의 전부가 얼굴에서 나온다. 눈·눈썹·입은 메시로 있었지만
// 한 번도 움직이지 않아서, 12명이 같은 무표정으로 서 있는 게 "만들다 만" 인상의
// 큰 몫이었다. 여기서 포즈에 맞는 표정과 눈 깜빡임을 얹는다.
// ---------------------------------------------------------------------------

export type Expression = 'NEUTRAL' | 'FOCUS' | 'JOY' | 'DOWN' | 'SHOUT';

interface FaceTarget {
  /** 눈 세로 배율 (1 = 완전히 뜬 상태) */
  open: number;
  /** 눈썹 높이 오프셋 */
  brow: number;
  /** 눈썹 기울기. 음수면 안쪽이 내려와 찡그린 얼굴이 된다. */
  tilt: number;
  /** 입 세로/가로 배율과 높이 */
  mouthOpen: number;
  mouthWide: number;
  mouthY: number;
  /** 눈동자가 돌아다니는 정도 (0이면 한 곳을 노려본다) */
  dart: number;
}

const FACE: Record<Expression, FaceTarget> = {
  NEUTRAL: { open: 1, brow: 0, tilt: -0.22, mouthOpen: 1, mouthWide: 1, mouthY: 0, dart: 1 },
  FOCUS: { open: 0.76, brow: -0.009, tilt: -0.52, mouthOpen: 0.8, mouthWide: 0.82, mouthY: 0, dart: 0.12 },
  JOY: { open: 0.58, brow: 0.012, tilt: 0.16, mouthOpen: 2.4, mouthWide: 1.75, mouthY: -0.004, dart: 0.6 },
  DOWN: { open: 0.84, brow: 0.007, tilt: 0.44, mouthOpen: 0.9, mouthWide: 0.78, mouthY: 0.007, dart: 0.3 },
  SHOUT: { open: 1.06, brow: -0.007, tilt: -0.34, mouthOpen: 4.2, mouthWide: 1.05, mouthY: -0.007, dart: 0.2 },
};

/** 입 기본 배율. G.mouth(반지름 0.026 구)를 예전 박스(0.036 x 0.012)와 같은 크기로 만든다. */
const MOUTH_BASE: [number, number, number] = [0.7, 0.23, 0.25];
const MOUTH_Y = -0.078;
/**
 * 눈썹 높이와 깊이.
 *
 * 두상은 반지름 0.145의 구(스케일 [1, 1.05, 0.97])다. 이 높이에서 표면 z는 약 0.123이라,
 * 눈(z=0.115)과 같은 깊이에 두면 **눈썹이 이마 속에 파묻혀** 삐져나온 끄트머리만 보인다
 * (실제로 그렇게 보였다). 표면 바로 앞에 놓고, 바깥쪽 끝이 뜨지 않도록 접선 방향으로 돌린다.
 */
const BROW_Y = 0.03;
const BROW_Z = 0.132;

function defaultExpression(pose: PoseKind, intensity: number): Expression {
  switch (pose) {
    case 'BATTING':
    case 'BATTING_BUNT':
    case 'PITCHING_SET':
    case 'FIELDING':
    case 'CATCHING':
      return 'FOCUS';
    case 'BATTING_SWING':
    case 'PITCHING_RELEASE':
    case 'THROWING':
    case 'DIVING':
    case 'JUMP':
    case 'SLIDING':
    case 'SLIDING_HEAD':
      return 'SHOUT';
    case 'TAG':
    case 'UMPIRE':
      return 'FOCUS';
    case 'CALL_STRIKE':
      return 'SHOUT';
    case 'CELEBRATE':
    case 'REACT_UP':
      return 'JOY';
    case 'REACT_DOWN':
      return 'DOWN';
    case 'RUNNING':
      return intensity > 0.85 ? 'SHOUT' : 'NEUTRAL';
    default:
      return 'NEUTRAL';
  }
}

/** 눈꺼풀 개폐율 (1 = 뜸). 빠르게 감고 조금 느리게 뜬다. */
const BLINK_PERIOD = 4.2;
const BLINK_DUR = 0.14;

function blinkAmount(clock: number, phase: number): number {
  const k = (clock + phase) % BLINK_PERIOD;
  if (k > BLINK_DUR) return 1;
  return 1 - Math.sin((k / BLINK_DUR) * Math.PI) ** 0.7;
}

// ---------------------------------------------------------------------------
// 파트 (본체 + 외곽선 셸)
// ---------------------------------------------------------------------------

/** 외곽선 굵기 이름. 품질 설정이 낮으면 전부 null이 되어 셸이 아예 생기지 않는다. */
type Ink = OutlineWeight | null;
interface InkSet {
  bold: Ink;
  base: Ink;
  fine: Ink;
}
const INK_ON: InkSet = { bold: 'bold', base: 'base', fine: 'fine' };
const INK_OFF: InkSet = { bold: null, base: null, fine: null };

interface PartProps {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** 외곽선 굵기. null이면 셸을 만들지 않는다. */
  ink?: Ink;
  castShadow?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
  renderOrder?: number;
}

/**
 * 본체 메시와 외곽선 셸을 한 쌍으로 낸다.
 *
 * 셸은 **같은 지오메트리를 뒷면으로 한 번 더** 그린 것이라 위치·스케일이 저절로 일치한다
 * (따로 맞출 값이 없다). 셸에는 castShadow를 주지 않는다 — 그림자 패스가 두 배가 되는데
 * 결과는 본체 그림자와 구별되지 않는다.
 */
function Part({ geometry, material, ink, castShadow = true, ...t }: PartProps) {
  return (
    <>
      <mesh geometry={geometry} material={material} castShadow={castShadow} {...t} />
      {ink && <mesh geometry={geometry} material={OUTLINE[ink]} {...t} />}
    </>
  );
}

/**
 * SD 비율(약 3.4등신) 저폴리 선수 모델.
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
  expression,
  tilt,
}: Props) {
  const jersey = useJerseyMaterial(uniform);
  const looks = useMemo(() => looksOf(player.id), [player.id]);
  const mat = useBodyMaterials(
    uniform,
    looks.skin,
    looks.hair,
    player.gear.gloveColor,
    player.gear.batColor,
  );
  const numberMat = useNumberMaterial(player.number, uniform.secondary, uniform.accent);
  const head = headwear ?? defaultHeadwear(pose);
  const shadowMat = useMemo(() => createBlobShadowMaterial(), []);

  // 품질이 바뀌면 외곽선 셸의 유무가 달라지므로 뼈대를 한 번 다시 만든다.
  // (드문 일이라 useMemo를 무효화해도 무해하다 — 포즈는 다음 프레임에 다시 써진다)
  const q = useQuality();
  const ink = q.outline ? INK_ON : INK_OFF;

  const j = useRef<Joints>({
    root: null,
    hip: null,
    torso: null,
    head: null,
    legL: { hip: null, knee: null, ankle: null },
    legR: { hip: null, knee: null, ankle: null },
    armL: { shoulder: null, elbow: null, hand: null },
    armR: { shoulder: null, elbow: null, hand: null },
    bat: null,
    glove: null,
    shadow: null,
    face: newFaceRefs(),
    outlines: [],
    scanned: false,
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
      shadow: (m: THREE.Mesh | null) => void (c.shadow = m),
    };
  }, []);

  // 렌더에서 받은 값을 프레임 루프로 넘긴다
  // 스위치히터는 'S'라 좌우가 정해지지 않는다. 미리보기처럼 상대 투수가 없는 화면에서는
  // 우타로 그린다 — 판정이 걸린 화면은 batSide를 반드시 넘긴다.
  const side: Handedness = batSide ?? (player.bats === 'S' ? 'R' : player.bats);
  const input = useRef({
    pose,
    animT,
    intensity,
    position,
    rotationY,
    scale,
    player,
    side,
    expression,
    tilt,
  });
  input.current = {
    pose,
    animT,
    intensity,
    position,
    rotationY,
    scale,
    player,
    side,
    expression,
    tilt,
  };

  const anim = useRef({
    // 선수마다 위상을 흩어 12명이 한 몸처럼 움직이지 않게 한다
    clock: looks.blinkPhase * 3.1,
    kind: pose as PoseKind,
    blend: 1,
    blendSec: BLEND_SEC,
    cur: newSnapshot(),
    from: newSnapshot(),
    next: newSnapshot(),
    started: false,
    /** 표정은 목표값을 향해 천천히 따라간다 (홈런에 갑자기 웃는 얼굴로 튀지 않게) */
    face: { ...FACE.NEUTRAL },
    outlineHidden: false,
  });

  useFrame((rs, delta) => {
    const a = anim.current;
    const inp = input.current;
    const dt = Math.min(delta, 0.05);
    a.clock += dt;

    // 외곽선 셸을 모아 두고 거리로 껐다 켠다 (뼈대를 다시 만들면 scanned가 풀린다)
    const jt = j.current;
    if (!jt.scanned && jt.root) {
      jt.outlines.length = 0;
      jt.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && OUTLINE_SET.has(m.material as THREE.Material)) jt.outlines.push(m);
      });
      jt.scanned = true;
    }
    if (jt.outlines.length) {
      const p = inp.position;
      const c = rs.camera.position;
      const far =
        (c.x - p[0]) ** 2 + (c.y - p[1]) ** 2 + (c.z - p[2]) ** 2 > OUTLINE_CULL * OUTLINE_CULL;
      if (far !== a.outlineHidden) {
        a.outlineHidden = far;
        for (const m of jt.outlines) m.visible = !far;
      }
    }

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
      a.blendSec = blendTime(a.kind, inp.pose);
      a.kind = inp.pose;
      a.blend = 0;
    }

    if (a.blend < 1) {
      a.blend = Math.min(1, a.blend + dt / a.blendSec);
      mixSnapshot(a.from, a.next, easeInOut(a.blend), a.cur);
    } else {
      copySnapshot(a.next, a.cur);
    }

    apply(j.current, a.cur, inp.position, inp.rotationY, inp.scale, inp.tilt);
    applyFace(
      j.current.face,
      a.face,
      inp.expression ?? defaultExpression(inp.pose, inp.intensity),
      a.clock,
      looks,
      dt,
    );
  });

  /**
   * 체형에 따른 몸통·팔다리 두께 배율.
   *
   * 굵기만 바꾸고 **키와 머리 비율은 그대로 둔다.** 골격 상수(THIGH/SHIN/UPPER_ARM/BODY/
   * HEAD_K)는 포즈·IK와 한 세트로 튜닝돼 있어서, 키를 건드리면 스트라이크존(0.45~1.06m)
   * 정렬과 카메라가 함께 깨진다.
   */
  const girth = player.kind === 'PITCHER' ? 1 : (BODY_BY_ID[player.body ?? 'NORMAL']?.girth ?? 1);
  /** 헬멧을 쓴 선수(타자·주자)는 배팅 글러브를 낀다 */
  const handMat = head === 'HELMET' ? mat.batGlove : mat.skin;

  /**
   * 뼈대 JSX는 장비/유니폼/체형/품질이 바뀔 때만 다시 만든다. 부모가 매 프레임 리렌더해도
   * 같은 엘리먼트를 돌려주면 React가 하위 트리 재조정을 통째로 건너뛴다.
   * (포즈는 어차피 프레임 루프에서 오브젝트에 직접 쓴다)
   */
  return useMemo(
    () => {
      // 뼈대가 새로 만들어지면 모아 둔 외곽선 셸은 버려진 노드다. 다음 프레임에 다시 모은다.
      j.current.outlines.length = 0;
      j.current.scanned = false;
      return (
    <group ref={setRef.root}>
      {/* 접지 그림자. 루트가 위아래로 움직여도 지면에 붙어 있도록 apply()가 상쇄한다. */}
      {shadowMat && q.blobShadow && (
        <mesh
          ref={setRef.shadow}
          geometry={BLOB_GEO}
          material={shadowMat}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={-1}
        />
      )}

      <group scale={BODY}>
        {/* 골반 */}
        <group ref={setRef.hip}>
          <Leg refs={j.current.legL} sign={-1} mat={mat} girth={girth} ink={ink} />
          <Leg refs={j.current.legR} sign={1} mat={mat} girth={girth} ink={ink} />
          {/* 엉덩이 볼륨 */}
          <Part
            geometry={G.hips}
            material={mat.pants}
            ink={ink.base}
            position={[0, -0.055, 0]}
            scale={[girth, 0.9, 0.9 * girth]}
          />

          {/* 몸통 */}
          <group position={[0, TORSO_Y, 0]} ref={setRef.torso}>
            <Part geometry={G.torso} material={jersey} ink={ink.base} scale={[girth, 1, 0.86 * girth]} />
            {/* 등번호 */}
            {numberMat && (
              <mesh
                position={[0, 0.035, 0]}
                geometry={G.numberPanel}
                material={numberMat}
                scale={[girth, 1, 0.86 * girth]}
                renderOrder={1}
              />
            )}
            {/* 앞섶 */}
            <mesh
              position={[0, 0.0, 0.172 * girth]}
              geometry={G.placket}
              material={mat.accent}
            />
            {/* 어깨 요크 */}
            <mesh
              position={[0, 0.155, 0]}
              geometry={G.yoke}
              material={mat.accent}
              scale={[girth, 1, 0.86 * girth]}
            />
            {/* 벨트 */}
            <mesh
              position={[0, -0.165, 0]}
              geometry={G.belt}
              material={mat.dark}
              scale={[girth, 1, 0.86 * girth]}
            />
            {/* 옷깃 */}
            <mesh
              position={[0, 0.185, 0]}
              rotation={[Math.PI / 2, 0, 0]}
              geometry={G.collar}
              material={mat.accent}
              scale={[girth, 0.86 * girth, 1]}
            />

            <Arm
              refs={j.current.armL}
              sign={-1}
              mat={mat}
              handMat={handMat}
              accessory={player.gear.accessory}
              girth={girth}
              ink={ink}
            />
            <Arm
              refs={j.current.armR}
              sign={1}
              mat={mat}
              handMat={handMat}
              accessory={player.gear.accessory}
              girth={girth}
              ink={ink}
            />

            {/* 장비는 몸통에 붙여 두 손이 같은 지점을 잡게 한다.
                visible은 프레임 루프에서 켜고 끄므로 JSX prop으로 주면 안 된다
                (부모가 매 프레임 리렌더하면 React가 매번 되돌려 놓는다) */}
            <group ref={setRef.bat}>
              <Bat type={player.gear.bat} mat={mat} ink={ink} />
            </group>
            <group ref={setRef.glove}>
              <Glove type={player.gear.glove} mat={mat} ink={ink} />
            </group>

            {/* 목걸이. 몸통 반지름(0.2)에 맞춰 가슴 표면을 감싸고 앞쪽이 처진다. */}
            {player.gear.accessory === 'NECKLACE' && (
              <>
                <mesh
                  position={[0, 0.16, 0.01]}
                  rotation={[Math.PI / 2 + 0.22, 0, 0]}
                  geometry={G.necklace}
                  material={mat.accent}
                  scale={[girth, 0.86 * girth, 1]}
                />
                <mesh position={[0, 0.12, 0.178 * girth]} geometry={G.pendant} material={mat.accent} />
              </>
            )}

            {/* 목 */}
            <mesh position={[0, 0.23, 0]} geometry={G.neck} material={mat.skin} />

            {/* 머리 (SD 비율을 위해 몸 스케일을 상쇄하고 크게 그린다).
                두상 비율은 선수마다 조금씩 다르지만 **크기는 고정이다** — 머리 크기를
                건드리면 타자 시점 카메라의 포수 가림과 존 정렬이 함께 어긋난다. */}
            <group
              position={[0, HEAD_Y, 0]}
              scale={[
                HEAD_SCALE * looks.headWide,
                HEAD_SCALE * looks.headLong,
                HEAD_SCALE * (2 - looks.headWide) * 0.99,
              ]}
              ref={setRef.head}
            >
              <Head
                mat={mat}
                headwear={head}
                accessory={player.gear.accessory}
                looks={looks}
                face={j.current.face}
                ink={ink}
              />
            </group>
          </group>
        </group>
      </group>
    </group>
      );
    },
    [setRef, jersey, mat, numberMat, head, player.gear, girth, j, ink, looks, handMat, shadowMat, q.blobShadow],
  );
}

/** 스냅샷을 실제 오브젝트에 써 넣는다 */
function apply(
  j: Joints,
  s: Snapshot,
  position: [number, number, number],
  rotationY: number,
  scale: number,
  tilt?: [number, number],
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
    // YXZ: 먼저 진행 방향으로 돌린 뒤 그 로컬 축에서 앞으로 눕히고 옆으로 기운다.
    // (XYZ면 기울기가 월드 축에 걸려 방향에 따라 엉뚱한 쪽으로 넘어간다)
    j.root.rotation.set(tilt ? tilt[0] : 0, rotationY, tilt ? tilt[1] : 0, 'YXZ');
    j.root.scale.setScalar(scale);
  }
  if (j.shadow) {
    // 루트가 뛰어오르거나(세리머니) 슬라이딩으로 내려앉아도 그림자는 지면에 남는다.
    // root.position.y 에 이미 s.root.y*k 가 들어갔으므로 로컬에서 그만큼 되돌린다.
    const lift = Math.max(0, s.root.y * BODY);
    j.shadow.position.set(0, 0.03 / Math.max(0.01, scale) - s.root.y * BODY, 0);
    // 떠오를수록 옅고 넓게 — 발이 지면에서 떨어졌다는 게 그림자로 읽힌다
    const spread = 0.9 + lift * 1.6;
    j.shadow.scale.set(spread, spread, 1);
    const m = j.shadow.material as THREE.MeshBasicMaterial;
    m.opacity = clamp(1 - lift * 2.2, 0.28, 1);
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
    if (refs.hand) refs.hand.quaternion.copy(snap.wrist);
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

/**
 * 표정과 눈 깜빡임을 얼굴 부품에 써 넣는다.
 *
 * 목표값(FACE)으로 곧장 튀지 않고 천천히 따라간다 — 홈런이 확정되는 순간 무표정에서
 * 활짝 웃는 얼굴로 한 프레임 만에 바뀌면 인형이 얼굴을 갈아 끼운 것처럼 보인다.
 */
function applyFace(
  f: FaceRefs,
  cur: FaceTarget,
  kind: Expression,
  clock: number,
  looks: Looks,
  dt: number,
) {
  const to = FACE[kind];
  const u = Math.min(1, dt * 7);
  cur.open = lerp(cur.open, to.open, u);
  cur.brow = lerp(cur.brow, to.brow, u);
  cur.tilt = lerp(cur.tilt, to.tilt, u);
  cur.mouthOpen = lerp(cur.mouthOpen, to.mouthOpen, u);
  cur.mouthWide = lerp(cur.mouthWide, to.mouthWide, u);
  cur.mouthY = lerp(cur.mouthY, to.mouthY, u);
  cur.dart = lerp(cur.dart, to.dart, u);

  const blink = blinkAmount(clock, looks.blinkPhase);
  const openY = Math.max(0.04, cur.open * blink);
  // 시선. 눈동자가 눈 안에서 아주 조금 움직이기만 해도 살아 있는 얼굴이 된다.
  const dx = Math.sin(clock * 0.73 + looks.blinkPhase) * Math.sin(clock * 0.21) * 0.009 * cur.dart;
  const dy = Math.sin(clock * 0.47 + looks.blinkPhase * 2) * 0.004 * cur.dart;

  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -1 : 1;
    const eye = f.eye[i];
    if (eye) eye.scale.set(1, openY, 1);
    const pupil = f.pupil[i];
    if (pupil) pupil.position.set(dx, dy, 0.019);
    const brow = f.brow[i];
    if (brow) {
      brow.position.y = BROW_Y + cur.brow;
      brow.rotation.z = s * cur.tilt;
    }
  }
  if (f.mouth) {
    f.mouth.position.y = MOUTH_Y + cur.mouthY;
    f.mouth.scale.set(
      MOUTH_BASE[0] * cur.mouthWide,
      MOUTH_BASE[1] * cur.mouthOpen,
      MOUTH_BASE[2],
    );
  }
}

/** 허벅지 - 무릎 - 정강이 - 발 */
function Leg({
  refs,
  sign,
  mat,
  girth,
  ink,
}: {
  refs: LegRefs;
  sign: number;
  mat: Mats;
  girth: number;
  ink: InkSet;
}) {
  // 길이(THIGH/SHIN)는 그대로 두고 굵기만 바꾼다. 길이를 건드리면 IK와 포즈가 어긋난다.
  const w: [number, number, number] = [girth, 1, girth];
  return (
    <group position={[sign * HIP_X, 0, 0]} ref={(g) => void (refs.hip = g)}>
      {/* 고관절 캡. 다리를 크게 들면(레그킥·슬라이딩) 허벅지 윗면이 엉덩이 밖으로 나온다. */}
      <mesh geometry={G.hipCap} material={mat.pants} scale={w} />
      <Part
        geometry={G.thigh}
        material={mat.pants}
        ink={ink.base}
        position={[0, -THIGH / 2 + 0.02, 0]}
        scale={w}
      />
      <group position={[0, -THIGH, 0]} ref={(g) => void (refs.knee = g)}>
        {/* 무릎 관절 캡. 니커만으로는 포수 크라우칭(2.2rad)에서 이음새가 뚫린다. */}
        <mesh geometry={G.kneeCap} material={mat.pants} scale={w} />
        {/* 무릎 위까지 오는 니커 팬츠 + 스타킹 */}
        <Part
          geometry={G.knicker}
          material={mat.pants}
          ink={ink.base}
          position={[0, -0.07, 0]}
          scale={w}
        />
        <Part
          geometry={G.shin}
          material={mat.sock}
          ink={ink.base}
          position={[0, -SHIN / 2 - 0.03, 0]}
          scale={w}
        />
        {/* 스터럽 띠 */}
        <mesh
          geometry={G.stirrup}
          material={mat.accent}
          position={[0, -SHIN + 0.11, 0]}
          scale={w}
        />
        <group position={[0, -SHIN - 0.01, 0.03]} ref={(g) => void (refs.ankle = g)}>
          {/* 앞코가 둥근 스파이크 */}
          <Part
            geometry={G.shoeToe}
            material={mat.shoe}
            ink={ink.fine}
            position={[0, 0.02, 0.035]}
            rotation={[Math.PI / 2, 0, 0]}
          />
          <mesh geometry={G.shoeSole} material={mat.dark} position={[0, -0.028, 0.035]} />
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
  handMat,
  accessory,
  girth,
  ink,
}: {
  refs: ArmRefs;
  sign: number;
  mat: Mats;
  handMat: THREE.Material;
  accessory: AccessoryType;
  girth: number;
  ink: InkSet;
}) {
  const w: [number, number, number] = [girth, 1, girth];
  return (
    <group position={[sign * SHOULDER_X, SHOULDER_Y, 0]} ref={(g) => void (refs.shoulder = g)}>
      {/* 어깨 이음새 */}
      <Part geometry={G.shoulderBall} material={mat.sleeve} ink={ink.base} scale={girth} />
      <Part
        geometry={G.upperArm}
        material={mat.sleeve}
        ink={ink.base}
        position={[0, -UPPER_ARM / 2, 0]}
        scale={w}
      />
      {/* 소매 끝단 */}
      <mesh
        geometry={G.sleeveCuff}
        material={mat.accent}
        position={[0, -UPPER_ARM + 0.035, 0]}
        scale={w}
      />
      <group position={[0, -UPPER_ARM, 0]} ref={(g) => void (refs.elbow = g)}>
        {/* 팔꿈치 관절 캡. 달리기(-1.7rad)와 팔로스루에서 이음새가 벌어진다. */}
        <mesh geometry={G.elbowCap} material={mat.skin} />
        <Part
          geometry={G.forearm}
          material={mat.skin}
          ink={ink.base}
          position={[0, -FOREARM / 2, 0]}
        />
        {/* 암슬리브: 전완을 살짝 덮는다 */}
        {accessory === 'ARM_SLEEVE' && (
          <mesh geometry={G.armSleeve} material={mat.dark} position={[0, -FOREARM / 2 + 0.02, 0]} />
        )}
        {accessory === 'WRISTBAND' && (
          <mesh geometry={G.wristband} material={mat.accent} position={[0, -FOREARM + 0.058, 0]} />
        )}
        {/* 손. 원점은 반드시 -FOREARM 이다 — IK가 여기를 목표로 푼다. */}
        <group position={[0, -FOREARM, 0]} ref={(g) => void (refs.hand = g)}>
          <Part
            geometry={G.palm}
            material={handMat}
            ink={ink.fine}
            scale={[0.94, 1.06, 0.66]}
          />
          {/* 엄지는 몸 안쪽을 향한다 */}
          <Part
            geometry={G.thumb}
            material={handMat}
            ink={ink.fine}
            castShadow={false}
            position={[-sign * 0.052, 0.012, 0.012]}
            rotation={[0, 0, sign * 1.15]}
          />
        </group>
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
  looks,
  face,
  ink,
}: {
  mat: Mats;
  headwear: Headwear;
  accessory: AccessoryType;
  looks: Looks;
  face: FaceRefs;
  ink: InkSet;
}) {
  const helmet = headwear === 'HELMET';
  const shell = helmet ? SHELL.HELMET : SHELL.CAP;
  const eyeZ = HEAD_R - 0.03;
  return (
    <group>
      {/* 두상 */}
      <Part geometry={G.skull} material={mat.skin} ink={ink.bold} scale={[1, 1.05, 0.97]} />
      <Hair style={looks.style} mat={mat} />
      {looks.beard && <mesh geometry={BEARD_GEO} material={mat.hair} />}
      {/* 귀 */}
      {[-1, 1].map((s) => (
        <mesh
          key={s}
          geometry={G.ear}
          material={mat.skin}
          position={[s * (HEAD_R - 0.008), -0.016, -0.004]}
          scale={[0.45, 1, 0.72]}
        />
      ))}

      {/* 눈. 그룹의 scale.y를 눌러 깜빡인다 (눈꺼풀 메시를 따로 두지 않는다). */}
      {[-1, 1].map((s, i) => (
        <group
          key={s}
          position={[s * looks.eyeGap, -0.012, eyeZ]}
          ref={(g) => void (face.eye[i] = g)}
        >
          <mesh geometry={G.eyeWhite} material={mat.eyeWhite} scale={[looks.eyeSize, 1.22 * looks.eyeSize, 0.5]} />
          <mesh
            geometry={G.pupil}
            material={mat.eyeDark}
            position={[0, 0, 0.019]}
            scale={[looks.eyeSize, 1.15 * looks.eyeSize, 0.45]}
            ref={(m) => void (face.pupil[i] = m)}
          />
        </group>
      ))}
      {/* 눈썹. 표면 접선을 따라 돌려 두면 바깥쪽 끝이 이마에서 뜨지 않는다.
          (오일러 XYZ는 Z를 먼저 적용하므로, 프레임 루프가 쓰는 z 기울기는 눈썹 자기 평면에서 돈다) */}
      {[-1, 1].map((s, i) => (
        <mesh
          key={s}
          geometry={G.brow}
          material={mat.hair}
          position={[s * looks.eyeGap, BROW_Y, BROW_Z]}
          rotation={[0, s * Math.atan(looks.eyeGap / BROW_Z), s * -0.22]}
          ref={(m) => void (face.brow[i] = m)}
        />
      ))}
      {/* 입 */}
      <mesh
        geometry={G.mouth}
        material={mat.eyeDark}
        position={[0, MOUTH_Y, HEAD_R - 0.022]}
        scale={MOUTH_BASE}
        ref={(m) => void (face.mouth = m)}
      />
      {accessory === 'EYE_BLACK' &&
        [-1, 1].map((s) => (
          <mesh
            key={s}
            geometry={G.eyeBlack}
            material={mat.dark}
            position={[s * 0.06, -0.05, eyeZ]}
          />
        ))}

      {/* 모자 / 헬멧 */}
      <Part
        geometry={shell.geo}
        material={mat.cap}
        ink={ink.bold}
        position={[0, 0, helmet ? -0.006 : 0]}
        scale={shell.scale}
      />
      {/* 셸 아래 테두리 (틈 가림 + 모자 밴드) */}
      <mesh
        geometry={shell.band}
        material={mat.cap}
        position={[0, shell.bandY, helmet ? -0.006 : 0]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[1, shell.bandSquash, 1]}
      />
      {/* 챙 */}
      <Part
        geometry={G.brim}
        material={mat.cap}
        ink={ink.fine}
        position={[0, shell.brimY - 0.006, 0.056]}
        rotation={[helmet ? 0.2 : 0.26, 0, 0]}
        scale={[1, 1, 0.92]}
      />
      {!helmet && (
        // 버튼
        <mesh
          geometry={G.capButton}
          material={mat.capBrim}
          position={[0, HEAD_R * shell.scale[1] + 0.003, 0]}
        />
      )}
      {helmet && (
        // 귀덮개 (투수를 마주보는 쪽 한 짝)
        <mesh
          geometry={G.earFlap}
          material={mat.cap}
          position={[-(HEAD_R - 0.028), -0.03, 0.006]}
          scale={[0.42, 0.92, 0.8]}
        />
      )}

      {headwear === 'MASK' && (
        <group position={[0, -0.01, HEAD_R - 0.03]}>
          {/* 마스크 테두리 */}
          <mesh geometry={G.maskRim} material={mat.dark} />
          {[-0.05, 0, 0.05].map((y) => (
            <mesh key={y} geometry={G.maskBarH} material={mat.metal} position={[0, y, 0.022]} />
          ))}
          <mesh geometry={G.maskBarV} material={mat.metal} position={[0, 0, 0.022]} />
        </group>
      )}
    </group>
  );
}

/**
 * 헤어스타일.
 *
 * 모자·헬멧에 정수리가 가리므로 **실루엣 차이는 뒤통수 아래에서 나야 한다.**
 * (정수리에 뿔을 세우면 모자를 뚫고 나온다) 그래서 스파이키는 뒷머리 끝을 뻗치게 하고,
 * 포니테일·장발은 목덜미 아래로 내린다.
 */
function Hair({ style, mat }: { style: HairStyle; mat: Mats }) {
  return (
    <group>
      <mesh geometry={HAIR_GEO[style]} material={mat.hair} position={[0, -0.004, -0.006]} />
      {style === 'SPIKY' &&
        [-2, -1, 0, 1, 2].map((i) => {
          const a = i * 0.42;
          return (
            <mesh
              key={i}
              geometry={HAIR_SPIKE}
              material={mat.hair}
              position={[Math.sin(a) * 0.12, -0.05 + Math.abs(i) * 0.008, -Math.cos(a) * 0.12]}
              rotation={[Math.PI * 0.62, 0, -Math.sin(a) * 0.6]}
            />
          );
        })}
      {style === 'PONYTAIL' && (
        <mesh
          geometry={HAIR_TAIL}
          material={mat.hair}
          position={[0, -0.1, -0.15]}
          rotation={[0.7, 0, 0]}
        />
      )}
      {style === 'LONG' &&
        [-1, 1].map((s) => (
          <mesh
            key={s}
            geometry={HAIR_TAIL}
            material={mat.hair}
            position={[s * 0.125, -0.09, -0.03]}
            scale={[0.7, 0.9, 0.7]}
          />
        ))}
    </group>
  );
}

/** 배트. 로컬 +Y가 배럴 방향, 원점이 그립. */
function Bat({ type, mat, ink }: { type: BatType; mat: Mats; ink: InkSet }) {
  const g = BAT_GEO[type];
  const s = g.shape;
  return (
    <group>
      <Part geometry={g.shaft} material={mat.bat} ink={ink.base} position={[0, s.len / 2 - 0.07, 0]} />
      {/* 배럴 끝 */}
      <Part geometry={g.tip} material={mat.bat} ink={ink.base} castShadow={false} position={[0, s.len - 0.07, 0]} />
      {/* 그립 테이프 */}
      <mesh geometry={g.tape} material={mat.dark} position={[0, 0.02, 0]} />
      {/* 노브 */}
      <mesh geometry={g.knob} material={mat.bat} position={[0, -0.07, 0]} />
    </group>
  );
}

function Glove({ type, mat, ink }: { type: GloveType; mat: Mats; ink: InkSet }) {
  const g = GLOVE_GEO[type];
  const s = g.shape;
  return (
    <group>
      <Part geometry={g.pocket} material={mat.glove} ink={ink.base} scale={s.scale} />
      {g.web && (
        <mesh
          geometry={g.web}
          material={mat.glove}
          position={[0, s.r * s.scale[1] * 0.5, 0.05]}
          rotation={[0.4, 0, 0]}
        />
      )}
      {g.rim && (
        <mesh geometry={g.rim} material={mat.glove} rotation={[Math.PI / 2 - 0.35, 0, 0]} />
      )}
    </group>
  );
}
