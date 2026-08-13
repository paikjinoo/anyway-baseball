/**
 * 선수 모델의 공유 지오메트리.
 *
 * JSX 안에 `<mesh><capsuleGeometry args={...} /></mesh>` 로 적으면 **선수마다 같은
 * 캡슐이 새로 만들어진다.** 그라운드에 12명이면 같은 허벅지가 12벌이다. 여기에 한 번만
 * 구워 두고 `geometry={G.thigh}` 로 참조하면 GPU 업로드가 한 번으로 끝나고,
 * 외곽선 셸(toon.ts)이 본체와 **같은 지오메트리를 그대로 재사용**할 수 있다.
 *
 * 모듈 스코프에서 만든다 — BufferGeometry는 document가 필요 없어 SSR에서도 안전하다.
 */

import * as THREE from 'three';
import type { BatType, GloveType } from '@/lib/game/types';
import { FOREARM, HEAD_R, SHIN, TAU, THIGH, TORSO_LEN, TORSO_R, UPPER_ARM } from './rig';

const cap = (r: number, len: number, cs: number, rs: number) =>
  new THREE.CapsuleGeometry(r, len, cs, rs);
const sph = (r: number, w: number, h: number) => new THREE.SphereGeometry(r, w, h);

export const G = {
  // ---- 다리 --------------------------------------------------------------
  thigh: cap(0.105, THIGH - 0.2, 5, 12),
  /** 무릎 위까지 오는 니커 팬츠 */
  knicker: cap(0.093, 0.06, 5, 12),
  /** 무릎 관절 캡. 니커만으로는 굽힘이 클 때(포수 2.2rad) 이음새가 뚫린다. */
  kneeCap: sph(0.091, 10, 8),
  shin: cap(0.082, SHIN - 0.19, 5, 12),
  /** 스타킹 위 스터럽 띠 */
  stirrup: new THREE.CylinderGeometry(0.084, 0.079, 0.075, 12),
  shoeToe: cap(0.062, 0.1, 4, 10),
  shoeSole: new THREE.BoxGeometry(0.125, 0.028, 0.215),

  // ---- 팔 ----------------------------------------------------------------
  shoulderBall: sph(0.088, 12, 10),
  upperArm: cap(0.075, UPPER_ARM - 0.15, 5, 12),
  /** 팔꿈치 관절 캡 */
  elbowCap: sph(0.069, 10, 8),
  sleeveCuff: new THREE.CylinderGeometry(0.077, 0.074, 0.04, 12),
  forearm: cap(0.062, FOREARM - 0.13, 5, 12),
  armSleeve: cap(0.066, FOREARM - 0.15, 4, 10),
  wristband: new THREE.CylinderGeometry(0.067, 0.067, 0.045, 12),
  /** 손바닥. 구를 눌러 벙어리장갑 모양으로 만든다(스케일은 쓰는 쪽에서). */
  palm: sph(0.075, 12, 10),
  /** 엄지 */
  thumb: cap(0.03, 0.05, 4, 8),

  // ---- 골반 / 몸통 --------------------------------------------------------
  hips: sph(0.163, 14, 10),
  /** 고관절 캡. 다리를 크게 들면(레그킥·슬라이딩) 허벅지 윗면이 엉덩이 밖으로 나온다. */
  hipCap: sph(0.1, 10, 8),
  torso: cap(TORSO_R, TORSO_LEN, 6, 20),
  /** 등번호 패널: 몸통 뒤를 감싸는 원통 조각 */
  numberPanel: new THREE.CylinderGeometry(
    TORSO_R + 0.004,
    TORSO_R + 0.004,
    0.27,
    20,
    1,
    true,
    Math.PI - 0.62,
    1.24,
  ),
  placket: new THREE.BoxGeometry(0.028, 0.3, 0.012),
  belt: new THREE.CylinderGeometry(TORSO_R + 0.002, TORSO_R + 0.002, 0.075, 20),
  collar: new THREE.TorusGeometry(0.1, 0.021, 6, 18),
  /** 어깨 요크(앞뒤를 가로지르는 색 띠) */
  yoke: new THREE.CylinderGeometry(TORSO_R + 0.003, TORSO_R + 0.003, 0.05, 20, 1, true),
  necklace: new THREE.TorusGeometry(0.2, 0.011, 6, 22),
  pendant: sph(0.025, 8, 6),
  neck: new THREE.CylinderGeometry(0.07, 0.082, 0.12, 10),

  // ---- 머리 --------------------------------------------------------------
  skull: sph(HEAD_R, 18, 14),
  ear: sph(0.04, 8, 6),
  eyeWhite: sph(0.034, 12, 10),
  pupil: sph(0.021, 10, 8),
  brow: new THREE.BoxGeometry(0.055, 0.019, 0.014),
  /** 입. 벌림을 scale로 표현하려면 구여야 한다(박스는 늘리면 각진다). */
  mouth: sph(0.026, 10, 8),
  eyeBlack: new THREE.BoxGeometry(0.052, 0.018, 0.01),
  brim: new THREE.CylinderGeometry(0.124, 0.124, 0.019, 20, 1, false, -Math.PI / 2, Math.PI),
  capButton: sph(0.016, 8, 6),
  earFlap: sph(0.072, 12, 10),
  maskRim: new THREE.TorusGeometry(0.104, 0.013, 6, 20),
  maskBarH: new THREE.BoxGeometry(0.17, 0.011, 0.011),
  maskBarV: new THREE.BoxGeometry(0.011, 0.17, 0.011),
} as const;

// ---------------------------------------------------------------------------
// 머리 장비 셸 (모자 / 헬멧)
// ---------------------------------------------------------------------------

/**
 * 모자는 정수리만, 헬멧은 눈썹 위까지 덮는다. phi가 클수록 아래까지 내려온다.
 *
 * **두상과 같은 타원으로 눌러야 한다.** 두상은 scale [1, 1.05, 0.97]인데 셸을 정구로
 * 두면 옆머리에서 1cm씩 떠서, 아래에서 올려다보는 각도(타자 시점이 딱 그렇다)에 챙 밑으로
 * 빈틈이 보이고 그 안의 정수리가 밝은 띠처럼 드러난다. 남는 틈은 아래 밴드가 가린다.
 */
const shellDef = (phi: number, sx: number, sy: number, sz: number, band: number) => {
  const geo = new THREE.SphereGeometry(HEAD_R, 18, 14, 0, TAU, 0, phi);
  return {
    phi,
    scale: [sx, sy, sz] as [number, number, number],
    geo,
    /** 셸 아래 테두리(모자 밴드). 벌어진 틈을 막고 실루엣에 선을 하나 더한다. */
    band: new THREE.TorusGeometry(HEAD_R * Math.sin(phi) * sx, band, 6, 20),
    bandY: HEAD_R * Math.cos(phi) * sy,
    /** 밴드를 두상 타원에 맞춰 눌러 준다 */
    bandSquash: sz / sx,
    /** 챙이 붙는 높이 */
    brimY: HEAD_R * Math.cos(phi) * sy + 0.008,
  };
};

export const SHELL = {
  CAP: shellDef(1.16, 1.045, 1.085, 1.02, 0.009),
  HELMET: shellDef(1.4, 1.085, 1.12, 1.06, 0.012),
} as const;

// ---------------------------------------------------------------------------
// 헤어스타일
//
// 얼굴·관자놀이는 비운다 — 앞쪽까지 덮으면 이마에 검은 머리띠를 두른 것처럼 보인다.
// three.js 구면좌표는 phi가 수평각이고 +Z(정면)가 PI/2다.
// ---------------------------------------------------------------------------

export type HairStyle = 'SHORT' | 'BUZZ' | 'SPIKY' | 'LONG' | 'PONYTAIL';

export const HAIR_STYLES: HairStyle[] = ['SHORT', 'BUZZ', 'SPIKY', 'LONG', 'PONYTAIL'];

/** 뒷머리 셸. 스타일마다 두께와 내려오는 깊이가 다르다. */
const hairShell = (grow: number, thetaLen: number) =>
  new THREE.SphereGeometry(
    HEAD_R + grow,
    18,
    12,
    Math.PI / 2 + 1.22,
    TAU - 2.44,
    0.45,
    thetaLen,
  );

export const HAIR_GEO = {
  SHORT: hairShell(0.007, 1.2),
  BUZZ: hairShell(0.003, 1.05),
  SPIKY: hairShell(0.008, 1.1),
  LONG: hairShell(0.011, 1.62),
  PONYTAIL: hairShell(0.008, 1.3),
} as const;

/** 스파이키의 뿔 한 개 */
export const HAIR_SPIKE = new THREE.ConeGeometry(0.032, 0.075, 6);
/** 포니테일 묶음 */
export const HAIR_TAIL = cap(0.038, 0.11, 4, 10);
/** 짧은 수염 (턱을 감싸는 얕은 셸) */
export const BEARD_GEO = new THREE.SphereGeometry(
  HEAD_R + 0.005,
  16,
  10,
  Math.PI / 2 - 0.85,
  1.7,
  1.15,
  0.5,
);

// ---------------------------------------------------------------------------
// 배트 / 글러브 (종류별로 한 벌씩)
// ---------------------------------------------------------------------------

/** 배트 실루엣. len은 전체 길이, handle은 그립 반지름. */
export const BAT_SHAPES: Record<BatType, { barrel: number; handle: number; len: number }> = {
  CLASSIC: { barrel: 0.048, handle: 0.017, len: 0.86 },
  FLARE: { barrel: 0.047, handle: 0.025, len: 0.84 },
  TAPERED: { barrel: 0.044, handle: 0.016, len: 0.9 },
  AXE: { barrel: 0.049, handle: 0.018, len: 0.86 },
  THICK: { barrel: 0.058, handle: 0.018, len: 0.82 },
};

export interface BatGeo {
  shaft: THREE.BufferGeometry;
  tip: THREE.BufferGeometry;
  tape: THREE.BufferGeometry;
  knob: THREE.BufferGeometry;
  shape: (typeof BAT_SHAPES)[BatType];
}

function makeBat(type: BatType): BatGeo {
  const s = BAT_SHAPES[type];
  return {
    shaft: new THREE.CylinderGeometry(s.barrel, s.handle, s.len, 14),
    tip: sph(s.barrel, 12, 8),
    tape: new THREE.CylinderGeometry(s.handle + 0.007, s.handle + 0.006, 0.17, 12),
    knob:
      type === 'AXE'
        ? new THREE.BoxGeometry(0.055, 0.06, 0.04)
        : new THREE.CylinderGeometry(0.03, 0.03, 0.022, 10),
    shape: s,
  };
}

export const BAT_GEO: Record<BatType, BatGeo> = {
  CLASSIC: makeBat('CLASSIC'),
  FLARE: makeBat('FLARE'),
  TAPERED: makeBat('TAPERED'),
  AXE: makeBat('AXE'),
  THICK: makeBat('THICK'),
};

/**
 * 글러브 실루엣. scale은 포켓(구) 비율, web은 [폭, 길이].
 * 포수 미트는 웹 대신 테두리(rim)로 둥근 실루엣을 만든다.
 */
export const GLOVE_SHAPES: Record<
  GloveType,
  { r: number; scale: [number, number, number]; web: [number, number] | null; rim: boolean }
> = {
  INFIELD: { r: 0.15, scale: [1, 1, 1], web: [0.22, 0.15], rim: false },
  OUTFIELD: { r: 0.158, scale: [0.94, 1.18, 0.86], web: [0.21, 0.23], rim: false },
  PITCHER: { r: 0.154, scale: [1.04, 1.02, 0.94], web: [0.25, 0.12], rim: false },
  CATCHER: { r: 0.178, scale: [1.06, 1.02, 0.72], web: null, rim: true },
  FIRSTBASE: { r: 0.154, scale: [0.86, 1.32, 0.8], web: [0.17, 0.19], rim: false },
};

export interface GloveGeo {
  pocket: THREE.BufferGeometry;
  web: THREE.BufferGeometry | null;
  rim: THREE.BufferGeometry | null;
  shape: (typeof GLOVE_SHAPES)[GloveType];
}

function makeGlove(type: GloveType): GloveGeo {
  const s = GLOVE_SHAPES[type];
  return {
    pocket: sph(s.r, 14, 10),
    web: s.web ? new THREE.BoxGeometry(s.web[0], s.web[1], 0.045) : null,
    rim: s.rim ? new THREE.TorusGeometry(s.r * 1.02, 0.03, 6, 18) : null,
    shape: s,
  };
}

export const GLOVE_GEO: Record<GloveType, GloveGeo> = {
  INFIELD: makeGlove('INFIELD'),
  OUTFIELD: makeGlove('OUTFIELD'),
  PITCHER: makeGlove('PITCHER'),
  CATCHER: makeGlove('CATCHER'),
  FIRSTBASE: makeGlove('FIRSTBASE'),
};
