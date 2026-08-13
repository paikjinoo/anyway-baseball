'use client';

import * as THREE from 'three';

/**
 * 툰 마감 도구 — 잉크 외곽선과 접지 블롭 그림자.
 *
 * 이 게임의 선수는 외부 모델 없이 기본 도형을 관절에 매단 것이라, 셰이딩만으로는
 * "프리미티브를 쌓은 것"으로 읽힌다. SD 캐릭터가 완성품으로 보이는 건 대부분
 * **윤곽선** 덕이다. 여기서는 인버티드 헐(뒷면 셸)로 그 선을 만든다.
 */

// ---------------------------------------------------------------------------
// 외곽선 (인버티드 헐)
// ---------------------------------------------------------------------------

/**
 * 확장은 **뷰 공간**에서 한다.
 *
 * 클립 공간에서 화면 픽셀 기준으로 밀면 멀리 있는 야수도 같은 굵기가 되어, 점처럼 작아진
 * 외야수가 온통 검은 덩어리로 보인다. 뷰 공간에서 밀면 두께가 원근을 따라 자연히 얇아진다
 * (= 현실의 굵기 1.3cm짜리 테두리를 두른 것과 같다).
 *
 * normalMatrix는 역전치라 오브젝트 스케일(BODY 0.87, 미리보기 확대 등)이 상쇄된다.
 * 즉 어느 화면에서 쓰든 두께가 일정하다.
 */
const OUTLINE_VERT = /* glsl */ `
  uniform float thickness;
  void main() {
    vec3 n = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.xyz += n * thickness;
    gl_Position = projectionMatrix * mv;
  }
`;

const OUTLINE_FRAG = /* glsl */ `
  uniform vec3 color;
  void main() {
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * 잉크 색. 완전한 검정은 야간 경기의 어두운 배경에 묻혀 선이 사라지고,
 * 밝히면 회색 테두리처럼 붕 뜬다. 남색이 살짝 섞인 먹색이 두 배경 모두에서 산다.
 */
const INK = new THREE.Color('#101722');

function outlineMaterial(thickness: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    uniforms: {
      thickness: { value: thickness },
      color: { value: INK },
    },
    side: THREE.BackSide,
    // 셸끼리도 앞뒤가 맞아야 팔이 몸통 앞으로 지날 때 선이 끊기지 않는다
    depthWrite: true,
    fog: false,
  });
}

/**
 * 굵기 3종. 선수 전원이 이 세 개를 공유하므로 머티리얼 수가 늘지 않는다
 * (선수마다 머티리얼을 만들면 드로우콜 상태 변경이 그만큼 늘어난다).
 *
 * - `bold` 머리: SD 비율에서 화면을 지배하는 덩어리라 선이 굵어야 균형이 맞는다
 * - `base` 몸통·팔다리·장비
 * - `fine` 손·신발·모자챙처럼 작은 부품. 굵게 두면 형태가 먹힌다
 */
export const OUTLINE = {
  bold: outlineMaterial(0.017),
  base: outlineMaterial(0.012),
  fine: outlineMaterial(0.008),
} as const;

export type OutlineWeight = keyof typeof OUTLINE;

// ---------------------------------------------------------------------------
// 접지 블롭 그림자
// ---------------------------------------------------------------------------

let blobTex: THREE.CanvasTexture | null = null;

/**
 * 가운데가 짙고 가장자리로 사라지는 원형 알파.
 *
 * 태양 그림자 맵은 구장 전체(140m)를 2048로 덮어 텍셀이 7cm다 — 선수 발밑에서는
 * 뭉개져서 접지가 읽히지 않는다. 발밑에 이 원판 하나를 깔면 "땅에 서 있다"가 바로 보인다.
 */
export function blobShadowTexture(): THREE.CanvasTexture | null {
  if (blobTex) return blobTex;
  if (typeof document === 'undefined') return null;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  // 중심을 완전한 불투명으로 두면 검은 동전처럼 보인다. 가장자리는 길게 흘린다.
  grad.addColorStop(0, 'rgba(0,0,0,0.62)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.78, 'rgba(0,0,0,0.12)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  blobTex = tex;
  return tex;
}

/**
 * 블롭 그림자 재질. **텍스처는 공유하되 재질은 선수마다 하나씩 만든다** —
 * 공중에 뜬 만큼 옅어지는 연출을 하려면 opacity가 개별이어야 하기 때문이다.
 * (선수당 재질 16개를 이미 만들고 있으므로 하나 더는 부담이 아니다.)
 */
export function createBlobShadowMaterial(): THREE.MeshBasicMaterial | null {
  const map = blobShadowTexture();
  if (!map) return null;
  return new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    // 잔디/흙 위에 얹히므로 z-fighting을 막아 둔다
    polygonOffset: true,
    polygonOffsetFactor: -4,
    fog: true,
  });
}

/** 블롭 그림자용 원판. 전원이 공유한다. */
export const BLOB_GEO = new THREE.PlaneGeometry(1, 1);

/** 외곽선 셸을 씬에서 골라낼 때 쓴다 (@see PlayerModel의 거리 컬링) */
export const OUTLINE_SET: ReadonlySet<THREE.Material> = new Set<THREE.Material>([
  OUTLINE.bold,
  OUTLINE.base,
  OUTLINE.fine,
]);
