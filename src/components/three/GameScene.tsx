'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Stadium } from './Stadium';
import { PlayerModel, RELEASE_AT, type PoseKind, type UniformSpec } from './PlayerModel';
import {
  BALL_RADIUS,
  DEFENSE_SPOTS,
  MOUND_DISTANCE,
  PITCH_DEFS,
  swingDisplayRadius,
  ZONE_BOTTOM,
  ZONE_HALF_HEIGHT,
  ZONE_HALF_WIDTH,
  ZONE_TOP,
  zoneToWorld,
} from '@/lib/game/constants';
/** 홈플레이트 앞뒤 길이 (m). 존을 입체로 그릴 때의 두께. */
const PLATE_DEPTH = 0.43;
import {
  controlSpread,
  pitchPositionAt,
  pitchPositionExtended,
  previewPitch,
} from '@/lib/game/pitching';
import {
  baseFacing,
  baseStation,
  batterRunner,
  sampleBallInPlay,
  sampleFielder,
  sampleRunner,
} from '@/lib/game/playback';
import { clamp } from '@/lib/game/rng';
import {
  cpuBatterTick,
  INNING_BREAK_MS,
  isPlayerBatting,
  swingMotionMs,
  useMatchStore,
  WINDUP_MS,
} from '@/lib/store/matchStore';
import { currentBatter, currentPitcher, defenseTeam, offense } from '@/lib/game/engine';
import type { GameState, Player, Position, Vec3 } from '@/lib/game/types';

export type CameraMode = 'PITCHER' | 'BATTER' | 'FIELD' | 'DRAMATIC';

/** 와인드업 시작부터 팔로스루 끝까지 (ms) */
const DELIVERY_MS = WINDUP_MS / RELEASE_AT;

type Store = ReturnType<typeof useMatchStore.getState>;

// ---------------------------------------------------------------------------

function uniformOf(t: {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  uniformType: UniformSpec['type'];
}): UniformSpec {
  return {
    primary: t.primaryColor,
    secondary: t.secondaryColor,
    accent: t.accentColor,
    type: t.uniformType,
  };
}

/**
 * 조건이 참인 동안에만 매 프레임 리렌더한다.
 * 움직이는 배우(투수/타자/주자)별로 따로 걸어서, 한 명이 움직여도
 * 그라운드 전체가 다시 그려지지 않게 한다.
 */
function useFrameTick(active: (s: Store) => boolean) {
  const [, setFrame] = useState(0);
  useFrame(() => {
    if (active(useMatchStore.getState())) setFrame((f) => (f + 1) % 1000000);
  });
}

/** 결과 연출의 엔진 시각(초). 연출 중이 아니면 null */
function playClock(s: Store): number | null {
  if (s.phase !== 'RESULT' || !s.timeline) return null;
  return ((performance.now() - s.resultStartAt) / 1000) * s.playRate;
}

/** 화면에 그릴 기준 상태. 결과 연출 중에는 투구 직전 상태를 쓴다. */
function sceneState(s: Store): GameState | null {
  return (s.phase === 'RESULT' ? s.prePitchState : null) ?? s.state;
}

// ---------------------------------------------------------------------------
// 수비
// ---------------------------------------------------------------------------

/**
 * 야수 8명 (투수는 Pitcher가 따로 그린다).
 * 결과 연출 중에는 타임라인을 샘플링해 타구를 쫓아가고 베이스를 커버한다.
 * 판정에 쓰인 FieldPlay를 그대로 재생하므로 화면의 포구 순간과 판정이 일치한다.
 */
function Fielders({ state }: { state: GameState }) {
  const def = defenseTeam(state);
  const uni = uniformOf(def);
  const entries = useMemo(() => {
    const out: { pos: Position; player: Player }[] = [];
    for (const [pos, id] of Object.entries(def.defense)) {
      if (pos === 'P' || pos === 'DH') continue;
      const p = id ? def.roster[id] : undefined;
      if (p) out.push({ pos: pos as Position, player: p });
    }
    return out;
  }, [def]);

  useFrameTick((s) => s.phase === 'RESULT' && !!s.timeline?.field);
  const s = useMatchStore.getState();
  const t = playClock(s);
  const field = s.timeline?.field ?? null;

  return (
    <>
      {entries.map(({ pos, player }) => {
        const spot = DEFENSE_SPOTS[pos];
        const motion = t !== null ? sampleFielder(field, pos, t) : null;
        // 정위치에서는 모두 홈플레이트를 바라본다
        const ry = motion ? motion.yaw : Math.atan2(-spot.x, -spot.z);
        const p = motion ? motion.pos : spot;
        return (
          <PlayerModel
            key={pos}
            player={player}
            uniform={uni}
            pose={motion ? motion.pose : pos === 'C' ? 'CATCHING' : 'FIELDING'}
            headwear={pos === 'C' ? 'MASK' : 'CAP'}
            animT={motion ? motion.cycle : 0}
            intensity={motion ? motion.intensity : 1}
            position={[p.x, 0, p.z]}
            rotationY={ry}
          />
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// 주자
// ---------------------------------------------------------------------------

/**
 * 누상의 주자.
 * 결과 연출 중에는 타임라인을 샘플링해 실제로 베이스 사이를 달리고,
 * 그 외에는 베이스에 서 있는다. 두 경우 모두 같은 baseStation()을 쓰므로
 * 연출이 끝나는 순간 위치가 튀지 않는다.
 */
function Runners() {
  const phase = useMatchStore((s) => s.phase);
  const state = useMatchStore((s) => s.state);
  useFrameTick((s) => s.phase === 'RESULT' && !!s.timeline?.runners.length);

  const s = useMatchStore.getState();
  const scene = sceneState(s);
  if (!scene || !state) return null;

  const off = offense(scene);
  const uni = uniformOf(off);
  const t = playClock(s);
  const nodes: React.ReactNode[] = [];
  const drawn = new Set<string>();

  if (t !== null && s.timeline) {
    for (const anim of s.timeline.runners) {
      const p = off.roster[anim.playerId];
      if (!p) continue;
      drawn.add(anim.playerId);
      const smp = sampleRunner(anim, t);
      if (!smp.visible) continue;
      const pose: PoseKind =
        smp.state === 'RUNNING'
          ? 'RUNNING'
          : smp.state === 'SLIDING'
            ? 'SLIDING'
            : smp.state === 'CELEBRATE'
              ? 'CELEBRATE'
              : 'IDLE';
      nodes.push(
        <PlayerModel
          key={`r-${anim.playerId}`}
          player={p}
          uniform={uni}
          pose={pose}
          headwear="HELMET"
          animT={smp.state === 'SLIDING' ? smp.slideT : smp.cycle}
          intensity={smp.intensity}
          position={[smp.pos.x, 0, smp.pos.z]}
          rotationY={smp.yaw}
        />,
      );
    }
  }

  // 타임라인에 없는(움직이지 않은) 주자는 베이스에 세운다
  const bases = phase === 'RESULT' ? scene.bases : state.bases;
  bases.forEach((r, i) => {
    if (!r || drawn.has(r.playerId)) return;
    const p = off.roster[r.playerId];
    if (!p) return;
    const st = baseStation(i);
    nodes.push(
      <PlayerModel
        key={`b-${r.playerId}`}
        player={p}
        uniform={uni}
        pose="IDLE"
        headwear="HELMET"
        position={[st.x, 0, st.z]}
        rotationY={baseFacing(i)}
      />,
    );
  });

  return <>{nodes}</>;
}

// ---------------------------------------------------------------------------
// 타자 / 투수
// ---------------------------------------------------------------------------

function Batter() {
  // 단계가 바뀌면 다시 그려야 하므로 구독만 걸어둔다
  useMatchStore((s) => s.phase);
  useFrameTick((s) => s.phase === 'FLIGHT' || s.phase === 'RESULT');

  const s = useMatchStore.getState();
  const scene = sceneState(s);
  if (!scene) return null;

  // 타구 후에는 주자 레이어가 타자를 이어받는다
  const t = playClock(s);
  if (t !== null && s.timeline) {
    const br = batterRunner(s.timeline);
    if (br && t >= br.legs[0].start) return null;
  }

  const batter = currentBatter(scene);
  const uni = uniformOf(offense(scene));
  const lefty = batter.bats === 'L';
  // 좌타자는 1루 쪽(-X), 우타자는 3루 쪽(+X)
  const x = lefty ? -0.82 : 0.82;

  const now = performance.now();
  const swinging = s.swungAt > 0 && (s.phase === 'FLIGHT' || s.phase === 'RESULT');
  const bunting = swinging && s.swungType === 'BUNT';
  const swingT = swinging ? clamp((now - s.swungAt) / swingMotionMs(s.swungType), 0, 1) : 0;
  // 투수의 딜리버리에 맞춰 타이밍을 잡는 준비 동작
  const load =
    s.phase === 'FLIGHT' ? clamp((now - s.deliveryStartAt) / WINDUP_MS, 0, 1) : 0;

  return (
    <PlayerModel
      player={batter}
      uniform={uni}
      pose={swinging ? (bunting ? 'BATTING_BUNT' : 'BATTING_SWING') : 'BATTING'}
      headwear="HELMET"
      animT={swinging ? swingT : load}
      position={[x, 0, 0.15]}
      rotationY={lefty ? Math.PI / 2 : -Math.PI / 2}
    />
  );
}

/**
 * 마운드 흙더미 위 높이. Stadium의 마운드 실린더(반지름 2.75, 윗면 0.26)와 맞춘다.
 * 가장자리에서 뚝 떨어지면 발이 허공에 뜨므로 바깥쪽 0.6m를 경사로 잇는다.
 */
function moundHeightAt(p: Vec3): number {
  const d = Math.hypot(p.x, p.z - MOUND_DISTANCE);
  return 0.26 * clamp((2.75 - d) / 0.6, 0, 1);
}

/** 투수. 와인드업 -> 릴리스 -> 팔로스루를 시간축으로 재생한다. */
function Pitcher() {
  // 단계가 바뀌면 다시 그려야 하므로 구독만 걸어둔다
  useMatchStore((s) => s.phase);
  useFrameTick(
    (s) =>
      s.phase === 'FLIGHT' ||
      (s.phase === 'RESULT' &&
        (performance.now() < s.deliveryStartAt + DELIVERY_MS || !!s.timeline?.field)),
  );

  const s = useMatchStore.getState();
  const scene = sceneState(s);
  if (!scene) return null;

  const p = currentPitcher(scene);
  const uni = uniformOf(defenseTeam(scene));

  // 투수 앞 땅볼, 1루 커버, 복귀 송구 받기 등 투수가 움직이는 경우
  const t = playClock(s);
  const motion = t !== null ? sampleFielder(s.timeline?.field ?? null, 'P', t) : null;
  if (motion) {
    return (
      <PlayerModel
        player={p}
        uniform={uni}
        pose={motion.pose}
        animT={motion.cycle}
        intensity={motion.intensity}
        // 마운드 위에 있을 때는 흙더미 높이만큼 올려 세운다 (평지면 0)
        position={[motion.pos.x, moundHeightAt(motion.pos), motion.pos.z]}
        rotationY={motion.yaw}
      />
    );
  }

  // 궤적이 없는 결과(피치 클락 위반)는 던진 공이 아니므로 팔로스루도 없다
  const throwing = (s.phase === 'FLIGHT' || s.phase === 'RESULT') && !!s.trajectory;
  const dt = throwing ? clamp((performance.now() - s.deliveryStartAt) / DELIVERY_MS, 0, 1) : 0;

  return (
    <PlayerModel
      player={p}
      uniform={uni}
      pose={throwing ? 'PITCHING_RELEASE' : 'PITCHING_SET'}
      animT={dt}
      position={[0, 0.26, MOUND_DISTANCE]}
      rotationY={Math.PI}
    />
  );
}

// ---------------------------------------------------------------------------
// 공
// ---------------------------------------------------------------------------

/** 이 높이 아래로 내려오면 비행 잔상을 지운다 (땅에서 튀고 구르는 구간) */
const TRAIL_MIN_HEIGHT = 1.1;

function Ball() {
  const ref = useRef<THREE.Mesh>(null);
  const ballMat = useRef<THREE.MeshStandardMaterial>(null);
  const trailRef = useRef<THREE.Points>(null);
  const trailMat = useRef<THREE.PointsMaterial>(null);
  const trailPositions = useRef(new Float32Array(60 * 3));
  const trailCount = useRef(0);

  useFrame(() => {
    const s = useMatchStore.getState();
    const mesh = ref.current;
    if (!mesh) return;

    const pos = ballPosition(s);
    if (!pos) {
      mesh.visible = false;
      if (trailRef.current) trailRef.current.visible = false;
      trailCount.current = 0;
      return;
    }
    mesh.visible = true;
    mesh.position.set(pos.x, pos.y, pos.z);

    // 투구 중에는 공을 무엇보다 앞에 그린다.
    //
    // 타자 시점 카메라와 홈플레이트 사이에 포수가 있고, SD 비율이라 머리가 커서
    // **존 아래쪽이 통째로 포수 머리에 가린다** (홈플레이트 기준 0.6m 아래로는
    // 아예 안 보인다). 하필 그 구간이 낮은 코스를 판단하는 자리라, 공이 존을
    // 지나는 마지막 순간에 사라져 버렸다. 어차피 공은 포수보다 앞에 있으므로
    // 깊이 검사를 끄면 그 구간만 되살아나고 다른 장면은 그대로다.
    // (타구 연출에서는 야수 뒤로 지나가는 공도 있으므로 원래대로 되돌린다)
    if (ballMat.current) ballMat.current.depthTest = s.phase !== 'FLIGHT';
    mesh.renderOrder = s.phase === 'FLIGHT' ? 10 : 0;

    // 궤적 잔상
    const arr = trailPositions.current;
    for (let i = arr.length - 1; i >= 3; i--) arr[i] = arr[i - 3];
    arr[0] = pos.x;
    arr[1] = pos.y;
    arr[2] = pos.z;
    // 지면을 구르는 공에 잔상이 붙으면 잔디에 노란 얼룩처럼 보인다.
    // 낮게 깔리면 꼬리를 접고, 다시 떠오르면(송구 등) 새로 그린다.
    const airborne = pos.y > TRAIL_MIN_HEIGHT;
    trailCount.current = airborne
      ? Math.min(60, trailCount.current + 1)
      : Math.max(2, trailCount.current - 4);
    if (trailMat.current) {
      const target = airborne ? 0.55 : 0;
      trailMat.current.opacity += (target - trailMat.current.opacity) * 0.2;
    }
    if (trailRef.current) {
      trailRef.current.visible = true;
      const g = trailRef.current.geometry as THREE.BufferGeometry;
      (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      g.setDrawRange(0, trailCount.current);
    }
  });

  const trailGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(trailPositions.current, 3));
    return g;
  }, []);

  return (
    <>
      <mesh ref={ref} castShadow>
        <sphereGeometry args={[0.055, 12, 10]} />
        <meshStandardMaterial
          ref={ballMat}
          color="#ffffff"
          emissive="#ffffff"
          emissiveIntensity={0.18}
          roughness={0.5}
        />
      </mesh>
      <points ref={trailRef} geometry={trailGeo}>
        <pointsMaterial
          ref={trailMat}
          size={0.09}
          color="#fef08a"
          transparent
          opacity={0.55}
          sizeAttenuation
        />
      </points>
    </>
  );
}

/**
 * 포수가 공을 잡는 깊이 (m). 홈플레이트를 지난 공은 여기서 멈춘다.
 *
 * 이 제동이 없으면 공이 플레이트를 지나 카메라 코앞(약 2.5m)까지 돌진해
 * 화면을 가득 채우며 아래로 빠져나간다. 하필 그 순간이 존을 지나는 높낮이를
 * 눈으로 재는 시점이라, 낮은 코스가 특히 안 보였다.
 */
const MITT_Z = -1.25;

/** 미트까지만 그리는 투구 궤적 */
function pitchDisplayPos(traj: NonNullable<Store['trajectory']>, t: number): Vec3 {
  const p = pitchPositionExtended(traj, Math.min(t, 1.24));
  if (p.z >= MITT_Z) return p;
  const a = pitchPositionAt(traj, 1); // 플레이트 통과 지점 (z = 0)
  const u = (MITT_Z - a.z) / (p.z - a.z);
  return { x: a.x + (p.x - a.x) * u, y: a.y + (p.y - a.y) * u, z: MITT_Z };
}

/** 현재 시각의 공 위치. 투구 중이면 투구 궤적, 타구 후면 타구 궤적. */
function ballPosition(s: Store): Vec3 | null {
  const now = performance.now();
  if (s.phase === 'FLIGHT' && s.trajectory) {
    // 릴리스 전(와인드업 중)에는 공이 글러브 안에 있으므로 그리지 않는다
    const t = (now - s.pitchStartAt) / s.displayFlightMs;
    if (t < 0) return null;
    return pitchDisplayPos(s.trajectory, t);
  }
  if (s.phase === 'RESULT' && s.lastResult) {
    const r = s.lastResult;
    const elapsed = now - s.resultStartAt;
    // 판정이 공보다 먼저 확정되는 구간(CPU 선행 스윙 등)에서는 투구 궤적을 계속 그린다
    if (elapsed < 0 || !r.battedBall || !r.contact) {
      const t = (now - s.pitchStartAt) / s.displayFlightMs;
      return s.trajectory && t >= 0 ? pitchDisplayPos(s.trajectory, t) : null;
    }
    // 주자 연출과 같은 시계를 쓴다
    const t = (elapsed / 1000) * s.playRate;
    // 땅에 닿은 뒤에는 바운드/구르기 → 글러브 → 송구로 이어진다
    const inPlay = sampleBallInPlay(s.timeline, t);
    if (inPlay) return inPlay;
    return sampleBattedPath(r.battedBall.path, r.battedBall.hangTime, t);
  }
  return null;
}

function sampleBattedPath(path: Vec3[], hangTime: number, t: number): Vec3 {
  if (!path.length) return { x: 0, y: 1, z: 0 };
  const clamped = Math.min(t, hangTime);
  const idx = Math.min(path.length - 1, Math.floor((clamped / Math.max(0.01, hangTime)) * (path.length - 1)));
  const a = path[idx];
  const b = path[Math.min(path.length - 1, idx + 1)];
  const frac = ((clamped / Math.max(0.01, hangTime)) * (path.length - 1)) % 1;
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    z: a.z + (b.z - a.z) * frac,
  };
}

// ---------------------------------------------------------------------------
// 스트라이크존 오버레이 + 조준 커서
// ---------------------------------------------------------------------------

function StrikeZone({ showAim }: { showAim: boolean }) {
  const aimRef = useRef<THREE.Group>(null);
  const rootRef = useRef<THREE.Group>(null);

  // 존은 그라운드에 놓인 물체가 아니라 판정 기준을 보여 주는 오버레이다.
  // 깊이 검사를 켜 두면 카메라와 홈플레이트 사이에 선 포수 머리에 가려
  // 정작 낮은 코스를 잴 때 기준선이 사라진다. 항상 앞에 그린다.
  useEffect(() => {
    rootRef.current?.traverse((o) => {
      o.renderOrder = 9;
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.depthTest = false;
    });
  }, []);

  useFrame(() => {
    const s = useMatchStore.getState();
    if (!aimRef.current) return;
    const w = zoneToWorld(s.aim.x, s.aim.y);
    const batter = s.state ? currentBatter(s.state) : null;
    const radius = batter ? swingDisplayRadius(s.swingType, batter.batting.contact) : 0;
    const worldRadius = radius * ZONE_HALF_WIDTH;
    aimRef.current.position.set(w.x, w.y, 0.02);
    // 오른쪽 조준 패널과 같은 정원으로 보이도록 가로 폭을 양축의 기준으로 쓴다.
    aimRef.current.scale.set(worldRadius, worldRadius, 1);
    aimRef.current.visible = showAim && (s.phase === 'FLIGHT' || s.phase === 'SETUP');
  });

  const h = ZONE_TOP - ZONE_BOTTOM;
  const w = ZONE_HALF_WIDTH * 2;
  const cy = (ZONE_TOP + ZONE_BOTTOM) / 2;

  return (
    <group ref={rootRef}>
      {/* 판정면(플레이트 앞 모서리)의 테두리. **존을 나타내는 사각형은 이것 하나뿐이다.**
          같은 크기·같은 색의 사각형을 하나라도 더 그리면(예: 뒷면 테두리) 타자 시점에서는
          그게 아래로 어긋나 겹쳐 보여서 "존이 두 개"로 읽힌다 — 공이 어느 선을 지났는지
          판단할 수 없게 되므로, 깊이감은 아래 바닥면·기둥처럼 모양이 다른 것으로만 준다. */}
      <lineSegments position={[0, cy, 0.01]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(w, h)]} />
        <lineBasicMaterial color="#fbbf24" transparent opacity={0.9} />
      </lineSegments>
      {/* 9분할 보조선 */}
      {[-1 / 3, 1 / 3].map((f) => (
        <group key={`v${f}`}>
          <mesh position={[f * ZONE_HALF_WIDTH * 2 * 0.5, cy, 0.008]}>
            <planeGeometry args={[0.004, h]} />
            <meshBasicMaterial color="#fbbf24" transparent opacity={0.28} />
          </mesh>
          <mesh position={[0, cy + f * h * 0.5, 0.008]}>
            <planeGeometry args={[w, 0.004]} />
            <meshBasicMaterial color="#fbbf24" transparent opacity={0.28} />
          </mesh>
        </group>
      ))}

      {/* 존의 바닥면. 홈플레이트 깊이(43cm)만큼 뒤로 깔아 둔다.
          위에서 내려다보는 타자 시점에서 이 면이 보이므로, 공이 그 아래로
          지나가면 "존 밑"이라는 게 한눈에 읽힌다. 선만 그려서는 존 하단
          경계가 공과 겹쳐 보여 낮은 코스를 구분할 수 없었다. */}
      <mesh position={[0, ZONE_BOTTOM, -PLATE_DEPTH / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, PLATE_DEPTH]} />
        <meshBasicMaterial color="#fbbf24" transparent opacity={0.16} side={THREE.DoubleSide} />
      </mesh>
      {/* 존 아래를 지면까지 잇는 기둥. 공의 높이를 잴 기준선이 된다. */}
      {[-1, 1].map((sx) => (
        <mesh key={`post${sx}`} position={[sx * ZONE_HALF_WIDTH, ZONE_BOTTOM / 2, 0.008]}>
          <planeGeometry args={[0.006, ZONE_BOTTOM]} />
          <meshBasicMaterial color="#fbbf24" transparent opacity={0.22} />
        </mesh>
      ))}
      <group ref={aimRef} visible={showAim}>
        <mesh>
          <circleGeometry args={[1, 32]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.15} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, 0, -0.001]}>
          <ringGeometry args={[0.93, 1, 32]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.95} side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// 투구 전 예상 궤적
// ---------------------------------------------------------------------------

/** 궤적을 몇 조각으로 나눠 그릴지. 커브의 낙차가 각지지 않을 만큼만. */
const PREVIEW_SEGMENTS = 40;
/** 예상 궤적 선의 굵기 (m). 18m 떨어진 존까지 이어지므로 공보다 가늘게 잡는다. */
const PREVIEW_TUBE_RADIUS = 0.024;

/**
 * 투수가 구종·코스를 고르는 동안 그 공이 그릴 선을 미리 보여 준다.
 *
 * 패널의 격자만으로는 "어느 칸을 노렸는가"밖에 알 수 없어서, 구종마다 다른
 * 변화(커브의 낙차, 슬라이더의 횡 이동)를 감안해 코스를 고를 수가 없었다.
 *
 * 난수를 뺀 평균 궤적이라 도착점은 노린 지점과 같다. 실제 공은 제구만큼
 * 흩어지므로, 그 산포(±1σ)를 도착점 둘레의 타원으로 함께 그린다.
 *
 * 이 값을 채우는 건 투구 패널뿐이고 스토어는 클라이언트마다 따로이므로,
 * 타자 화면에 구종이 새지 않는다.
 */
function PitchPreview() {
  const cmd = useMatchStore((s) => s.pitchPreview);
  const state = useMatchStore((s) => s.state);
  // 패널이 아직 떠 있어도(원격 투구 대기 등) 공이 떠난 뒤에는 그리지 않는다
  const setup = useMatchStore((s) => s.phase === 'SETUP');

  const preview = useMemo(() => {
    if (!cmd || !state) return null;
    const pitcher = currentPitcher(state);
    const pitches = defenseTeam(state).pitcherPitches;
    const traj = previewPitch(pitcher, cmd, pitches);
    const points = Array.from({ length: PREVIEW_SEGMENTS + 1 }, (_, i) => {
      const p = pitchPositionAt(traj, i / PREVIEW_SEGMENTS);
      return new THREE.Vector3(p.x, p.y, p.z);
    });
    return {
      curve: new THREE.CatmullRomCurve3(points),
      plate: traj.plate,
      spread: controlSpread(pitcher, cmd, pitches),
      color: PITCH_DEFS[cmd.type].color,
    };
  }, [cmd, state]);

  if (!setup || !preview) return null;

  return (
    <group>
      {/* 궤적. 마운드의 투수 몸에는 가려지는 게 자연스러우므로 깊이 검사를 켜 둔다. */}
      <mesh>
        <tubeGeometry args={[preview.curve, PREVIEW_SEGMENTS, PREVIEW_TUBE_RADIUS, 6, false]} />
        <meshBasicMaterial
          color={preview.color}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </mesh>

      {/* 도착점. 존 위에 겹치는 표시라 항상 앞에 그린다 (존·조준 커서와 같은 취급).
          존 평면에 눕힌 원판이므로 양면으로 그려야 타자 시점(존 뒤)에서도 보인다. */}
      <group position={[preview.plate.x, preview.plate.y, 0.02]}>
        {/* 제구 산포. 실제 공은 대체로 이 타원 안으로 들어온다. */}
        <mesh
          renderOrder={9}
          scale={[preview.spread.x * ZONE_HALF_WIDTH, preview.spread.y * ZONE_HALF_HEIGHT, 1]}
        >
          <ringGeometry args={[0.93, 1, 48]} />
          <meshBasicMaterial
            color={preview.color}
            transparent
            opacity={0.4}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        <mesh renderOrder={10}>
          <circleGeometry args={[BALL_RADIUS, 20]} />
          <meshBasicMaterial
            color={preview.color}
            transparent
            opacity={0.9}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        <mesh renderOrder={10}>
          <ringGeometry args={[BALL_RADIUS * 1.75, BALL_RADIUS * 2.15, 28]} />
          <meshBasicMaterial
            color="#f8fafc"
            transparent
            opacity={0.85}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// 카메라
// ---------------------------------------------------------------------------

/**
 * 스카이뷰가 바라보는 지점의 z. 홈플레이트(0)와 가장 깊은 펜스(122m) 사이를 잡아
 * 내야와 외야 담장이 한 화면에 들어오게 한다.
 */
const SKY_CENTER_Z = 42;
/** Canvas가 잡아 둔 기본 화각. 스카이뷰에서만 벌렸다가 여기로 되돌린다. */
const BASE_FOV = 42;
/** 이 가로세로비에서 구장 전체가 딱 들어오도록 스카이뷰를 맞춰 두었다 */
const SKY_REF_ASPECT = 1.6;

function CameraRig({ mode }: { mode: CameraMode }) {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3(0, 1, 18));
  const desired = useRef(new THREE.Vector3(0, 2.2, -6));
  const prevShot = useRef('');

  useFrame((rs, delta) => {
    const s = useMatchStore.getState();
    const batting = isPlayerBatting(s);

    let camPos: THREE.Vector3;
    let look: THREE.Vector3;
    // 화각(fov)은 세로 기준이라, 화면이 좁아지면 좌우가 그만큼 잘린다.
    // 스카이뷰에서만 부족한 만큼 넓히고 다른 샷에서는 기본값으로 되돌린다.
    let fov = BASE_FOV;

    if (s.phase === 'INNING_BREAK') {
      // 공수 교대: 구장 전체가 들어오는 스카이뷰.
      // 완전히 멈춘 그림은 화면이 굳은 것처럼 보이므로, 안내가 떠 있는 동안
      // 3루 쪽에서 1루 쪽으로 아주 천천히 돌며 조금씩 내려온다.
      const t = clamp(1 - (s.inningBreakEndsAt - performance.now()) / INNING_BREAK_MS, 0, 1);
      const angle = -0.16 + 0.32 * t;
      // 좁은 화면에서는 조금 물러나고, 그래도 모자라면 화각을 벌려 채운다.
      // (거리로만 맞추면 선수가 점처럼 작아진다)
      const fit = clamp(SKY_REF_ASPECT / Math.max(0.3, rs.size.width / rs.size.height), 1, 1.9);
      const pull = Math.min(fit, 1.3);
      fov = Math.min(72, BASE_FOV * (fit / pull));
      const radius = (96 - 8 * t) * pull;
      camPos = new THREE.Vector3(
        Math.sin(angle) * radius,
        (88 - 10 * t) * pull,
        SKY_CENTER_Z - Math.cos(angle) * radius,
      );
      look = new THREE.Vector3(0, 2, SKY_CENTER_Z);
    } else if (s.phase === 'RESULT' && s.lastResult?.contact && s.lastResult.battedBall) {
      // 타구 추적 카메라
      const bb = s.lastResult.battedBall;
      const land = bb.landing;
      const dist = Math.hypot(land.x, land.z);
      if (dist > 55 || bb.overFence) {
        camPos = new THREE.Vector3(land.x * 0.28, 14 + dist * 0.1, -14);
        look = new THREE.Vector3(land.x * 0.6, 3, land.z * 0.6);
      } else {
        // 내야 플레이는 다이아몬드 전체가 들어와야 한다.
        // (더 당겨 잡으면 1·3루와 홈이 화면 밖으로 나가 야수의 움직임과
        //  송구가 보이지 않는다 — 잡았는지 놓쳤는지 알 수 없게 된다)
        camPos = new THREE.Vector3(0, 22, -26);
        look = new THREE.Vector3(land.x * 0.25, 1.0, 20);
      }
    } else if (mode === 'FIELD') {
      camPos = new THREE.Vector3(0, 26, -26);
      look = new THREE.Vector3(0, 0, 34);
    } else if (batting || mode === 'BATTER') {
      // 타자 시점: 포수 뒤에서 투수를 바라본다.
      //
      // SD 비율이라 포수 머리가 커서, 낮게 잡으면 홈플레이트와 존을 가린다.
      // 그래서 높이 잡되, 시선은 마운드가 아니라 **홈플레이트 쪽**으로 내린다.
      // 예전처럼 멀리(z=14)를 보면 존이 화면 밑바닥(76~90% 지점)에 깔려서
      // 존 아래로 오는 공이 화면 밖으로 나가 버려 높낮이를 읽을 수 없었다.
      // 지금 구도에서 존은 화면 52~63%, 홈플레이트 지면이 71%에 잡혀
      // 존 아래로도 화면이 3분의 1쯤 남는다.
      camPos = new THREE.Vector3(0, 3.05, -6.6);
      look = new THREE.Vector3(0, 1.2, 0);
    } else {
      // 투수 시점: 마운드 뒤 약간 높은 곳
      camPos = new THREE.Vector3(0, 3.1, MOUND_DISTANCE + 7.2);
      look = new THREE.Vector3(0, 1.0, 0);
    }

    // 샷이 바뀌는 순간(타구 추적 시작 등)에는 컷 전환하고, 그 외에는 부드럽게 따라간다.
    const shotKey =
      s.phase === 'INNING_BREAK'
        ? 'sky'
        : s.phase === 'RESULT' && s.lastResult?.contact
          ? 'follow'
          : batting
            ? 'bat'
            : mode;
    if (shotKey !== prevShot.current) {
      prevShot.current = shotKey;
      desired.current.copy(camPos);
      target.current.copy(look);
    } else {
      desired.current.lerp(camPos, Math.min(1, delta * 6));
      target.current.lerp(look, Math.min(1, delta * 6));
    }
    camera.position.copy(desired.current);
    camera.lookAt(target.current);

    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera && Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  });

  return null;
}

/**
 * 지금 화면이 스트라이크존을 어느 쪽에서 보고 있는가 (true면 좌우가 뒤집혀 보인다).
 *
 * 존 좌표 +x는 **포수 뒤에서 본 오른쪽**(1루 쪽, 월드 -X)으로 정의돼 있다(zoneToWorld).
 * 홈 뒤에서 잡는 샷(타자 시점·전체 뷰)은 그 정의와 같지만, 마운드 뒤에서 잡는
 * 투수 시점만 화면 오른쪽이 3루(월드 +X)가 되어 부호가 반대가 된다.
 *
 * 조작 패널의 좌우를 화면과 맞추는 데 쓴다. 위 CameraRig의 분기와 같이 고쳐야 한다.
 * (패널이 떠 있는 SETUP 단계에는 INNING_BREAK·타구 추적 샷이 잡히지 않으므로
 *  여기서는 카메라 모드와 공수만 보면 된다)
 */
export function zoneFlippedOnScreen(mode: CameraMode, batting: boolean): boolean {
  if (mode === 'FIELD') return false; // 전체 뷰: 홈 뒤 높은 곳
  if (batting || mode === 'BATTER') return false; // 타자 시점: 포수 뒤
  return true; // 투수 시점: 마운드 뒤
}

// ---------------------------------------------------------------------------
// 프레임 드라이버 (엔진 tick)
// ---------------------------------------------------------------------------

function Driver() {
  useFrame(() => {
    const now = performance.now();
    useMatchStore.getState().tick(now);
    cpuBatterTick(now);
  });
  return null;
}

// ---------------------------------------------------------------------------

export function GameScene({ cameraMode = 'DRAMATIC' }: { cameraMode?: CameraMode }) {
  const state = useMatchStore((s) => s.state);
  const playerBatting = useMatchStore((s) => isPlayerBatting(s));
  // 공수 교대 중에는 존을 그리지 않는다. 스카이뷰에서는 홈플레이트 위에 뜬
  // 노란 사각형이 그라운드를 가로지르는 선처럼 보인다.
  const inningBreak = useMatchStore((s) => s.phase === 'INNING_BREAK');

  if (!state) return null;

  return (
    <Canvas
      shadows
      dpr={[1, 1.8]}
      camera={{ fov: 42, near: 0.1, far: 900, position: [0, 2.2, -6] }}
      // preserveDrawingBuffer: 캔버스를 이미지로 캡처할 수 있게 한다.
      // (끄면 toDataURL / 자동화 스크린샷이 검은 화면으로 나온다)
      gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      onCreated={({ gl }) => {
        // 톤매핑이 없으면 툰 셰이딩의 가장 밝은 밴드가 흰색으로 날아간다
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.06;
      }}
    >
      <color attach="background" args={['#12233b']} />
      <fog attach="fog" args={['#16304d', 180, 430]} />

      {/* 조명: 키(야간 조명탑) + 하늘/잔디 반사 + 반대편 림라이트.
          합이 1을 크게 넘으면 얼굴이 하얗게 날아가므로 총량을 눌러 잡는다. */}
      <hemisphereLight args={['#cfe4ff', '#31491f', 0.62]} />
      <directionalLight
        position={[45, 70, 20]}
        intensity={1.05}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0006}
        shadow-normalBias={0.02}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-far={220}
      />
      <directionalLight position={[-40, 45, 90]} intensity={0.34} color="#bcd8ff" />
      <directionalLight position={[10, 20, -60]} intensity={0.22} color="#ffe6bd" />

      <Stadium />
      <SceneActors />
      <Ball />
      {!inningBreak && <StrikeZone showAim={playerBatting} />}
      {!inningBreak && <PitchPreview />}

      <CameraRig mode={cameraMode} />
      <Driver />
    </Canvas>
  );
}

/** 선수 렌더링. 결과 연출 중에는 투구 직전 상태를 기준으로 그린다. */
function SceneActors() {
  const phase = useMatchStore((s) => s.phase);
  const state = useMatchStore((s) => s.state);
  const prePitch = useMatchStore((s) => s.prePitchState);
  const scene = (phase === 'RESULT' ? prePitch : null) ?? state;
  if (!scene) return null;

  return (
    <>
      <Fielders state={scene} />
      <Runners />
      <Batter />
      <Pitcher />
    </>
  );
}
