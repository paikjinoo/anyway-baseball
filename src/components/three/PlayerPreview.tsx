'use client';

import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PlayerModel, type Headwear, type PoseKind, type UniformSpec } from './PlayerModel';
import type { GloveType, Player } from '@/lib/game/types';

export type PreviewMode = 'BAT' | 'PITCH' | 'FIELD';

export const PREVIEW_MODES: { id: PreviewMode; ko: string }[] = [
  { id: 'BAT', ko: '타격' },
  { id: 'PITCH', ko: '피칭' },
  { id: 'FIELD', ko: '수비' },
];

// 모션 길이 (ms). 경기 화면의 재생 속도와 맞춘다.
const SWING_MS = 340;
const DELIVERY_MS = 930;

interface Motion {
  pose: PoseKind;
  t: number;
}

/** 대기 -> 로드 -> 스윙 -> 팔로스루 유지 */
function batMotion(ms: number): Motion {
  const k = ms % 2400;
  if (k < 520) return { pose: 'BATTING', t: 0 };
  if (k < 1120) return { pose: 'BATTING', t: (k - 520) / 600 };
  if (k < 1120 + SWING_MS) return { pose: 'BATTING_SWING', t: (k - 1120) / SWING_MS };
  return { pose: 'BATTING_SWING', t: 1 };
}

/** 셋포지션 -> 와인드업 -> 릴리스 -> 팔로스루 유지 */
function pitchMotion(ms: number): Motion {
  const k = ms % 2600;
  if (k < 700) return { pose: 'PITCHING_SET', t: (Math.sin((k / 700) * Math.PI * 2) + 1) / 2 };
  if (k < 700 + DELIVERY_MS) return { pose: 'PITCHING_RELEASE', t: (k - 700) / DELIVERY_MS };
  return { pose: 'PITCHING_RELEASE', t: 1 };
}

/** 포수 미트를 고르면 크라우칭, 그 외에는 수비 준비 자세 */
function fieldMotion(ms: number, glove: GloveType): Motion {
  if (glove === 'CATCHER') return { pose: 'CATCHING', t: 0 };
  return { pose: 'FIELDING', t: (ms % 1900) / 1900 };
}

/**
 * 모드별 기본 각도. 배트를 든 손 / 던지는 팔이 카메라 쪽으로 오도록 잡는다.
 * (좌타·좌투는 포즈가 좌우 반전되므로 각도도 반전)
 */
function baseYaw(player: Player, mode: PreviewMode): number {
  if (mode === 'BAT') {
    // 배트를 세워 든 뒤쪽 어깨(우타자 기준 로컬 -X)가 보이도록 3/4 각도에서 본다
    const s = player.bats === 'L' ? -1 : 1;
    return -s * (Math.PI - 0.78);
  }
  const s = player.throws === 'L' ? -1 : 1;
  if (mode === 'PITCH') return s * (Math.PI / 2 - 0.55);
  return s * -0.4;
}

/**
 * 동작 중 이동하는 만큼 미리 밀어 화면 가운데에 유지한다.
 * 투구 스트라이드는 모델 로컬 +Z로 약 0.8m 나아가므로, 보는 각도만큼 돌려서
 * 그 절반을 반대로 당겨 둔다.
 */
function baseOffset(player: Player, mode: PreviewMode): [number, number, number] {
  if (mode !== 'PITCH') return [0, 0, 0];
  const y = baseYaw(player, mode);
  return [-Math.sin(y) * 0.4, 0, -Math.cos(y) * 0.4];
}

/** 미리보기 모드에 맞는 머리 장비 */
function headwearFor(mode: PreviewMode, glove: GloveType): Headwear {
  if (mode === 'BAT') return 'HELMET';
  if (mode === 'FIELD' && glove === 'CATCHER') return 'MASK';
  return 'CAP';
}

const CAMERA: Record<PreviewMode, { pos: [number, number, number]; look: number }> = {
  BAT: { pos: [0, 1.26, 4.0], look: 0.8 },
  PITCH: { pos: [0, 1.3, 4.6], look: 0.82 },
  FIELD: { pos: [0, 1.02, 3.3], look: 0.66 },
};

function Rig({ mode }: { mode: PreviewMode }) {
  const { camera } = useThree();
  useEffect(() => {
    const c = CAMERA[mode];
    camera.position.set(...c.pos);
    camera.lookAt(0, c.look, 0);
  }, [camera, mode]);
  return null;
}

/** 매 프레임 다시 그리며 모션을 재생한다. 회전은 ref로 받아 렌더 중에 읽는다. */
function Actor({
  player,
  uniform,
  mode,
  yaw,
  autoSpin,
}: {
  player: Player;
  uniform: UniformSpec;
  mode: PreviewMode;
  yaw: { current: number };
  autoSpin: boolean;
}) {
  const [, setFrame] = useState(0);
  const startedAt = useRef(performance.now());

  // 모드가 바뀌면 모션을 처음부터 재생한다
  useEffect(() => {
    startedAt.current = performance.now();
  }, [mode]);

  useFrame((_, delta) => {
    if (autoSpin) yaw.current += delta * 0.45;
    setFrame((f) => (f + 1) % 1000000);
  });

  const ms = performance.now() - startedAt.current;
  const m =
    mode === 'BAT' ? batMotion(ms) : mode === 'PITCH' ? pitchMotion(ms) : fieldMotion(ms, player.gear.glove);

  return (
    <PlayerModel
      player={player}
      uniform={uniform}
      pose={m.pose}
      headwear={headwearFor(mode, player.gear.glove)}
      animT={m.t}
      position={baseOffset(player, mode)}
      rotationY={baseYaw(player, mode) + yaw.current}
    />
  );
}

interface Props {
  player: Player;
  uniform: UniformSpec;
  mode: PreviewMode;
  height?: number;
}

/**
 * 커스터마이징 미리보기. 경기에서 쓰는 것과 같은 PlayerModel을 그대로 돌려
 * 자세·배트·글러브·액세서리가 실제로 어떻게 보이는지 확인한다.
 */
export function PlayerPreview({ player, uniform, mode, height = 340 }: Props) {
  // 캔버스는 브라우저에서만 만든다
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const yaw = useRef(0);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const [autoSpin, setAutoSpin] = useState(false);

  // 모드를 바꾸면 기본 각도로 되돌린다
  useEffect(() => {
    yaw.current = 0;
  }, [mode]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(200,245,90,0.09),transparent_60%),linear-gradient(180deg,#0a1a12,#050d09)]">
      <div
        style={{ height, touchAction: 'pan-y' }}
        className="cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, from: yaw.current };
          setAutoSpin(false);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          yaw.current = drag.current.from + (e.clientX - drag.current.x) * 0.011;
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {ready && (
          <Canvas
            shadows
            dpr={[1, 1.75]}
            camera={{ fov: 32, near: 0.1, far: 60, position: CAMERA[mode].pos }}
            gl={{ antialias: true, alpha: true }}
            onCreated={({ gl }) => {
              gl.toneMapping = THREE.ACESFilmicToneMapping;
              gl.toneMappingExposure = 1.05;
            }}
          >
            <hemisphereLight args={['#d8ecff', '#26361f', 0.66]} />
            <directionalLight
              position={[2.6, 5.4, 3.4]}
              intensity={1.15}
              castShadow
              shadow-mapSize-width={1024}
              shadow-mapSize-height={1024}
              shadow-camera-left={-2.2}
              shadow-camera-right={2.2}
              shadow-camera-top={2.6}
              shadow-camera-bottom={-0.4}
              shadow-camera-far={14}
            />
            <directionalLight position={[-3.4, 2.2, -2.6]} intensity={0.38} color="#bcd8ff" />

            {/* 바닥 */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <circleGeometry args={[2.1, 44]} />
              <meshStandardMaterial color="#16301f" roughness={1} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
              <ringGeometry args={[2.02, 2.1, 44]} />
              <meshBasicMaterial color="#c8f55a" transparent opacity={0.22} />
            </mesh>

            <Actor player={player} uniform={uniform} mode={mode} yaw={yaw} autoSpin={autoSpin} />
            <Rig mode={mode} />
          </Canvas>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-3 pb-2.5">
        <span className="text-[10px] text-slate-500">드래그해서 돌려보기</span>
        <button
          type="button"
          onClick={() => setAutoSpin((v) => !v)}
          className={`pointer-events-auto rounded-md border px-2 py-1 text-[10px] font-bold transition ${
            autoSpin
              ? 'border-lime-400/60 bg-lime-500/20 text-lime-200'
              : 'border-white/10 bg-black/30 text-slate-400 hover:text-slate-200'
          }`}
        >
          ⟳ 자동 회전
        </button>
      </div>
    </div>
  );
}
