'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import { BASE_COORDS, BASE_DISTANCE, FENCE_HEIGHT, MOUND_DISTANCE, fenceDistance } from '@/lib/game/constants';

/**
 * 구장 지오메트리는 전부 코드로 생성한다 (외부 모델/텍스처 없음).
 * 잔디는 셰이더 없이 격자 스트라이프 텍스처를 캔버스로 그려 사용한다.
 */

function useGrassTexture() {
  return useMemo(() => {
    if (typeof document === 'undefined') return null;
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#2f6b34';
    g.fillRect(0, 0, size, size);
    // 잔디 스트라이프
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.045)';
      g.fillRect(0, (i * size) / 8, size, size / 8);
    }
    // 미세한 얼룩
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = `rgba(${20 + Math.random() * 40},${70 + Math.random() * 60},${25 + Math.random() * 35},0.16)`;
      g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(9, 9);
    tex.anisotropy = 4;
    return tex;
  }, []);
}

function useDirtTexture() {
  return useMemo(() => {
    if (typeof document === 'undefined') return null;
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#a9713f';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 3000; i++) {
      const v = Math.random();
      g.fillStyle = `rgba(${120 + v * 80},${70 + v * 50},${35 + v * 30},0.35)`;
      g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    return tex;
  }, []);
}

/**
 * Shape는 XY 평면에 정의되고, 메시를 rotation=[-PI/2,0,0]으로 눕히면
 * shape의 (x, y)가 월드 (x, 0, -y)로 간다. 즉 shape의 +Y가 월드 -Z가 된다.
 * 필드는 +Z 방향(외야)으로 뻗어야 하므로 shape 좌표의 Y를 뒤집어 정의한다.
 */
const fwd = (v: number) => -v;

/** 파울선 안쪽 페어 지역 잔디 (부채꼴) */
function fairShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = -Math.PI / 4 + (Math.PI / 2) * (i / steps);
    const r = fenceDistance(t);
    s.lineTo(Math.sin(t) * r, fwd(Math.cos(t) * r));
  }
  s.lineTo(0, 0);
  return s;
}

/** 내야 흙 (다이아몬드를 감싸는 부채꼴) */
function infieldDirtShape(): THREE.Shape {
  const s = new THREE.Shape();
  const R = 29;
  s.moveTo(0, fwd(-2.4));
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = -Math.PI / 4 + (Math.PI / 2) * (i / steps);
    // 홈에서 반지름 R의 원호. 실제 구장의 내야 흙 형태에 가깝다.
    s.lineTo(Math.sin(t) * R, fwd(Math.cos(t) * R + 6));
  }
  s.lineTo(0, fwd(-2.4));
  return s;
}

export function Stadium() {
  const grass = useGrassTexture();
  const dirt = useDirtTexture();

  const fairGeo = useMemo(() => new THREE.ShapeGeometry(fairShape(), 64), []);
  const dirtGeo = useMemo(() => new THREE.ShapeGeometry(infieldDirtShape(), 48), []);

  // 파울 라인 / 담장 곡선
  const fenceCurve = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const t = -Math.PI / 4 + (Math.PI / 2) * (i / steps);
      const r = fenceDistance(t);
      pts.push(new THREE.Vector3(Math.sin(t) * r, 0, Math.cos(t) * r));
    }
    return pts;
  }, []);

  const fenceGeo = useMemo(() => {
    // 담장을 띠(strip)로 만든다
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let i = 0; i < fenceCurve.length - 1; i++) {
      const a = fenceCurve[i];
      const b = fenceCurve[i + 1];
      positions.push(a.x, 0, a.z, b.x, 0, b.z, a.x, FENCE_HEIGHT, a.z);
      positions.push(b.x, 0, b.z, b.x, FENCE_HEIGHT, b.z, a.x, FENCE_HEIGHT, a.z);
      for (let k = 0; k < 6; k++) uvs.push(0, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    return g;
  }, [fenceCurve]);

  return (
    <group>
      {/* 파울 지역까지 덮는 바닥 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, 40]} receiveShadow>
        <circleGeometry args={[190, 64]} />
        <meshStandardMaterial color="#20502a" roughness={1} />
      </mesh>

      {/* 페어 지역 잔디 */}
      <mesh geometry={fairGeo} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        {grass ? (
          <meshStandardMaterial map={grass} roughness={0.95} />
        ) : (
          <meshStandardMaterial color="#2f6b34" roughness={0.95} />
        )}
      </mesh>

      {/* 내야 흙 */}
      <mesh geometry={dirtGeo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]} receiveShadow>
        {dirt ? (
          <meshStandardMaterial map={dirt} roughness={1} />
        ) : (
          <meshStandardMaterial color="#a9713f" roughness={1} />
        )}
      </mesh>

      {/* 내야 잔디 (다이아몬드 안쪽) */}
      <mesh rotation={[-Math.PI / 2, 0, Math.PI / 4]} position={[0, 0.012, BASE_DISTANCE * Math.SQRT2 * 0.5]}>
        <planeGeometry args={[BASE_DISTANCE - 5.4, BASE_DISTANCE - 5.4]} />
        {grass ? (
          <meshStandardMaterial map={grass} roughness={0.95} />
        ) : (
          <meshStandardMaterial color="#2f6b34" roughness={0.95} />
        )}
      </mesh>

      {/* 마운드 */}
      <mesh position={[0, 0.02, MOUND_DISTANCE]} receiveShadow castShadow>
        <cylinderGeometry args={[2.75, 2.9, 0.26, 32]} />
        {dirt ? (
          <meshStandardMaterial map={dirt} roughness={1} />
        ) : (
          <meshStandardMaterial color="#a9713f" roughness={1} />
        )}
      </mesh>
      {/* 투수판 */}
      <mesh position={[0, 0.16, MOUND_DISTANCE + 0.2]}>
        <boxGeometry args={[0.61, 0.03, 0.15]} />
        <meshStandardMaterial color="#f5f5f4" />
      </mesh>

      {/* 홈플레이트 */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.43, 0.43]} />
        <meshStandardMaterial color="#fafaf9" />
      </mesh>

      {/* 베이스 3개 */}
      {BASE_COORDS.slice(0, 3).map((b, i) => (
        <mesh key={i} position={[b.x, 0.05, b.z]} castShadow>
          <boxGeometry args={[0.38, 0.08, 0.38]} />
          <meshStandardMaterial color="#fafaf9" />
        </mesh>
      ))}

      {/* 타석 박스 */}
      {[-1, 1].map((s) => (
        <lineSegments key={`box${s}`} position={[s * 1.05, 0.02, 0.15]}>
          <edgesGeometry
            args={[new THREE.PlaneGeometry(1.22, 1.83).rotateX(-Math.PI / 2)]}
          />
          <lineBasicMaterial color="#ffffff" opacity={0.85} transparent />
        </lineSegments>
      ))}

      {/* 파울 라인 (홈플레이트에서 좌우 45도로 뻗는다) */}
      {[-1, 1].map((s) => {
        const len = 105;
        return (
          <mesh
            key={`fl${s}`}
            position={[(s * len * Math.SQRT1_2) / 2, 0.02, (len * Math.SQRT1_2) / 2]}
            rotation={[-Math.PI / 2, 0, (s * Math.PI) / 4]}
          >
            <planeGeometry args={[0.12, len]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
        );
      })}

      {/* 담장 */}
      <mesh geometry={fenceGeo} castShadow receiveShadow>
        <meshStandardMaterial color="#14532d" side={THREE.DoubleSide} roughness={0.85} />
      </mesh>
      {/* 담장 상단 노란 라인 */}
      {fenceCurve.map((p, i) =>
        i % 4 === 0 && i < fenceCurve.length - 1 ? (
          <mesh key={`ft${i}`} position={[p.x, FENCE_HEIGHT + 0.06, p.z]}>
            <boxGeometry args={[2.6, 0.12, 0.3]} />
            <meshStandardMaterial color="#facc15" />
          </mesh>
        ) : null,
      )}

      {/* 관중석: 필드를 둘러싸는 링 */}
      <mesh position={[0, 3.2, STAND_CENTER_Z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[124, 172, 72]} />
        <meshStandardMaterial color="#1f2937" side={THREE.DoubleSide} />
      </mesh>
      <Stands />

      {/* 조명탑 */}
      {[
        [-95, 118],
        [95, 118],
        [-118, 30],
        [118, 30],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, 14, 0]} castShadow>
            <cylinderGeometry args={[0.5, 0.8, 28, 8]} />
            <meshStandardMaterial color="#374151" />
          </mesh>
          <mesh position={[0, 29, 0]}>
            <boxGeometry args={[9, 4, 1]} />
            <meshStandardMaterial color="#e5e7eb" emissive="#fef9c3" emissiveIntensity={0.65} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** 관중석 링의 중심 (필드 전체를 감싸도록 외야 쪽으로 밀어둔다) */
const STAND_CENTER_Z = 48;

/** 관중을 점군으로 간단히 표현 */
function Stands() {
  const { positions, colors } = useMemo(() => {
    const pos: number[] = [];
    const col: number[] = [];
    const palette = ['#e11d48', '#2563eb', '#f59e0b', '#f8fafc', '#111827', '#16a34a', '#7c3aed'];
    const rows = 9;
    for (let row = 0; row < rows; row++) {
      const r = 128 + row * 4.6;
      const y = 2.6 + row * 1.5;
      const count = 190 + row * 10;
      for (let i = 0; i < count; i++) {
        const t = Math.random() * Math.PI * 2;
        const x = Math.cos(t) * r;
        const z = Math.sin(t) * r + STAND_CENTER_Z;
        pos.push(x, y, z);
        const c = new THREE.Color(palette[Math.floor(Math.random() * palette.length)]);
        col.push(c.r, c.g, c.b);
      }
    }
    return { positions: new Float32Array(pos), colors: new Float32Array(col) };
  }, []);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [positions, colors]);

  return (
    <points geometry={geo}>
      <pointsMaterial size={1.5} vertexColors sizeAttenuation />
    </points>
  );
}
