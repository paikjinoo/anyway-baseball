import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam, generatePlayer } from './generator';
import { simulateGame } from './league';
import {
  PLATOON_OPPOSITE_HAND,
  PLATOON_SAME_HAND,
  effectiveBatSide,
  platoonRadiusMult,
  readPitchLocation,
} from './batting';
import { computePitch } from './pitching';
import { AIM_LIMIT, ALL_PITCH_TYPES } from './constants';
import { DEFAULT_SETTINGS } from './types';
import type { Handedness, PitchTrajectory, Player } from './types';

function batter(bats: Player['bats']): Player {
  const p = generatePlayer(new Rng(seedFromString(`bat-${bats}`)), { position: 'CF', number: 8 });
  return { ...p, bats };
}

function pitcher(throws: Handedness): Player {
  const p = generatePlayer(new Rng(seedFromString(`pit-${throws}`)), {
    position: 'P',
    role: 'SP',
    number: 21,
  });
  return { ...p, throws };
}

describe('effectiveBatSide', () => {
  it('좌타·우타는 투수와 무관하게 그대로다', () => {
    for (const t of ['L', 'R'] as Handedness[]) {
      expect(effectiveBatSide(batter('L'), pitcher(t))).toBe('L');
      expect(effectiveBatSide(batter('R'), pitcher(t))).toBe('R');
    }
  });

  it('스위치히터는 투수 반대편에 선다', () => {
    // 예전에는 `bats === 'S' && true`로 항상 좌타 고정이었다. 상성이 붙은 지금은
    // 그대로 두면 스위치히터가 우투수를 상대로 영구히 불리해진다.
    expect(effectiveBatSide(batter('S'), pitcher('R'))).toBe('L');
    expect(effectiveBatSide(batter('S'), pitcher('L'))).toBe('R');
  });

  it('스위치히터는 언제나 이측 매치업을 얻는다', () => {
    for (const t of ['L', 'R'] as Handedness[]) {
      expect(platoonRadiusMult(batter('S'), pitcher(t))).toBe(PLATOON_OPPOSITE_HAND);
    }
  });
});

describe('좌우 상성', () => {
  it('같은 손끼리는 불리하고 엇갈리면 유리하다', () => {
    expect(platoonRadiusMult(batter('L'), pitcher('L'))).toBe(PLATOON_SAME_HAND);
    expect(platoonRadiusMult(batter('R'), pitcher('R'))).toBe(PLATOON_SAME_HAND);
    expect(platoonRadiusMult(batter('L'), pitcher('R'))).toBe(PLATOON_OPPOSITE_HAND);
    expect(platoonRadiusMult(batter('R'), pitcher('L'))).toBe(PLATOON_OPPOSITE_HAND);
    expect(PLATOON_SAME_HAND).toBeLessThan(1);
    expect(PLATOON_OPPOSITE_HAND).toBeGreaterThan(1);
  });

  /**
   * 상성이 실제 성적으로 나타나는지 헤드리스로 잰다.
   *
   * 상수만 확인하면 "값은 있는데 판정에 안 쓰이는" 상태를 못 잡는다. 실제 MLB의
   * 좌우 스플릿은 타율 15~25포인트 수준이다.
   *
   * ---------------------------------------------------------------------------
   * ⚠ 경기 수와 임계값을 **같이** 봐야 한다. 이건 통계 검정이라 표본이 줄면 임계값도
   * 같이 내려가야 한다.
   *
   * 원래 180경기 · 임계 0.008이었는데, 그 표본(동측 6600타수 / 이측 5200타수)에서
   * 두 타율 차의 표준오차가 **정확히 0.0080**이다. 이 엔진의 실제 격차는 0.0090이므로
   * 신호와 노이즈가 같은 크기였고, 독립 시드 블록 4개를 재면 0.0068 / 0.0129 / 0.0052 /
   * 0.0111로 절반이 임계값 아래로 떨어졌다. **좌우 판정과 무관한 변경이 RNG 스트림만
   * 흔들어도 빨개지는 상태였다.**
   *
   * 540경기로 늘려 표준오차를 0.0046으로 낮추고 임계값을 0.002로 잡았다. 상성이 아예
   * 배선에서 빠지면 격차는 0이 되고, 그때 이 단정은 2/3 확률로 잡는다 — 강한 검정은
   * 아니지만 위의 상수 테스트가 배선 자체를 따로 지킨다.
   *
   * 격차 0.0090은 주석이 적어 둔 MLB 15~25포인트보다 작다. 상성 강도 자체를 올릴지는
   * 별개 문제고, 그때는 이 임계값도 같이 올려야 한다.
   * ---------------------------------------------------------------------------
   */
  it('540경기 실측에서 이측 타율이 동측보다 높다', () => {
    const same = [0, 0];
    const opp = [0, 0];

    for (let i = 0; i < 540; i++) {
      const rng = new Rng(seedFromString(`bal-${i}`));
      const away = generateTeam(rng, { ownerUid: 'a', id: `a${i}` });
      const home = generateTeam(rng, { ownerUid: 'b', id: `b${i}` });
      const res = simulateGame(away, home, DEFAULT_SETTINGS, `bal-${i}`);

      for (const side of ['away', 'home'] as const) {
        for (const p of Object.values(res.state[side].roster)) {
          // 스위치히터는 항상 이측이라 비교에서 뺀다
          if (p.kind !== 'BATTER' || p.bats === 'S' || !p.splits) continue;
          const s = p.bats === 'L' ? p.splits.vsL : p.splits.vsR;
          const o = p.bats === 'L' ? p.splits.vsR : p.splits.vsL;
          if (s) { same[0] += s[0]; same[1] += s[1]; }
          if (o) { opp[0] += o[0]; opp[1] += o[1]; }
        }
      }
    }

    expect(same[0]).toBeGreaterThan(1000);
    expect(opp[0]).toBeGreaterThan(1000);

    const sameAvg = same[1] / same[0];
    const oppAvg = opp[1] / opp[0];
    const gap = oppAvg - sameAvg;

    expect(gap).toBeGreaterThan(0.002);
    expect(gap).toBeLessThan(0.035);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 선구 표시 (readPitchLocation)
// ---------------------------------------------------------------------------

/** 눈만 다른 같은 타자 */
function eyed(eye: number): Player {
  const p = generatePlayer(new Rng(seedFromString('read-batter')), { position: 'LF', number: 3 });
  // 자세 보정이 섞이지 않도록 스탠다드로 고정한다 (선구안만 비교하려는 테스트다)
  return { ...p, stance: 0, batting: { ...p.batting, eye } };
}

/** 여러 코스·구종의 궤적. 한 공만 보면 난수 한 번을 재는 셈이라 표본을 넓힌다. */
function trajectories(n: number): PitchTrajectory[] {
  const pit = pitcher('R');
  const rng = new Rng(seedFromString('read-traj'));
  return Array.from({ length: n }, (_, i) => {
    const type = ALL_PITCH_TYPES[i % ALL_PITCH_TYPES.length];
    const cmd = { type, targetX: rng.range(-0.9, 0.9), targetY: rng.range(-0.9, 0.9), quickPitch: false };
    return computePitch(rng, pit, cmd, 0);
  });
}

/**
 * 예상 지점과 실제 도착점의 거리 평균.
 *
 * 조준 한계(AIM_LIMIT) 밖으로 빠진 공은 뺀다 — 표시가 한계선에 붙어 서는 것이
 * 오차로 잡혀서, 재려는 것(선구안이 만드는 흔들림)이 아니라 제구 산포를 재게 된다.
 */
function meanReadError(eye: number, trajs: PitchTrajectory[]): number {
  const b = eyed(eye);
  const inRange = trajs.filter(
    (t) => Math.abs(t.zoneX) < AIM_LIMIT - 0.6 && Math.abs(t.zoneY) < AIM_LIMIT - 0.6,
  );
  expect(inRange.length).toBeGreaterThan(trajs.length * 0.5);
  const sum = inRange.reduce((acc, t) => {
    const r = readPitchLocation(b, t);
    return acc + Math.hypot(r.x - t.zoneX, r.y - t.zoneY);
  }, 0);
  return sum / inRange.length;
}

describe('선구 표시', () => {
  it('같은 공은 몇 번을 읽어도 같은 자리다', () => {
    // 화면 두 곳(3D 존·조준 패널)이 매 프레임 따로 부르므로, 여기가 흔들리면
    // 표시가 떨리고 두 화면이 서로 다른 지점을 가리킨다.
    const b = eyed(50);
    for (const t of trajectories(9)) {
      const first = readPitchLocation(b, t);
      for (let i = 0; i < 5; i++) expect(readPitchLocation(b, t)).toEqual(first);
    }
  });

  it('선구안이 높을수록 실제 도착점에 가깝다', () => {
    const trajs = trajectories(400);
    const bad = meanReadError(10, trajs);
    const mid = meanReadError(50, trajs);
    const good = meanReadError(95, trajs);

    expect(good).toBeLessThan(mid);
    expect(mid).toBeLessThan(bad);
    // 존 반폭이 1이다. 실측은 선구안 10 → 0.33 · 50 → 0.21 · 95 → 0.08이고,
    // 임계값은 그 사이를 넉넉히 비켜 잡았다 (기울기가 절반으로 눌리면 걸린다).
    expect(good).toBeLessThan(0.13);
    expect(bad).toBeGreaterThan(0.25);
  });

  it('오차 원은 선구안과 함께 줄고, 어려운 구종에서 커진다', () => {
    const [fast] = trajectories(1); // ALL_PITCH_TYPES[0] = 직구
    const knuckle = computePitch(
      new Rng(seedFromString('read-knuckle')),
      pitcher('R'),
      { type: 'KNUCKLE', targetX: 0, targetY: 0, quickPitch: false },
      0,
    );
    expect(readPitchLocation(eyed(95), fast).radius).toBeLessThan(
      readPitchLocation(eyed(10), fast).radius,
    );
    expect(readPitchLocation(eyed(50), knuckle).radius).toBeGreaterThan(
      readPitchLocation(eyed(50), fast).radius,
    );
  });

  it('조준할 수 없는 곳은 가리키지 않는다', () => {
    // 한참 빠진 공(존 좌표 4.0)이라도 표시는 조준 한계 안에 머문다.
    const [t] = trajectories(1);
    const wild = { ...t, zoneX: 4, zoneY: -4 };
    for (const eye of [1, 50, 99]) {
      const r = readPitchLocation(eyed(eye), wild);
      expect(Math.abs(r.x)).toBeLessThanOrEqual(AIM_LIMIT);
      expect(Math.abs(r.y)).toBeLessThanOrEqual(AIM_LIMIT);
    }
  });
});
