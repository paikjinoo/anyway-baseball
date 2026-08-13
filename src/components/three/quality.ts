'use client';

import { useAppStore } from '@/lib/store/appStore';
import type { GraphicsQuality } from '@/lib/game/types';

/**
 * 그래픽 품질 -> 기능 플래그.
 *
 * 이 게임은 선수 한 명이 메시 30개 안팎이고 화면에 최대 12명이 선다. 외곽선(인버티드 헐)은
 * 실루엣 파트를 한 벌 더 그리므로 드로우콜이 사실상 두 배가 되고, 파티클·심판·접지 그림자가
 * 거기에 얹힌다. PWA로 폰에서도 도는 게임이라 총량을 한 곳에서 정한다.
 *
 * **읽는 쪽은 프레임 루프에서 `qualityFlags()`를 부른다** (리액트 리렌더를 유발하지 않는다).
 * 캔버스 생성 시점에만 필요한 값(dpr·그림자 맵)은 `useQuality()`로 구독한다.
 */
export interface QualityFlags {
  /** 툰 외곽선 (인버티드 헐) */
  outline: boolean;
  /** 선수 발밑 블롭 그림자 */
  blobShadow: boolean;
  /** directionalLight 그림자 맵 */
  sunShadow: boolean;
  /** 먼지·퍼프 파티클 */
  particles: boolean;
  /** 유니폼·머리카락 관성(스프링) */
  secondaryMotion: boolean;
  /** 심판·대기타석 등 승부와 무관한 인물. 1이면 주심만, 2면 누심까지. */
  officials: 0 | 1 | 2;
  /** 배트 궤적 리본 */
  batTrail: boolean;
  shadowMapSize: number;
  maxDpr: number;
}

export const QUALITY_FLAGS: Record<GraphicsQuality, QualityFlags> = {
  HIGH: {
    outline: true,
    blobShadow: true,
    sunShadow: true,
    particles: true,
    secondaryMotion: true,
    officials: 2,
    batTrail: true,
    shadowMapSize: 2048,
    maxDpr: 1.8,
  },
  MEDIUM: {
    outline: true,
    blobShadow: true,
    // 태양 그림자는 140m 범위를 2048로 덮어 텍셀이 7cm다. 블롭이 접지를 대신하는 이상
    // 여기서 가장 먼저 버릴 것이 이쪽이다.
    sunShadow: false,
    particles: true,
    secondaryMotion: true,
    officials: 1,
    batTrail: true,
    shadowMapSize: 1024,
    maxDpr: 1.5,
  },
  LOW: {
    outline: false,
    blobShadow: true,
    sunShadow: false,
    particles: false,
    secondaryMotion: false,
    officials: 1,
    batTrail: false,
    shadowMapSize: 512,
    maxDpr: 1,
  },
};

/** 프레임 루프용. 리렌더를 일으키지 않는다. */
export function qualityFlags(): QualityFlags {
  return QUALITY_FLAGS[useAppStore.getState().settings.graphicsQuality] ?? QUALITY_FLAGS.HIGH;
}

/** 값이 바뀌면 다시 그려야 하는 곳(캔버스 설정)에서 쓴다. */
export function useQuality(): QualityFlags {
  const q = useAppStore((s) => s.settings.graphicsQuality);
  return QUALITY_FLAGS[q] ?? QUALITY_FLAGS.HIGH;
}

export const QUALITY_LABELS: { id: GraphicsQuality; ko: string; desc: string }[] = [
  { id: 'HIGH', ko: '높음', desc: '외곽선 · 그림자 · 파티클 · 심판까지 전부' },
  { id: 'MEDIUM', ko: '보통', desc: '외곽선은 유지하고 태양 그림자와 누심을 뺍니다' },
  { id: 'LOW', ko: '낮음', desc: '외곽선과 이펙트를 끕니다. 저사양 기기용' },
];
