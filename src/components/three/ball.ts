'use client';

import * as THREE from 'three';
import { BALL_RADIUS } from '@/lib/game/constants';
import type { PitchTrajectory } from '@/lib/game/types';

/**
 * 공.
 *
 * 경기 내내 눈이 따라가는 유일한 물체인데 실밥도 회전도 없는 흰 구체였다. 그래서
 * (1) 얼마나 빠른지, (2) 어떤 구종인지가 공 자체로는 전혀 읽히지 않았다.
 * 여기서 실밥을 그려 넣고 **구종에 맞는 축으로 실제로 돌린다.**
 */

let tex: THREE.CanvasTexture | null = null;

/**
 * 실밥 텍스처 (equirectangular).
 *
 * 정사영 UV에서 기울어진 대원은 사인파로 보인다. 야구공 실밥은 반 주기씩 어긋난
 * 두 개의 호이므로, 사인파 하나와 그 반전을 그리면 실제 실밥과 같은 인상이 난다.
 * 바느질 자국(짧은 빗금)까지 넣어야 "야구공"으로 읽힌다 — 곡선만으로는 줄무늬 공이다.
 */
function seamTexture(): THREE.CanvasTexture | null {
  if (tex) return tex;
  if (typeof document === 'undefined') return null;
  const w = 256;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return null;

  g.fillStyle = '#f6f5f0';
  g.fillRect(0, 0, w, h);

  const AMP = h * 0.26;
  const curve = (u: number, sign: number) => h / 2 + sign * AMP * Math.sin(u * Math.PI * 2);

  for (const sign of [1, -1]) {
    // 실밥 선
    g.beginPath();
    for (let i = 0; i <= w; i++) {
      const u = i / w;
      const y = curve(u, sign);
      if (i === 0) g.moveTo(i, y);
      else g.lineTo(i, y);
    }
    g.strokeStyle = '#c2352f';
    g.lineWidth = 2.4;
    g.stroke();

    // 바느질 자국. 곡선의 접선에 비스듬히 걸친다.
    g.strokeStyle = '#c2352f';
    g.lineWidth = 2;
    for (let i = 4; i < w; i += 9) {
      const u = i / w;
      const y = curve(u, sign);
      const slope = (sign * AMP * Math.PI * 2 * Math.cos(u * Math.PI * 2)) / w;
      // 접선에 수직인 방향으로 짧게 긋는다
      const nx = -slope / Math.hypot(1, slope);
      const ny = 1 / Math.hypot(1, slope);
      const len = 5;
      g.beginPath();
      g.moveTo(i - nx * len, y - ny * len);
      g.lineTo(i + nx * len, y + ny * len);
      g.stroke();
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  tex = t;
  return t;
}

/** 공 지오메트리. 실밥이 붙으므로 예전보다 조금 더 촘촘해야 한다. */
export const BALL_GEO = new THREE.SphereGeometry(BALL_RADIUS * 1.5, 16, 12);

export function createBallMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: seamTexture() ?? undefined,
    color: '#ffffff',
    emissive: '#ffffff',
    // 야간 경기에서 공이 배경에 묻히면 타이밍을 잡을 수 없다. 살짝 자체발광시킨다.
    emissiveIntensity: 0.16,
    roughness: 0.55,
  });
}

// ---------------------------------------------------------------------------
// 회전
// ---------------------------------------------------------------------------

/**
 * 화면에 그리는 회전 속도 (rad/s).
 *
 * 실제 투구는 2200rpm(230rad/s)인데 60fps에서는 프레임마다 220도씩 돌아 정지해
 * 보이거나 역회전으로 보인다(스트로보). 눈이 회전 방향을 읽을 수 있는 선까지만 돌린다.
 */
const SPIN_RATE = 26;

const _axis = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * 구종의 스핀 축 (월드).
 *
 * 매그너스 가속은 a ∝ ω x v 다. 공이 -Z로 날아가므로 ω x (-ẑ) = (-ωy, ωx, 0) 이고,
 * 이게 곧 화면에서 보이는 변화량 (breakX, breakY)이다. 역산하면 ω = (breakY, -breakX, 0).
 * 즉 **직구는 백스핀, 커브는 탑스핀, 슬라이더는 옆으로 기운 축**이 저절로 나온다.
 */
export function pitchSpinAxis(traj: PitchTrajectory, out = _axis): THREE.Vector3 {
  out.set(traj.breakY, -traj.breakX, 0);
  if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
  return out.normalize();
}

/** 진행 방향에서 유도한 백스핀 축 (타구·송구용) */
export function backspinAxis(vel: THREE.Vector3, out = _axis): THREE.Vector3 {
  out.copy(_up).cross(vel);
  if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
  return out.normalize().negate();
}

/** 속도(m/s)에 따른 회전 속도. 굴러가는 공은 천천히, 타구는 빠르게. */
export function spinRateFor(speed: number): number {
  return Math.min(SPIN_RATE, 3 + speed * 0.55);
}
