'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GRAVITY } from '@/lib/game/constants';
import { qualityFlags } from './quality';

/**
 * 흙먼지·잔디 파편 파티클.
 *
 * 슬라이딩과 타구 낙하 같은 "충격"이 아무 흔적도 남기지 않으면 몸과 지면이 서로
 * 모르는 두 레이어처럼 보인다. 먼지 한 줌이면 그 둘이 붙는다.
 *
 * **풀 하나를 씬 전체가 공유한다.** 이벤트마다 Points를 만들면 드로우콜과 GC가 같이 는다.
 * 스폰은 모듈 함수(`puff`)로 열어 두어 어디서든 부를 수 있게 한다 — 발생 지점이
 * GameScene(타구 착지), PlayerModel(발), playback(포구)로 흩어져 있기 때문이다.
 */

const MAX = 260;

interface Pool {
  pos: Float32Array;
  vel: Float32Array;
  col: Float32Array;
  /** 남은 수명(초). 0이면 죽은 슬롯 */
  life: Float32Array;
  /** 태어날 때의 수명 (알파 계산용) */
  born: Float32Array;
  size: Float32Array;
  next: number;
}

let pool: Pool | null = null;
/** 파티클 시스템이 씬에 올라와 있는가. 없으면 스폰 요청을 조용히 버린다. */
let live = false;

function ensurePool(): Pool {
  if (!pool) {
    pool = {
      pos: new Float32Array(MAX * 3),
      vel: new Float32Array(MAX * 3),
      col: new Float32Array(MAX * 3),
      life: new Float32Array(MAX),
      born: new Float32Array(MAX),
      size: new Float32Array(MAX),
      next: 0,
    };
  }
  return pool;
}

export type PuffKind = 'DIRT' | 'GRASS' | 'SPARK';

const TINT: Record<PuffKind, [number, number, number]> = {
  // 내야 흙 / 잔디 파편 / 배트 임팩트
  DIRT: [0.72, 0.52, 0.32],
  GRASS: [0.34, 0.55, 0.26],
  SPARK: [1, 0.95, 0.7],
};

/**
 * 지정한 지점에서 파티클을 터뜨린다.
 *
 * @param dir 퍼지는 방향의 중심 (없으면 위로 반구)
 * @param power 초기 속도 배율
 */
export function puff(
  kind: PuffKind,
  x: number,
  y: number,
  z: number,
  count: number,
  power = 1,
  dir?: { x: number; z: number },
) {
  if (!live || !qualityFlags().particles) return;
  const p = ensurePool();
  const [cr, cg, cb] = TINT[kind];
  for (let i = 0; i < count; i++) {
    const k = p.next;
    p.next = (p.next + 1) % MAX;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random();
    // dir이 있으면 그 방향으로 쏠린 부채꼴, 없으면 고르게 퍼지는 반구
    const bx = Math.cos(a) * r + (dir ? dir.x * 1.4 : 0);
    const bz = Math.sin(a) * r + (dir ? dir.z * 1.4 : 0);
    const up = 0.5 + Math.random() * 1.3;
    const s = power * (1.6 + Math.random() * 1.8);
    p.pos[k * 3] = x + bx * 0.12;
    p.pos[k * 3 + 1] = y + Math.random() * 0.08;
    p.pos[k * 3 + 2] = z + bz * 0.12;
    p.vel[k * 3] = bx * s;
    p.vel[k * 3 + 1] = up * s * 0.7;
    p.vel[k * 3 + 2] = bz * s;
    // 알갱이마다 밝기를 흩어야 한 덩어리로 보이지 않는다
    const v = 0.75 + Math.random() * 0.5;
    p.col[k * 3] = cr * v;
    p.col[k * 3 + 1] = cg * v;
    p.col[k * 3 + 2] = cb * v;
    const lifetime = kind === 'SPARK' ? 0.28 : 0.55 + Math.random() * 0.5;
    p.life[k] = lifetime;
    p.born[k] = lifetime;
    p.size[k] = (kind === 'SPARK' ? 0.06 : 0.13) * (0.6 + Math.random() * 0.9);
  }
}

/** 지면 마찰. 흙먼지는 금방 힘을 잃는다. */
const DRAG = 2.6;

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // 거리에 따라 작아지도록 (sizeAttenuation)
    gl_PointSize = aSize * 320.0 / max(0.001, -mv.z);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // 사각형 점을 둥글게 깎는다
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    gl_FragColor = vec4(vColor, vAlpha * (1.0 - r * 2.4));
  }
`;

export function Particles() {
  const p = useMemo(ensurePool, []);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(p.col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(p.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(MAX), 1));
    // 파티클이 화면 밖으로 나가도 통째로 컬링되지 않게 한다
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 40), 400);
    return g;
  }, [p]);

  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        vertexColors: true,
      }),
    [],
  );

  const ref = useRef<THREE.Points>(null);
  live = true;

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const alpha = geo.attributes.aAlpha as THREE.BufferAttribute;
    let any = false;
    for (let i = 0; i < MAX; i++) {
      if (p.life[i] <= 0) {
        if (alpha.array[i] !== 0) (alpha.array as Float32Array)[i] = 0;
        continue;
      }
      any = true;
      p.life[i] -= dt;
      const j = i * 3;
      p.vel[j + 1] -= GRAVITY * dt * 0.35; // 먼지는 가벼워 천천히 가라앉는다
      const damp = 1 - Math.min(0.9, DRAG * dt);
      p.vel[j] *= damp;
      p.vel[j + 2] *= damp;
      p.pos[j] += p.vel[j] * dt;
      p.pos[j + 1] += p.vel[j + 1] * dt;
      p.pos[j + 2] += p.vel[j + 2] * dt;
      if (p.pos[j + 1] < 0.01) {
        p.pos[j + 1] = 0.01;
        p.vel[j + 1] = 0;
      }
      (alpha.array as Float32Array)[i] = Math.max(0, p.life[i] / p.born[i]) ** 0.7;
    }
    if (ref.current) ref.current.visible = any;
    if (any) {
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      alpha.needsUpdate = true;
    }
  });

  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}
