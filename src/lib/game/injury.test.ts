import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generatePlayer, generateTeam, autoLineup, hitterScore, ROTATION_SIZE } from './generator';
import {
  INJURY_PENALTY_MAX,
  INJURY_PENALTY_PER_GAME,
  injuryPenalty,
  withInjuryPenalty,
} from './batting';
import { MAX_CLOSERS, benchBatters, closers, rosterIssues, swapIntoLineup } from './roster';
import type { PitchType, Player, Team } from './types';

function batter(overrides: Partial<Player> = {}): Player {
  const rng = new Rng(seedFromString('inj-batter'));
  return { ...generatePlayer(rng, { position: 'CF', number: 8 }), ...overrides };
}

function pitcher(overrides: Partial<Player> = {}): Player {
  const rng = new Rng(seedFromString('inj-pitcher'));
  return { ...generatePlayer(rng, { position: 'P', role: 'SP', number: 21 }), ...overrides };
}

function team(seed = 'inj-team'): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid: 'u1' });
}

const hurt = (games: number) => ({ gamesLeft: games, reason: '사구 타박' });
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('부상 = 컨디션 난조', () => {
  it('성한 선수는 보정이 0이고 원본 객체를 그대로 돌려준다', () => {
    const p = batter();
    expect(injuryPenalty(p)).toBe(0);
    expect(withInjuryPenalty(p)).toBe(p);
  });

  it('남은 경기 수에 비례해 깎인다', () => {
    for (let g = 1; g <= 5; g++) {
      expect(injuryPenalty(batter({ injury: hurt(g) }))).toBeCloseTo(
        Math.min(INJURY_PENALTY_MAX, g * INJURY_PENALTY_PER_GAME),
        10,
      );
    }
  });

  it('회복이 가까울수록 페널티가 옅어진다', () => {
    const deep = injuryPenalty(batter({ injury: hurt(5) }));
    const mid = injuryPenalty(batter({ injury: hurt(3) }));
    const almost = injuryPenalty(batter({ injury: hurt(1) }));
    expect(deep).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(almost);
  });

  it('아무리 심해도 상한을 넘겨 깎지 않는다', () => {
    expect(injuryPenalty(batter({ injury: hurt(99) }))).toBe(INJURY_PENALTY_MAX);
  });

  it('타격 능력치 여섯 개가 전부 깎인다', () => {
    const p = batter();
    const injured = withInjuryPenalty({ ...p, injury: hurt(3) });
    const keys = Object.keys(p.batting) as (keyof typeof p.batting)[];
    for (const k of keys) {
      expect(injured.batting[k]).toBeLessThan(p.batting[k]);
    }
    expect(sum(Object.values(injured.batting))).toBeLessThan(sum(Object.values(p.batting)));
  });

  it('투수는 스태미나와 모든 구종 능력치가 함께 깎인다', () => {
    const p = pitcher();
    const injured = withInjuryPenalty({ ...p, injury: hurt(4) });
    expect(injured.pitching!.stamina).toBeLessThan(p.pitching!.stamina);
    for (const [type, a] of Object.entries(p.pitching!.arsenal)) {
      if (!a) continue;
      const b = injured.pitching!.arsenal[type as PitchType]!;
      expect(b.velocity).toBeLessThan(a.velocity);
      expect(b.control).toBeLessThan(a.control);
      expect(b.movement).toBeLessThan(a.movement);
    }
  });

  it('능력치를 0 이하로 떨어뜨리지 않는다', () => {
    const weak = batter({
      injury: hurt(5),
      batting: { contact: 1, power: 1, eye: 1, speed: 1, fielding: 1, arm: 1 },
    });
    for (const v of Object.values(withInjuryPenalty(weak).batting)) {
      expect(v).toBeGreaterThanOrEqual(1);
    }
  });

  it('원본 선수를 바꾸지 않는다', () => {
    const p = batter({ injury: hurt(3) });
    const before = structuredClone(p);
    withInjuryPenalty(p);
    expect(p).toEqual(before);
  });
});

describe('부상 선수도 경기에 나간다', () => {
  it('타순에 부상 선수가 있어도 경기를 막지 않는다', () => {
    const t = team();
    expect(rosterIssues(t)).toEqual([]);
    const injured: Team = {
      ...t,
      players: t.players.map((p) => (p.id === t.lineup[0] ? { ...p, injury: hurt(3) } : p)),
    };
    // 예전에는 여기서 "타순에 부상 선수가 있습니다"로 경기가 잠겼다.
    // 회복은 경기를 끝내야 진행되므로(matchReward), 막으면 빠져나올 방법이 없다.
    expect(rosterIssues(injured)).toEqual([]);
  });

  it('타자 전원이 부상이어도 경기를 편성할 수 있다', () => {
    const t = team();
    const allHurt: Team = {
      ...t,
      players: t.players.map((p) => (p.kind === 'BATTER' ? { ...p, injury: hurt(2) } : p)),
    };
    expect(rosterIssues(allHurt)).toEqual([]);
    expect(autoLineup(allHurt)).toHaveLength(9);
  });

  it('자동 타순은 부상자를 빼지 않고 뒤로 미룬다', () => {
    const t = team();
    const batters = t.players.filter((p) => p.kind === 'BATTER');
    // 타자를 정확히 9명만 남기면, 부상자를 빼는 구현에서는 9명을 못 채운다
    const tight: Team = {
      ...t,
      players: [...t.players.filter((p) => p.kind === 'PITCHER'), ...batters.slice(0, 9)],
    };
    const withInjury: Team = {
      ...tight,
      players: tight.players.map((p, i) => (i === tight.players.length - 1 ? { ...p, injury: hurt(3) } : p)),
    };
    expect(autoLineup(withInjury)).toHaveLength(9);
  });

  it('부상 선수도 벤치 후보와 타순 교체 대상에 남는다', () => {
    const t = team();
    const bench = benchBatters(t)[0];
    const withInjury: Team = {
      ...t,
      players: t.players.map((p) => (p.id === bench.id ? { ...p, injury: hurt(2) } : p)),
    };
    expect(benchBatters(withInjury).some((p) => p.id === bench.id)).toBe(true);
    expect(swapIntoLineup(withInjury, 0, bench.id).ok).toBe(true);
  });

  it('같은 포지션에 성한 선수가 있으면 자동 타순이 그쪽을 먼저 쓴다', () => {
    const t = team();
    // 창단 23명에는 포수가 둘이다. 능력치를 똑같이 맞춰 두면 유일한 차이가 부상뿐이 된다.
    const [a, b] = t.players.filter((p) => p.position === 'C');
    const stats = { ...a.batting };
    const patched: Team = {
      ...t,
      players: t.players.map((p) =>
        p.id === a.id
          ? { ...p, batting: { ...stats }, injury: hurt(5) }
          : p.id === b.id
            ? { ...p, batting: { ...stats } }
            : p,
      ),
    };

    // 자동 편성이 보는 값 자체가 갈린다
    const scoreOf = (id: string) =>
      hitterScore(withInjuryPenalty(patched.players.find((p) => p.id === id)!));
    expect(scoreOf(a.id)).toBeLessThan(scoreOf(b.id));

    // 그래서 포수 자리는 성한 쪽이 가져간다
    expect(autoLineup(patched)).toContain(b.id);
  });
});

describe('마무리 정원', () => {
  it('마무리를 두 명까지 보유할 수 있다', () => {
    expect(MAX_CLOSERS).toBe(2);
    const t = team();
    const rp = t.players.filter((p) => p.role === 'RP');
    const two: Team = {
      ...t,
      players: t.players.map((p) => (p.id === rp[0].id ? { ...p, role: 'CP' as const } : p)),
    };
    expect(closers(two)).toHaveLength(2);
    expect(rosterIssues(two)).toEqual([]);
  });

  it('세 명째부터는 막는다', () => {
    const t = team();
    const rp = t.players.filter((p) => p.role === 'RP');
    const three: Team = {
      ...t,
      players: t.players.map((p) =>
        p.id === rp[0].id || p.id === rp[1].id ? { ...p, role: 'CP' as const } : p,
      ),
    };
    expect(rosterIssues(three).join()).toContain('마무리');
  });
});

describe('창단 로스터', () => {
  const founded = (seed: string) =>
    generateTeam(new Rng(seedFromString(seed)), { ownerUid: 'u1', plan: 'FOUNDING' });

  it('17명이고 구성이 정확하다 (타자 10 · 선발 4 · 중간계투 1 · 마무리 2)', () => {
    const t = founded('f1');
    expect(t.players).toHaveLength(17);
    expect(t.players.filter((p) => p.kind === 'BATTER')).toHaveLength(10);
    expect(t.players.filter((p) => p.role === 'SP')).toHaveLength(ROTATION_SIZE);
    expect(t.players.filter((p) => p.role === 'RP')).toHaveLength(1);
    expect(t.players.filter((p) => p.role === 'CP')).toHaveLength(2);
  });

  it('창단 직후 바로 경기를 시작할 수 있다', () => {
    for (let s = 0; s < 30; s++) {
      const t = founded(`ok-${s}`);
      expect(rosterIssues(t)).toEqual([]);
    }
  });

  it('벤치 타자가 한 명 남아 교체 카드가 살아 있다', () => {
    const t = founded('bench');
    expect(benchBatters(t).length).toBeGreaterThanOrEqual(1);
  });

  it('타순 9자리를 모두 다른 선수로 채운다', () => {
    const t = founded('lineup');
    expect(new Set(t.lineup).size).toBe(9);
  });

  it('CPU·리그용 기본 로스터는 23명 그대로다', () => {
    // 창단만 줄인다. 상대팀까지 얇아지면 후반에 불펜이 비어 난이도가 조용히 내려간다.
    expect(team().players).toHaveLength(23);
  });

  it('등번호가 겹치지 않는다', () => {
    const t = founded('num');
    expect(new Set(t.players.map((p) => p.number)).size).toBe(t.players.length);
  });
});
