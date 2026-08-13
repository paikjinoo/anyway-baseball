/**
 * 포즈가 사람 몸으로 가능한 자세인지 수치로 검사한다.
 *
 * 선수 모델은 스크린샷으로 검증하기가 유난히 어렵다. 캐릭터가 작고, 원근과 큰 머리
 * 때문에 방향을 눈으로 잘못 읽기 쉽고, 원하는 포즈를 띄우려면 경기를 그 상황까지
 * 몰고 가야 한다. 그래서 "팔꿈치가 몸통 안에 박혀 있다" 같은 결함이 오래 남아 있었다.
 *
 * 여기서는 전 포즈를 시간축으로 훑으며 다음을 본다.
 *  1. 굴곡 한계   — 팔꿈치·무릎이 사람 가동범위를 넘지 않는가
 *  2. 몸통 관통   — 팔이 몸통 캡슐을 뚫고 지나가지 않는가
 *  3. 머리 관통   — 손이 머리에 박히지 않는가
 *  4. 연속성      — 한 프레임에 관절이 순간이동하지 않는가
 *  5. IK 포화     — 배트/글러브를 잡는 손이 실제로 그 지점에 닿는가
 *  6. 접지        — 발이 지면을 뚫거나 공중에 뜨지 않는가
 *  7. 손목        — 손이 쥔 물건 방향을 유지하고, 그 각도가 사람 범위 안인가
 *
 * 실패 메시지에는 포즈·시각·실측값이 들어간다. 그 값을 그대로 들고 포즈 데이터를
 * 고치면 된다.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  RELEASE_AT,
  SELF_DRIVEN,
  buildPose,
  jointPositions,
  newSnapshot,
  writeSnapshot,
  type PoseKind,
  type Snapshot,
} from './poses';
import {
  HEAD_R,
  HEAD_SCALE,
  HEAD_Y,
  TORSO_LEN,
  TORSO_R,
  WRIST_MAX_SWING,
  WRIST_MAX_TWIST,
} from './rig';
import type { BattingStance, Handedness, PitchingForm, Player } from '@/lib/game/types';

// --- 사람 관절 가동범위 -------------------------------------------------------
// 팔꿈치 굴곡은 145°, 무릎은 150°가 일반적인 상한이다. 과신전(반대로 꺾임)은 0으로 본다.
const ELBOW_MAX = (145 * Math.PI) / 180;
const KNEE_MAX = (150 * Math.PI) / 180;

/**
 * 팔이 몸통 축에서 이만큼은 떨어져 있어야 한다.
 *
 * 몸통 반지름이 0.2인데 그대로 쓰면 팔을 몸에 붙인 자세가 전부 걸린다 — 실제로 살은
 * 눌린다. 4cm를 빼서 "닿는 것"과 "뚫고 지나가는 것"을 가른다.
 */
const TORSO_CLEAR = TORSO_R - 0.04;
/** 몸통 캡슐의 원통 구간 (양 끝 반구는 반지름으로 처리된다) */
const TORSO_HALF = TORSO_LEN / 2;
/** SD 비율이라 머리가 크다. 실제 그려지는 반지름으로 본다. */
const HEAD_RADIUS = HEAD_R * HEAD_SCALE;

const ALL_POSES: PoseKind[] = [
  'IDLE',
  'BATTING',
  'BATTING_SWING',
  'BATTING_BUNT',
  'PITCHING_SET',
  'PITCHING_RELEASE',
  'FIELDING',
  'RUNNING',
  'CATCHING',
  'SLIDING',
  'CELEBRATE',
  'THROWING',
  'DIVING',
  'SLIDING_HEAD',
  'TAG',
  'JUMP',
  'REACT_DOWN',
  'REACT_UP',
  'UMPIRE',
  'CALL_STRIKE',
  'CALL_SAFE',
];

/** 손에 장비를 쥔 포즈. 손이 그 지점에 실제로 닿아야 한다. */
const HOLDS_BAT: PoseKind[] = ['BATTING', 'BATTING_SWING', 'BATTING_BUNT'];

function mkPlayer(stance: BattingStance, form: PitchingForm, throws: Handedness): Player {
  // 포즈 함수가 읽는 필드는 이 셋뿐이다 (poses.ts의 player.* 참조).
  return { stance, form, throws } as Player;
}

const SAMPLES = 120;

interface Sample {
  /** 0~1로 정규화된 진행도 (SELF_DRIVEN 포즈는 clock을 이 범위에 매핑) */
  u: number;
  snap: Snapshot;
  jp: ReturnType<typeof jointPositions>;
  /** 접지 보정이 걸린 프레임인지. 꺼져 있으면 높이는 포즈가 직접 정한 값이다. */
  grounded: boolean;
  /**
   * 그 프레임의 실제 배트 그립(배트 로컬 Y). 번트는 손을 벌려 [-0.03, 0.3]까지 가므로
   * 기본값 [-0.02, 0.11]로 재면 멀쩡한 손이 19cm 어긋난 것처럼 나온다.
   */
  grip: [number, number];
}

/** 포즈 하나를 시간축으로 훑어 스냅샷 배열을 만든다. */
function sweep(
  kind: PoseKind,
  player: Player,
  batSide: Handedness = 'R',
  intensity = 1,
): Sample[] {
  const out: Sample[] = [];
  const selfDriven = SELF_DRIVEN[kind];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    // 시계로 도는 포즈는 t를 안 쓴다. 대신 3초를 훑어 호흡·흔들림 주기를 덮는다.
    const t = selfDriven ? 0 : u;
    const clock = selfDriven ? u * 3 : 0;
    const pose = buildPose(kind, t, player, intensity, clock, batSide);
    const snap = newSnapshot();
    writeSnapshot(pose, snap);
    out.push({
      u,
      snap,
      jp: jointPositions(snap),
      grounded: pose.ground,
      grip: pose.bat?.grip ?? [-0.02, 0.11],
    });
  }
  return out;
}

/** 선분 ab 위의 점들 중 몸통 축까지 가장 가까운 거리 */
function segmentTorsoClearance(a: THREE.Vector3, b: THREE.Vector3): number {
  let min = Infinity;
  for (let i = 0; i <= 16; i++) {
    const p = new THREE.Vector3().lerpVectors(a, b, i / 16);
    // 몸통 캡슐의 원통 구간을 벗어난 높이는 반구가 받으므로, y를 구간 안으로 당겨
    // 캡슐 축 선분까지의 거리로 환산한다.
    const y = THREE.MathUtils.clamp(p.y, -TORSO_HALF, TORSO_HALF);
    min = Math.min(min, Math.hypot(p.x, p.z, p.y - y));
  }
  return min;
}

/** 선분 ab에서 머리 중심까지의 최소 거리 */
function segmentHeadClearance(a: THREE.Vector3, b: THREE.Vector3): number {
  const head = new THREE.Vector3(0, HEAD_Y, 0);
  let min = Infinity;
  for (let i = 0; i <= 16; i++) {
    min = Math.min(min, new THREE.Vector3().lerpVectors(a, b, i / 16).distanceTo(head));
  }
  return min;
}

const at = (kind: PoseKind, u: number) => `${kind} t=${u.toFixed(3)}`;

const BAT_PLAYER = mkPlayer(0, 1, 'R');

describe('관절 가동범위', () => {
  for (const kind of ALL_POSES) {
    it(`${kind}: 팔꿈치·무릎이 사람 범위 안`, () => {
      const bad: string[] = [];
      for (const { u, snap } of sweep(kind, BAT_PLAYER)) {
        for (const [name, arm] of [
          ['armL', snap.armL],
          ['armR', snap.armR],
        ] as const) {
          const flex = -arm.elbow;
          if (flex < -1e-6) bad.push(`${at(kind, u)} ${name} 팔꿈치 과신전 ${deg(flex)}`);
          if (flex > ELBOW_MAX + 1e-6) bad.push(`${at(kind, u)} ${name} 팔꿈치 ${deg(flex)}`);
        }
        for (const [name, leg] of [
          ['legL', snap.legL],
          ['legR', snap.legR],
        ] as const) {
          if (leg.knee < -1e-6) bad.push(`${at(kind, u)} ${name} 무릎 과신전 ${deg(-leg.knee)}`);
          if (leg.knee > KNEE_MAX + 1e-6) bad.push(`${at(kind, u)} ${name} 무릎 ${deg(leg.knee)}`);
        }
      }
      expect(report(bad)).toBe('OK');
    });
  }
});

describe('몸통 관통', () => {
  for (const kind of ALL_POSES) {
    it(`${kind}: 팔이 몸통을 뚫지 않음`, () => {
      const bad: string[] = [];
      for (const { u, jp } of sweep(kind, BAT_PLAYER)) {
        const arms = [
          ['armL', jp.shoulderL, jp.elbowL, jp.handL],
          ['armR', jp.shoulderR, jp.elbowR, jp.handR],
        ] as const;
        for (const [name, sh, el, hand] of arms) {
          const upper = segmentTorsoClearance(sh, el);
          const fore = segmentTorsoClearance(el, hand);
          const d = Math.min(upper, fore);
          if (d < TORSO_CLEAR) {
            bad.push(`${at(kind, u)} ${name} 몸통축까지 ${d.toFixed(3)} (>= ${TORSO_CLEAR.toFixed(2)})`);
          }
        }
      }
      expect(report(bad)).toBe('OK');
    });
  }
});

describe('머리 관통', () => {
  for (const kind of ALL_POSES) {
    it(`${kind}: 손·팔이 머리에 박히지 않음`, () => {
      const bad: string[] = [];
      for (const { u, jp } of sweep(kind, BAT_PLAYER)) {
        for (const [name, el, hand] of [
          ['armL', jp.elbowL, jp.handL],
          ['armR', jp.elbowR, jp.handR],
        ] as const) {
          const d = segmentHeadClearance(el, hand);
          if (d < HEAD_RADIUS) {
            bad.push(`${at(kind, u)} ${name} 머리중심까지 ${d.toFixed(3)} (>= ${HEAD_RADIUS.toFixed(2)})`);
          }
        }
      }
      expect(report(bad)).toBe('OK');
    });
  }
});

/**
 * 각 포즈가 실제로 재생되는 시간(ms). 연속성을 **속도**로 재려면 이게 있어야 한다.
 *
 * 처음엔 "그 포즈 안에서 중앙값의 몇 배나 튀는가"로 재려 했는데, 콜 동작처럼
 * 앞부분만 빠르고 나머지가 멈춰 있는 포즈에서 정상 동작이 걸렸다(중앙값이 0에
 * 가까워 4cm 이동이 39배로 잡힌다). 결국 사람 팔이 낼 수 있는 속도라는 절대 기준이
 * 제일 정직하다.
 */
const DURATION_MS: Partial<Record<PoseKind, number>> = {
  BATTING_SWING: 340, // matchStore.SWING_MS
  BATTING_BUNT: 440, // matchStore.BUNT_MS
  BATTING: 520, // matchStore.WINDUP_MS (딜리버리 동안의 로드)
  PITCHING_RELEASE: 520 / RELEASE_AT, // GameScene.DELIVERY_MS
  THROWING: 620, // playback.THROW_MS
  CALL_STRIKE: 450, // Officials.CALL_RISE
  CALL_SAFE: 450,
};
const DEFAULT_MS = 500;

describe('연속성', () => {
  // 프레임 사이에 관절이 튀면 pole이 뒤집혔거나 키프레임이 끊긴 것이다.
  //
  // 상한은 실측으로 잡았다. 고친 뒤 투구 팔꿈치는 릴리스 순간 13 m/s까지 올라가는데,
  // 그건 4 → 5.7 → 9.9 → 13으로 **매끄럽게 가속한 끝**이라 정상이다. 반면 결함들은
  // 31·52·72·79·87 m/s로 앞뒤 프레임과 아무 연결 없이 한 칸에서 튀었다. 16이면
  // 정상 가속은 통과하고 순간이동만 걸린다.
  const MAX_SPEED = 16;
  for (const kind of ALL_POSES) {
    if (SELF_DRIVEN[kind]) continue;
    it(`${kind}: 팔꿈치가 순간이동하지 않음`, () => {
      const samples = sweep(kind, BAT_PLAYER);
      const dt = (DURATION_MS[kind] ?? DEFAULT_MS) / 1000 / SAMPLES;
      const bad: string[] = [];
      for (const side of ['elbowL', 'elbowR'] as const) {
        for (let i = 1; i < samples.length; i++) {
          const step = samples[i].jp[side].distanceTo(samples[i - 1].jp[side]);
          const speed = step / dt;
          if (speed > MAX_SPEED) {
            bad.push(
              `${at(kind, samples[i].u)} ${side} ${speed.toFixed(0)}m/s` +
                ` (한 스텝 ${(step * 100).toFixed(1)}cm)`,
            );
          }
        }
      }
      expect(report(bad)).toBe('OK');
    });
  }
});

describe('IK 포화', () => {
  for (const kind of HOLDS_BAT) {
    it(`${kind}: 양손이 배트 그립에 닿음`, () => {
      const bad: string[] = [];
      for (const { u, snap, jp, grip } of sweep(kind, BAT_PLAYER)) {
        const grips = grip.map((g) =>
          new THREE.Vector3(0, g, 0).applyQuaternion(snap.batQuat).add(snap.batPos),
        );
        for (const [name, hand] of [
          ['handL', jp.handL],
          ['handR', jp.handR],
        ] as const) {
          const d = Math.min(...grips.map((g) => hand.distanceTo(g)));
          if (d > 0.001) {
            bad.push(`${at(kind, u)} ${name} 그립에서 ${(d * 100).toFixed(1)}cm 떨어짐`);
          }
        }
      }
      expect(report(bad)).toBe('OK');
    });
  }
});

describe('접지', () => {
  // 접지 보정(pose.ground)이 켜진 포즈만 본다. 다이빙·슬라이딩처럼 꺼 놓은 포즈는
  // 높이를 포즈가 직접 정하므로 여기서 판정할 대상이 아니다.
  //
  // "항상 y=0"은 규칙이 될 수 없다. 세리머니·환호는 접지 보정을 켠 채로 root.y에
  // 3~7cm 도약을 얹어 일부러 뜨기 때문이다. 대신 두 가지를 본다 —
  // 절대 지면 아래로 내려가지 않을 것, 그리고 한 번은 지면에 닿을 것.
  for (const kind of ALL_POSES) {
    it(`${kind}: 발이 지면을 뚫지 않고 한 번은 닿음`, () => {
      const bad: string[] = [];
      let lowest = Infinity;
      let grounds = 0;
      for (const { u, jp, grounded } of sweep(kind, BAT_PLAYER)) {
        const low = Math.min(jp.soleLY, jp.soleRY);
        // 지면을 뚫는 건 접지 보정과 무관하게 언제나 잘못이다. 다이빙·슬라이딩처럼
        // 보정을 꺼 둔 포즈도 다리가 잔디 밑으로 들어가면 안 된다.
        if (low < -0.02) bad.push(`${at(kind, u)} 발바닥 y=${low.toFixed(3)} (지면 아래)`);
        if (!grounded) continue;
        grounds++;
        lowest = Math.min(lowest, low);
      }
      if (grounds && lowest > 0.01) {
        bad.push(`${kind} 전 구간 발이 떠 있다 (가장 낮은 발바닥 y=${lowest.toFixed(3)})`);
      }
      expect(report(bad)).toBe('OK');
    });
  }
});

describe('손목', () => {
  // 손목은 장비 방향에서 역산한 뒤 사람 가동범위로 잘린다. 클램프가 세게 물린다는
  // 것은 그 팔의 IK 해가 애초에 어색해서 손이 그립을 향할 수 없다는 신호다 —
  // 그래서 "얼마나 어긋난 채로 잡고 있나"를 그대로 지표로 쓴다.
  const forearmOf = (arm: { quat: THREE.Quaternion; elbow: number }) =>
    new THREE.Quaternion()
      .copy(arm.quat)
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(arm.elbow, 0, 0, 'XYZ')));

  for (const kind of HOLDS_BAT) {
    it(`${kind}: 손이 배트를 쥔 방향을 유지한다`, () => {
      const bad: string[] = [];
      for (const { u, snap } of sweep(kind, BAT_PLAYER)) {
        const barrel = new THREE.Vector3(0, 1, 0).applyQuaternion(snap.batQuat);
        for (const [name, arm] of [
          ['armL', snap.armL],
          ['armR', snap.armR],
        ] as const) {
          const handQ = forearmOf(arm).multiply(arm.wrist);
          const palmAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(handQ);
          // 손 로컬 X가 배럴과 나란해야 샤프트가 손바닥을 가로지른다 (앞뒤 무관)
          const off = Math.acos(Math.min(1, Math.abs(palmAxis.dot(barrel))));
          if (off > (35 * Math.PI) / 180) {
            bad.push(`${at(kind, u)} ${name} 배트축과 ${deg(off)} 어긋남`);
          }
        }
      }
      expect(report(bad)).toBe('OK');
    });
  }

  it('손목이 사람 가동범위를 넘지 않는다', () => {
    const bad: string[] = [];
    for (const kind of ALL_POSES) {
      for (const { u, snap } of sweep(kind, BAT_PLAYER)) {
        for (const [name, arm] of [
          ['armL', snap.armL],
          ['armR', snap.armR],
        ] as const) {
          const w = Math.abs(arm.wrist.w);
          const ang = 2 * Math.acos(Math.min(1, w));
          // twist와 swing을 따로 자르므로 합성각은 둘의 합을 넘을 수 없다
          if (ang > WRIST_MAX_TWIST + WRIST_MAX_SWING + 1e-6) {
            bad.push(`${at(kind, u)} ${name} 손목 ${deg(ang)}`);
          }
        }
      }
    }
    expect(report(bad)).toBe('OK');
  });
});

describe('좌우·폼 변형', () => {
  it('좌타 스윙도 같은 불변식을 지킨다', () => {
    const bad: string[] = [];
    for (const { u, jp, snap } of sweep('BATTING_SWING', BAT_PLAYER, 'L')) {
      for (const [name, sh, el, hand] of [
        ['armL', jp.shoulderL, jp.elbowL, jp.handL],
        ['armR', jp.shoulderR, jp.elbowR, jp.handR],
      ] as const) {
        const d = Math.min(segmentTorsoClearance(sh, el), segmentTorsoClearance(el, hand));
        if (d < TORSO_CLEAR) bad.push(`좌타 ${at('BATTING_SWING', u)} ${name} ${d.toFixed(3)}`);
      }
      for (const arm of [snap.armL, snap.armR]) {
        if (-arm.elbow > ELBOW_MAX + 1e-6) {
          bad.push(`좌타 ${at('BATTING_SWING', u)} 팔꿈치 ${deg(-arm.elbow)}`);
        }
      }
    }
    expect(report(bad)).toBe('OK');
  });

  it('투구 폼 0~4 모두 릴리스에서 팔이 펴진다', () => {
    const bad: string[] = [];
    for (let form = 0; form < 5; form++) {
      const p = mkPlayer(0, form as PitchingForm, 'R');
      const pose = buildPose('PITCHING_RELEASE', RELEASE_AT, p, 1, 0, 'R');
      const snap = newSnapshot();
      writeSnapshot(pose, snap);
      const flex = -snap.armL.elbow;
      // 릴리스 순간 던지는 팔은 거의 펴져 있어야 한다 (굴곡 45° 미만)
      if (flex > (45 * Math.PI) / 180) bad.push(`form=${form} 릴리스 팔꿈치 ${deg(flex)}`);
    }
    expect(report(bad)).toBe('OK');
  });

  it('타격 스탠스 0~5 모두 몸통을 뚫지 않는다', () => {
    const bad: string[] = [];
    for (let st = 0; st < 6; st++) {
      const p = mkPlayer(st as BattingStance, 1, 'R');
      for (const { u, jp } of sweep('BATTING', p)) {
        for (const [name, sh, el, hand] of [
          ['armL', jp.shoulderL, jp.elbowL, jp.handL],
          ['armR', jp.shoulderR, jp.elbowR, jp.handR],
        ] as const) {
          const d = Math.min(segmentTorsoClearance(sh, el), segmentTorsoClearance(el, hand));
          if (d < TORSO_CLEAR) bad.push(`stance=${st} ${at('BATTING', u)} ${name} ${d.toFixed(3)}`);
        }
      }
    }
    expect(report(bad)).toBe('OK');
  });
});

// --- 보고용 ------------------------------------------------------------------

function deg(rad: number): string {
  return `${((rad * 180) / Math.PI).toFixed(0)}°`;
}

/**
 * 실패를 한 덩어리 문자열로 만든다.
 *
 * 배열로 비교하면 vitest가 diff를 잘라 버려서 정작 필요한 수치를 못 본다.
 * 수백 건이 쏟아질 땐 앞뒤만 남긴다 — 어디서 시작해 어디서 끝나는지만 알면 된다.
 */
function report(bad: string[]): string {
  if (!bad.length) return 'OK';
  const shown = bad.length <= 8 ? bad : [...bad.slice(0, 5), `…(총 ${bad.length}건)`, ...bad.slice(-2)];
  return shown.join('\n');
}
