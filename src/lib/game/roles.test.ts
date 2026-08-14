import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { autoLineup, generateTeam, pitcherScore, playerScore } from './generator';
import { createDrawnPlayer } from './shop';
import { rosterIssues } from './roster';
import { bullpenCandidates, changePitcher, createGame } from './engine';
import { ATHLETIC_KEYS, HITTING_KEYS } from './training';
import { DEFAULT_SETTINGS } from './types';
import type { GameState, Player, Team } from './types';

/**
 * 타자와 투수의 경계.
 *
 * 두 규칙이 서로를 떠받친다: **투수는 타석에 서지 않고(지명타자 고정), 타자는 마운드에
 * 오르지 않는다.** 그래서 훈련도 각자 것만 하면 되고, 아무도 키운 적 없는 능력치가
 * 승부에 끼어드는 일이 없다. 한쪽이 무너지면 훈련 화면이 다시 거짓말을 시작한다.
 */

function team(seed = 'roles'): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid: 'u1' });
}

function game(seed = 'roles-game'): GameState {
  return createGame(team('roles-away'), team('roles-home'), DEFAULT_SETTINGS, seed);
}

/** 상점에서 뽑은 선수 n명의 종합 지표 */
function drawnOvr(kind: Player['kind'], tier: Team['players'][number]['tier'], n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    playerScore(
      createDrawnPlayer(new Rng(seedFromString(`drawn-${kind}-${tier}-${i}`)), {
        tier,
        kind,
        number: 20 + (i % 60),
      }),
    ),
  );
}

describe('투수는 타석에 서지 않는다', () => {
  it('자동 타순 9자리가 모두 타자다', () => {
    for (let s = 0; s < 20; s++) {
      const t = team(`lineup-${s}`);
      const byId = new Map(t.players.map((p) => [p.id, p]));
      const lineup = autoLineup(t);
      expect(lineup).toHaveLength(9);
      expect(lineup.every((id) => byId.get(id)?.kind === 'BATTER')).toBe(true);
    }
  });

  it('타순에 투수를 넣으면 출전이 막힌다', () => {
    const t = team();
    const arm = t.players.find((p) => p.kind === 'PITCHER')!;
    const withPitcher: Team = { ...t, lineup: [arm.id, ...t.lineup.slice(1)] };
    expect(rosterIssues(withPitcher).join()).toContain(arm.name);
  });

  it('경기가 시작된 타순에도 투수가 없다', () => {
    const s = game();
    for (const side of ['away', 'home'] as const) {
      const t = s[side];
      expect(t.lineup.every((id) => t.roster[id]?.kind === 'BATTER')).toBe(true);
      // 선발 투수는 마운드에만 있고 타순에는 없다
      expect(t.lineup).not.toContain(t.pitcherId);
    }
  });
});

describe('타자는 마운드에 오르지 않는다', () => {
  it('창단 선수 중 투구 능력을 가진 쪽은 투수뿐이다', () => {
    for (let s = 0; s < 20; s++) {
      const t = team(`arsenal-${s}`);
      for (const p of t.players) {
        expect(!!p.pitching).toBe(p.kind === 'PITCHER');
      }
    }
  });

  it('불펜 후보에 타자가 섞이지 않는다', () => {
    const s = game();
    for (const side of ['away', 'home'] as const) {
      const cands = bullpenCandidates(s, side);
      expect(cands.length).toBeGreaterThan(0);
      expect(cands.every((p) => p.kind === 'PITCHER')).toBe(true);
    }
  });

  it('타자를 투수로 교체하려 해도 마운드가 바뀌지 않는다', () => {
    const s = game();
    const before = s.away.pitcherId;
    // 타순 밖의 벤치 타자 — 다른 거절 사유(타순 포함/이미 등판)에 걸리지 않는 후보다.
    const bench = Object.values(s.away.roster).find(
      (p) => p.kind === 'BATTER' && !s.away.lineup.includes(p.id),
    )!;
    expect(bench).toBeDefined();

    const after = changePitcher(s, 'away', bench.id);
    expect(after.away.pitcherId).toBe(before);
    expect(after.away.defense.P).toBe(before);
  });

  it('예전 저장본처럼 야수가 투구 능력을 들고 있어도 마운드에 세우지 않는다', () => {
    const s = game();
    const before = s.away.pitcherId;
    const bench = Object.values(s.away.roster).find(
      (p) => p.kind === 'BATTER' && !s.away.lineup.includes(p.id),
    )!;
    // 비상 등판용 직구를 쥐여 주던 시절의 데이터. kind가 아니라 pitching만 보면 통과한다.
    bench.pitching = { stamina: 22, arsenal: { FOURSEAM: { velocity: 30, control: 20, movement: 15 } } };

    expect(changePitcher(s, 'away', bench.id).away.pitcherId).toBe(before);
  });
});

/**
 * 종합 지표(OVR)는 그 선수가 **훈련해서 올릴 수 있는 것**을 세야 한다.
 * 안 그러면 수비 훈련에 포인트를 부어도 카드의 숫자가 안 움직여, 값어치 표시가 아니라
 * 버그로 읽힌다.
 */
describe('종합 지표가 투수의 수비를 센다', () => {
  const arm = (over: Partial<Player> = {}): Player => ({
    ...generateTeam(new Rng(seedFromString('ovr')), { ownerUid: 'u1' }).players.find(
      (p) => p.kind === 'PITCHER',
    )!,
    ...over,
  });

  it('수비 세 항목이 전부 지표에 반영된다', () => {
    const base = arm();
    for (const k of ATHLETIC_KEYS) {
      const better = arm({ batting: { ...base.batting, [k]: base.batting[k] + 25 } });
      expect(pitcherScore(better)).toBeGreaterThan(pitcherScore(base));
    }
  });

  it('수비 훈련을 하면 표시되는 종합도 실제로 움직인다', () => {
    // 항목별로는 송구가 가장 가벼워(0.07) 반올림에 묻힐 수 있다. 훈련 화면은 세 항목을
    // 한 묶음으로 열어 주므로, 묶음으로 올렸을 때 화면의 정수가 움직이는지를 본다.
    const base = arm();
    const trained = arm({
      batting: Object.fromEntries(
        Object.entries(base.batting).map(([k, v]) => [
          k,
          (ATHLETIC_KEYS as string[]).includes(k) ? v + 15 : v,
        ]),
      ) as typeof base.batting,
    });
    expect(playerScore(trained)).toBeGreaterThan(playerScore(base));
  });

  it('타석 능력치는 종합을 움직이지 않는다', () => {
    const base = arm();
    for (const k of HITTING_KEYS) {
      const better = arm({ batting: { ...base.batting, [k]: base.batting[k] + 25 } });
      expect(pitcherScore(better)).toBe(pitcherScore(base));
      expect(playerScore(better)).toBe(playerScore(base));
    }
  });

  it('구종·스태미나가 수비보다 여전히 훨씬 크게 움직인다', () => {
    // 수비를 세되, 마운드 위의 일을 밀어내지는 않아야 한다.
    const base = arm();
    const defense = arm({ batting: { ...base.batting, speed: 99, fielding: 99, arm: 99 } });
    const stuff = arm({
      pitching: {
        ...base.pitching!,
        arsenal: Object.fromEntries(
          Object.entries(base.pitching!.arsenal).map(([t, a]) => [
            t,
            { velocity: a!.velocity + 20, control: a!.control + 20, movement: a!.movement + 20 },
          ]),
        ),
      },
    });
    expect(playerScore(stuff) - playerScore(base)).toBeGreaterThan(
      playerScore(defense) - playerScore(base),
    );
  });

  it('제일 좋은 투수들이 100에 뭉개지지 않는다', () => {
    // 예전 눈금(2.9)에서는 상점 S등급의 45%가 clamp에 걸려 전부 100으로 보였다.
    const ovr = drawnOvr('PITCHER', 'S', 300);
    expect(ovr.filter((v) => v >= 100).length).toBe(0);
    // 그 등급 안에서 서로 구분이 돼야 한다 (예전에는 13가지 값밖에 없었다)
    expect(new Set(ovr).size).toBeGreaterThan(15);
  });
});

/**
 * 타자와 투수의 종합 지표가 **같은 눈금 위에 있는가.**
 *
 * 예전에는 창단 투수 중앙값 68 · 창단 타자 중앙값 50이라, 같은 화면에 나란히 놓인 두 숫자가
 * 같은 값어치를 뜻하지 않았다. 로스터를 보면 투수진만 강해 보이는 착시가 생긴다.
 */
describe('타자와 투수가 같은 눈금을 쓴다', () => {
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

  it('창단 선수의 중앙값이 서로 5점 안에 있다', () => {
    const by: Record<string, number[]> = { PITCHER: [], BATTER: [] };
    for (let i = 0; i < 60; i++) {
      for (const p of team(`scale-${i}`).players) by[p.kind].push(playerScore(p));
    }
    expect(Math.abs(median(by.PITCHER) - median(by.BATTER))).toBeLessThanOrEqual(5);
  });

  it('상점 S등급의 중앙값도 서로 5점 안에 있다', () => {
    const arms = drawnOvr('PITCHER', 'S', 300);
    const bats = drawnOvr('BATTER', 'S', 300);
    expect(Math.abs(median(arms) - median(bats))).toBeLessThanOrEqual(5);
  });

  it('성장 방향이 같다 — 두 종류 모두 C에서 S로 갈수록 오른다', () => {
    for (const kind of ['PITCHER', 'BATTER'] as const) {
      const ladder = (['C', 'B', 'A', 'S'] as const).map((t) => median(drawnOvr(kind, t, 120)));
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
      }
    }
  });
});
