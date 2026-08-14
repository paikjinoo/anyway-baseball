'use client';

import { useMemo } from 'react';
import { PlayerModel, type PoseKind, type UniformSpec } from './PlayerModel';
import { qualityFlags, useQuality } from './quality';
import { BASE_COORDS, BASE_DISTANCE } from '@/lib/game/constants';
import { generatePlayer } from '@/lib/game/generator';
import { Rng } from '@/lib/game/rng';
import { useMatchStore } from '@/lib/store/matchStore';
import type { Player, Vec3 } from '@/lib/game/types';

/**
 * 심판.
 *
 * 포수 뒤와 1·3루가 텅 비어 있었다. 야구 중계에서 화면에 늘 함께 있는 사람들이라,
 * 없으면 "경기"가 아니라 "선수 배치도"처럼 보인다. 게다가 스트라이크 콜은 매 투구
 * 나오는 동작인데 화면에 한 번도 등장한 적이 없었다.
 *
 * 판정에는 아무 영향도 주지 않는다 — 스토어가 이미 정한 결과를 몸짓으로 옮길 뿐이다.
 */

const UMPIRE_UNIFORM: UniformSpec = {
  primary: '#1e2531',
  secondary: '#39424f',
  accent: '#0d1117',
  type: 'CLASSIC',
};

/**
 * 심판 모델용 Player.
 *
 * 능력치는 쓰이지 않지만 PlayerModel이 체형·좌우·장비를 읽으므로 유효한 객체가 필요하다.
 * generatePlayer를 고정 시드로 한 번 돌려 만든다 (직접 리터럴을 쓰면 Player 필드가
 * 늘 때마다 여기가 깨진다).
 */
function makeOfficial(seed: number, num: number): Player {
  const p = generatePlayer(new Rng(seed), { position: 'C', number: num });
  return {
    ...p,
    name: '심판',
    body: 'NORMAL',
    kind: 'BATTER',
    gear: { ...p.gear, accessory: 'NONE' },
  };
}

/** 다이아몬드 바깥 방향 (파울 지역 쪽) */
function outward(bag: Vec3): { x: number; z: number } {
  const cx = 0;
  const cz = (BASE_DISTANCE * Math.SQRT2) / 2;
  const dx = bag.x - cx;
  const dz = bag.z - cz;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

/** 스트라이크 콜을 유지하는 시간 (s) */
const CALL_MS = 1100;
/** 콜 동작이 완성되기까지 (s) */
const CALL_RISE = 0.45;

const STRIKE_KINDS = new Set(['STRIKE_LOOKING', 'STRIKE_SWINGING', 'STRIKEOUT', 'FOUL']);

export function Officials({ hideHome }: { hideHome?: boolean }) {
  const q = useQuality();
  const phase = useMatchStore((s) => s.phase);
  const revealed = useMatchStore((s) => s.revealed);
  const lastKind = useMatchStore((s) => s.lastResult?.kind);
  const resultAt = useMatchStore((s) => s.resultStartAt);

  const crew = useMemo(
    () => ({
      home: makeOfficial(101, 1),
      first: makeOfficial(202, 2),
      third: makeOfficial(303, 3),
    }),
    [],
  );

  if (q.officials === 0) return null;

  // 스트라이크 계열 판정이 공개되면 주심이 콜을 한다.
  // 결과가 아직 감춰져 있는 동안(revealAt 이전)에는 절대 움직이면 안 된다 —
  // 심판이 먼저 팔을 올리면 그게 곧 스포일러다.
  const el = performance.now() - resultAt;
  const calling =
    phase === 'RESULT' && revealed && !!lastKind && STRIKE_KINDS.has(lastKind) && el < CALL_MS;
  const pose: PoseKind = calling ? 'CALL_STRIKE' : 'UMPIRE';
  const animT = calling ? Math.min(1, el / 1000 / CALL_RISE) : 0;

  const first = BASE_COORDS[0];
  const third = BASE_COORDS[2];
  const o1 = outward(first);
  const o3 = outward(third);

  return (
    <>
      {/* 주심: 포수 뒤 안쪽 어깨 너머.
          타자 시점에서 공을 보는 동안에는 포수와 함께 지운다 (@see plateCrewHidden) */}
      {!hideHome && (
        <PlayerModel
          player={crew.home}
          uniform={UMPIRE_UNIFORM}
          pose={pose}
          animT={animT}
          headwear="MASK"
          position={[0.32, 0, -2.45]}
          rotationY={0}
        />
      )}
      {q.officials >= 2 && (
        <>
          <PlayerModel
            player={crew.first}
            uniform={UMPIRE_UNIFORM}
            pose="IDLE"
            headwear="CAP"
            position={[first.x + o1.x * 3.2, 0, first.z + o1.z * 3.2]}
            rotationY={Math.atan2(-o1.x, -o1.z)}
          />
          <PlayerModel
            player={crew.third}
            uniform={UMPIRE_UNIFORM}
            pose="IDLE"
            headwear="CAP"
            position={[third.x + o3.x * 3.2, 0, third.z + o3.z * 3.2]}
            rotationY={Math.atan2(-o3.x, -o3.z)}
          />
        </>
      )}
    </>
  );
}

/**
 * 대기 타석 타자.
 *
 * 다음 타자가 서클에서 몸을 푸는 그림은 야구 화면의 기본 구성 요소다.
 * @see engine.onDeckBatter
 */
export function OnDeck({ player, uniform }: { player: Player; uniform: UniformSpec }) {
  if (qualityFlags().officials < 2) return null;
  // 3루 쪽 서클. 타자 시점 카메라가 z = -9.2에 있으므로 그보다 앞에 세워야
  // 렌즈에 붙어 화면을 가리지 않는다.
  return (
    <PlayerModel
      player={player}
      uniform={uniform}
      pose="BATTING"
      headwear="HELMET"
      position={[8.2, 0, -3.4]}
      rotationY={-2.1}
    />
  );
}
