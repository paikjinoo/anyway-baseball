import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generatePlayer, generateTeam } from './generator';
import {
  TIER_MAX_LEVEL,
  TIER_ORDER,
  TIER_STAT_CAP,
  TIER_UP_GOLD,
  TP_PER_LEVEL,
  naturalTrainingPoints,
  nextTier,
  statCap,
  upgradeTier,
} from './progression';
import { autoInvest } from './training';
import { pitchSlotsUsed, pitchSlots } from './progression';
import { rosterIssues } from './roster';
import { useItem } from './items';
import {
  BANNERS,
  BANNER_ORDER,
  MIN_BATTERS,
  MIN_PITCHERS,
  createDrawnPlayer,
  drawPlayer,
  releasePlayer,
  releaseIssue,
  releaseValue,
  rollTier,
} from './shop';
import type { Player, Team, Tier } from './types';

function team(seed = 'shop-team'): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid: 'u1' });
}

function rich(gold = 5_000_000, seed = 'shop-team'): Team {
  return { ...team(seed), gold };
}

/** rollTier는 next()만 소비한다. 누적 확률 경계를 정확히 짚기 위한 고정 난수. */
function fixedRng(v: number): Rng {
  return { next: () => v } as unknown as Rng;
}

/** 티어·레벨만 지정한 가짜 선수. 환급액 계산 검증용. */
function fake(tier: Tier, level: number): Player {
  const rng = new Rng(seedFromString('shop-fake'));
  return { ...generatePlayer(rng, { position: 'CF', number: 8 }), tier, level };
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const battingSum = (p: Player) => sum(Object.values(p.batting));
const sd = (a: number[]) => {
  const m = sum(a) / a.length;
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / a.length);
};

function drawnOf(tier: Tier, kind: 'PITCHER' | 'BATTER', seed = 'drawn'): Player {
  return createDrawnPlayer(new Rng(seedFromString(seed)), { tier, kind, number: 99 });
}

// ---------------------------------------------------------------------------

describe('배너 확률표', () => {
  it('모든 배너의 확률 합이 정확히 1이다', () => {
    for (const id of BANNER_ORDER) {
      const total = sum(BANNERS[id].rates.map((r) => r.rate));
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('일반 뽑기에서는 S등급이, 프리미엄에서는 C등급이 절대 나오지 않는다', () => {
    const rng = new Rng(seedFromString('never'));
    for (let i = 0; i < 20_000; i++) {
      expect(rollTier(rng, BANNERS.NORMAL)).not.toBe('S');
      expect(rollTier(rng, BANNERS.PREMIUM)).not.toBe('C');
    }
  });

  it('20,000회 추첨의 티어 분포가 확률표와 ±2%p 안에서 일치한다', () => {
    const N = 20_000;
    for (const id of BANNER_ORDER) {
      const banner = BANNERS[id];
      const rng = new Rng(seedFromString(`rates-${id}`));
      const count: Partial<Record<Tier, number>> = {};
      for (let i = 0; i < N; i++) {
        const t = rollTier(rng, banner);
        count[t] = (count[t] ?? 0) + 1;
      }
      for (const { tier, rate } of banner.rates) {
        expect(Math.abs((count[tier] ?? 0) / N - rate)).toBeLessThan(0.02);
      }
    }
  });

  it('누적 확률 경계값에서 의도한 티어가 나온다', () => {
    expect(rollTier(fixedRng(0), BANNERS.NORMAL)).toBe('C');
    expect(rollTier(fixedRng(0.4999), BANNERS.NORMAL)).toBe('C');
    expect(rollTier(fixedRng(0.5), BANNERS.NORMAL)).toBe('B');
    expect(rollTier(fixedRng(0.8999), BANNERS.NORMAL)).toBe('B');
    expect(rollTier(fixedRng(0.9), BANNERS.NORMAL)).toBe('A');
    expect(rollTier(fixedRng(0.99999), BANNERS.NORMAL)).toBe('A');

    expect(rollTier(fixedRng(0), BANNERS.PREMIUM)).toBe('B');
    expect(rollTier(fixedRng(0.5), BANNERS.PREMIUM)).toBe('A');
    expect(rollTier(fixedRng(0.9), BANNERS.PREMIUM)).toBe('S');
  });
});

describe('선수 영입', () => {
  it('골드가 부족하면 뽑히지 않고 팀이 그대로다', () => {
    const poor = { ...team(), gold: BANNERS.NORMAL.gold - 1 };
    const r = drawPlayer(poor, 'NORMAL', 'BATTER', 1);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('골드');
    expect(r.team).toBe(poor);
  });

  it('비용만큼 골드가 빠지고 선수가 정확히 한 명 늘어난다', () => {
    const t = rich(100_000);
    const r = drawPlayer(t, 'PREMIUM', 'BATTER', 42);
    expect(r.ok).toBe(true);
    expect(r.team.gold).toBe(100_000 - BANNERS.PREMIUM.gold);
    expect(r.team.players.length).toBe(t.players.length + 1);
    expect(r.team.players.at(-1)!.id).toBe(r.player!.id);
  });

  it('같은 시드는 같은 선수를 만든다', () => {
    const t = rich();
    const a = drawPlayer(t, 'PREMIUM', 'PITCHER', 777);
    const b = drawPlayer(t, 'PREMIUM', 'PITCHER', 777);
    expect(a.player).toEqual(b.player);
  });

  it('투수를 고르면 투수가, 타자를 고르면 타자가 나온다', () => {
    const t = rich();
    for (let s = 1; s <= 30; s++) {
      expect(drawPlayer(t, 'NORMAL', 'PITCHER', s).player!.kind).toBe('PITCHER');
      expect(drawPlayer(t, 'NORMAL', 'BATTER', s).player!.kind).toBe('BATTER');
    }
  });

  it('영입한 투수는 중간계투로 들어와 선발 정원을 깨지 않는다', () => {
    let t = rich();
    for (let s = 1; s <= 6; s++) t = drawPlayer(t, 'PREMIUM', 'PITCHER', s).team;
    expect(t.players.filter((p) => p.role === 'SP').length).toBe(4);
    expect(rosterIssues(t)).toEqual([]);
  });

  it('영입 직후에도 rosterIssues가 비어 있고 타순·로테이션이 그대로다', () => {
    const t = rich();
    expect(rosterIssues(t)).toEqual([]);
    const r = drawPlayer(t, 'PREMIUM', 'BATTER', 5);
    expect(rosterIssues(r.team)).toEqual([]);
    expect(r.team.lineup).toEqual(t.lineup);
    expect(r.team.rotation).toEqual(t.rotation);
  });

  it('등번호가 기존 선수와 겹치지 않는다', () => {
    let t = rich();
    for (let s = 1; s <= 40; s++) t = drawPlayer(t, 'NORMAL', 'BATTER', s).team;
    const numbers = t.players.map((p) => p.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('원본 팀 객체를 바꾸지 않는다', () => {
    const t = rich();
    const before = structuredClone(t);
    drawPlayer(t, 'PREMIUM', 'PITCHER', 9);
    expect(t).toEqual(before);
  });
});

describe('티어별 신규 선수', () => {
  it('뽑힌 선수는 항상 그 티어의 1레벨이고 경험치가 0이다', () => {
    for (const tier of TIER_ORDER) {
      const p = drawnOf(tier, 'BATTER', `lv-${tier}`);
      expect(p.tier).toBe(tier);
      expect(p.level).toBe(1);
      expect(p.exp).toBe(0);
    }
  });

  it('C등급 영입은 창단 선수와 능력치가 완전히 같다', () => {
    // C는 자동 투자 예산이 0이므로 창단 경로와 결과가 같아야 한다
    const drawn = createDrawnPlayer(new Rng(seedFromString('c-eq')), {
      tier: 'C',
      kind: 'BATTER',
      number: 99,
    });
    expect(naturalTrainingPoints('C')).toBe(0);
    expect(drawn.trainingPoints).toBe(0);
    expect(drawn.batting).toEqual(drawn.base.batting);
  });

  it('티어가 오를수록 능력치 총합이 커진다', () => {
    const avg = (tier: Tier) => {
      let total = 0;
      for (let s = 0; s < 40; s++) total += battingSum(drawnOf(tier, 'BATTER', `grow-${tier}-${s}`));
      return total / 40;
    };
    const [c, b, a, s] = TIER_ORDER.map(avg);
    expect(b).toBeGreaterThan(c);
    expect(a).toBeGreaterThan(b);
    expect(s).toBeGreaterThan(a);
    // 자연 성장 경로(300 → 327 → 380 → 442)와 크게 어긋나지 않아야 한다
    expect(s / c).toBeGreaterThan(1.3);
  });

  it('자동 투자가 상한 아래 능력치를 상한 위로 밀어 올리지 않는다', () => {
    // 상한은 훈련만 막는다 — 생성 단계의 distribute는 [15,95]라 갓 나온 C 선수도
    // 65를 넘을 수 있다. 그러니 "모든 값 ≤ 상한"이 아니라 "상한을 넘겨 올리지 않는다"가
    // 검증할 성질이다.
    for (const tier of TIER_ORDER) {
      for (let s = 0; s < 10; s++) {
        const p = drawnOf(tier, 'BATTER', `cap-${tier}-${s}`);
        const cap = statCap(p);
        const keys = Object.keys(p.batting) as (keyof typeof p.batting)[];
        for (const k of keys) {
          const generated = p.base.batting[k];
          // 투자로 올랐다면 상한을 넘지 않았어야 하고, 원래 상한 위였다면 그대로여야 한다
          if (generated > cap) continue;
          expect(p.batting[k]).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  it('구간별 투자는 중간 티어 상한에 걸려 일괄 투자와 결과가 다르다', () => {
    const base: Player = {
      ...generatePlayer(new Rng(seedFromString('phased')), { position: 'CF', number: 8 }),
      potential: 96,
    };

    // 자연 경로: C(상한 65) → B(78) → A(89) 구간을 차례로 겪는다
    let phased = base;
    for (const t of ['C', 'B', 'A'] as Tier[]) {
      phased = autoInvest({ ...phased, tier: t }, (TIER_MAX_LEVEL[t] - 1) * TP_PER_LEVEL[t]).player;
    }
    // 잘못된 방식: 최종 상한으로 한 번에 투자
    const oneShot = autoInvest({ ...base, tier: 'S' }, naturalTrainingPoints('S')).player;

    expect(phased.batting).not.toEqual(oneShot.batting);
    // 일괄 투자는 C 구간에서 65에 막혔어야 할 최고 능력치를 그대로 밀어 올린다
    expect(Math.max(...Object.values(oneShot.batting))).toBeGreaterThan(
      Math.max(...Object.values(phased.batting)),
    );
  });

  it('잠재력이 티어 상한을 헛되게 만들지 않는다', () => {
    // S를 뺀 나머지는 잠재력 하한이 그 티어 상한이라 statCap이 티어 상한과 같아야 한다
    for (const tier of ['B', 'A'] as Tier[]) {
      for (let s = 0; s < 20; s++) {
        const p = drawnOf(tier, 'BATTER', `pot-${tier}-${s}`);
        expect(statCap(p)).toBe(TIER_STAT_CAP[tier]);
      }
    }
  });

  it('투수는 티어의 구종 슬롯을 정확히 채우고 직구를 항상 갖는다', () => {
    for (const tier of TIER_ORDER) {
      for (let s = 0; s < 10; s++) {
        const p = drawnOf(tier, 'PITCHER', `arsenal-${tier}-${s}`);
        expect(pitchSlotsUsed(p)).toBe(pitchSlots(p));
        expect(p.pitching?.arsenal.FOURSEAM).toBeTruthy();
      }
    }
  });

  it('쓴 포인트 + 남은 포인트 = 그 티어의 자연 누적 TP', () => {
    for (const tier of TIER_ORDER) {
      const p = drawnOf(tier, 'BATTER', `tp-${tier}`);
      // 남은 자투리는 그대로 들고 있고, 나머지는 능력치로 들어갔다
      expect(p.trainingPoints).toBeGreaterThanOrEqual(0);
      expect(p.trainingPoints).toBeLessThanOrEqual(naturalTrainingPoints(tier));
    }
    // S는 예산이 크므로 자투리가 거의 남지 않는다
    expect(drawnOf('S', 'BATTER', 'tp-S').trainingPoints).toBeLessThan(20);
  });

  it('spentPoints·spentGold가 0이고 base가 뽑힌 직후 능력치와 같다', () => {
    for (const tier of TIER_ORDER) {
      const p = drawnOf(tier, 'PITCHER', `base-${tier}`);
      expect(p.spentPoints).toBe(0);
      expect(p.spentGold).toBe(0);
      expect(p.base.batting).toEqual(p.batting);
      expect(p.base.stamina).toBe(p.pitching!.stamina);
      expect(p.base.arsenal).toEqual(p.pitching!.arsenal);
    }
  });

  it('능력치초기화권을 써도 뽑은 구종이 사라지지 않는다', () => {
    const t = rich();
    const r = drawPlayer(t, 'PREMIUM', 'PITCHER', 31);
    const withItem: Team = { ...r.team, inventory: { RESET_STATS: 1 } };
    const drawn = r.player!;

    // 훈련도 습득도 한 적이 없으므로 초기화권은 쓸 수 없다
    const blocked = useItem(withItem, drawn.id, 'RESET_STATS');
    expect(blocked.ok).toBe(false);

    // 훈련을 한 뒤 초기화하면 정확히 뽑힌 상태로 돌아온다 (구종은 그대로)
    const trained: Team = {
      ...withItem,
      players: withItem.players.map((p) =>
        p.id === drawn.id ? { ...p, spentPoints: 30, trainingPoints: 0 } : p,
      ),
    };
    const reset = useItem(trained, drawn.id, 'RESET_STATS');
    expect(reset.ok).toBe(true);
    const after = reset.team.players.find((p) => p.id === drawn.id)!;
    expect(after.pitching!.arsenal).toEqual(drawn.pitching!.arsenal);
    expect(pitchSlotsUsed(after)).toBe(pitchSlots(after));
  });
});

describe('자동 투자', () => {
  const subject = () =>
    generatePlayer(new Rng(seedFromString('invest')), { position: 'CF', number: 8 });

  it('예산이 0이면 능력치가 하나도 바뀌지 않는다', () => {
    const p = subject();
    const r = autoInvest(p, 0);
    expect(r.spent).toBe(0);
    expect(r.player.batting).toEqual(p.batting);
  });

  it('예산을 초과해 쓰지 않고 상한도 넘지 않는다', () => {
    const p = { ...subject(), tier: 'A' as Tier };
    const budget = 450;
    const r = autoInvest(p, budget);
    expect(r.spent).toBeLessThanOrEqual(budget);
    for (const v of Object.values(r.player.batting)) {
      expect(v).toBeLessThanOrEqual(statCap(p));
    }
  });

  it('싼 능력치만 올려 선수를 평평하게 만들지 않는다', () => {
    const p = { ...subject(), tier: 'S' as Tier, potential: 96 };
    const before = Object.values(p.batting);
    const after = Object.values(autoInvest(p, 1146).player.batting);
    expect(sd(after)).toBeGreaterThan(sd(before) * 0.5);
  });

  it('가장 높았던 능력치가 그대로 가장 높다', () => {
    const p = { ...subject(), tier: 'S' as Tier, potential: 96 };
    const keys = Object.keys(p.batting) as (keyof typeof p.batting)[];
    const topBefore = keys.reduce((a, k) => (p.batting[k] > p.batting[a] ? k : a), keys[0]);
    const out = autoInvest(p, 1146).player;
    const topAfter = keys.reduce((a, k) => (out.batting[k] > out.batting[a] ? k : a), keys[0]);
    expect(topAfter).toBe(topBefore);
  });

  it('trainingPoints / spentPoints를 건드리지 않는다', () => {
    const p = { ...subject(), tier: 'A' as Tier, trainingPoints: 7, spentPoints: 3 };
    const r = autoInvest(p, 450);
    expect(r.player.trainingPoints).toBe(7);
    expect(r.player.spentPoints).toBe(3);
    expect(r.spent).toBeGreaterThan(0);
  });

  it('투수의 타격 능력치에는 포인트를 쓰지 않는다', () => {
    const p = {
      ...generatePlayer(new Rng(seedFromString('invest-p')), {
        position: 'P',
        role: 'SP' as const,
        number: 1,
      }),
      tier: 'S' as Tier,
      potential: 96,
    };
    const r = autoInvest(p, 1146);
    expect(r.player.batting).toEqual(p.batting);
    expect(r.player.pitching!.stamina).toBeGreaterThan(p.pitching!.stamina);
  });
});

describe('방출', () => {
  /** 타순·로테이션을 비워 방출 검증만 남긴 팀 */
  function loose(): Team {
    return { ...rich(0), lineup: [], rotation: [] };
  }

  it('환급 골드가 티어와 레벨에 따라 커진다', () => {
    expect(releaseValue(fake('C', 1))).toBeLessThan(releaseValue(fake('B', 1)));
    expect(releaseValue(fake('B', 1))).toBeLessThan(releaseValue(fake('A', 1)));
    expect(releaseValue(fake('A', 1))).toBeLessThan(releaseValue(fake('S', 1)));
    expect(releaseValue(fake('S', 1))).toBeLessThan(releaseValue(fake('S', 40)));
  });

  it('타순에 있는 선수는 방출할 수 없다', () => {
    const t = rich();
    const r = releasePlayer(t, t.lineup[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('타순');
    expect(r.gold).toBe(0);
  });

  it('로테이션에 있는 선수는 방출할 수 없다', () => {
    const t = rich();
    const r = releasePlayer(t, t.rotation[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/로테이션|선발/);
  });

  it('선발 투수는 방출할 수 없다', () => {
    const t = loose();
    const sp = t.players.find((p) => p.role === 'SP')!;
    const r = releasePlayer(t, sp.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('선발');
  });

  it('타자 하한에 닿으면 타자를 방출할 수 없다', () => {
    const t = loose();
    const batters = t.players.filter((p) => p.kind === 'BATTER').slice(0, MIN_BATTERS);
    const trimmed: Team = { ...t, players: [...t.players.filter((p) => p.kind === 'PITCHER'), ...batters] };
    expect(releaseIssue(trimmed, batters[0].id)).toContain(`${MIN_BATTERS}명`);
  });

  it('투수 하한에 닿으면 투수를 방출할 수 없다', () => {
    const t = loose();
    const pitchers = t.players.filter((p) => p.kind === 'PITCHER').slice(0, MIN_PITCHERS);
    const rp = pitchers.find((p) => p.role !== 'SP')!;
    const trimmed: Team = { ...t, players: [...pitchers, ...t.players.filter((p) => p.kind === 'BATTER')] };
    expect(releaseIssue(trimmed, rp.id)).toContain(`${MIN_PITCHERS}명`);
  });

  it('방출하면 로스터에서 빠지고 골드가 정확히 환급된다', () => {
    const t = { ...loose(), gold: 1_000 };
    const rp = t.players.find((p) => p.role === 'RP')!;
    const r = releasePlayer(t, rp.id);
    expect(r.ok).toBe(true);
    expect(r.gold).toBe(releaseValue(rp));
    expect(r.team.gold).toBe(1_000 + r.gold);
    expect(r.team.players.find((p) => p.id === rp.id)).toBeUndefined();
  });

  it('방출 후에도 rosterIssues가 비어 있다', () => {
    const t = rich();
    const bench = t.players.find(
      (p) => p.role === 'RP' && !t.rotation.includes(p.id) && !t.lineup.includes(p.id),
    )!;
    const r = releasePlayer(t, bench.id);
    expect(r.ok).toBe(true);
    expect(rosterIssues(r.team)).toEqual([]);
  });

  it('없는 선수는 방출할 수 없고 원본 팀을 바꾸지 않는다', () => {
    const t = rich();
    const before = structuredClone(t);
    expect(releasePlayer(t, 'nope').ok).toBe(false);
    const rp = t.players.find((p) => p.role === 'RP' && !t.rotation.includes(p.id))!;
    releasePlayer(t, rp.id);
    expect(t).toEqual(before);
  });
});

describe('골드 경제 (차익거래 방지)', () => {
  it('어떤 배너에서 무엇이 나와도 즉시 방출하면 반드시 손해다', () => {
    for (const id of BANNER_ORDER) {
      const banner = BANNERS[id];
      for (const { tier } of banner.rates) {
        expect(releaseValue(fake(tier, 1))).toBeLessThan(banner.gold);
      }
    }
  });

  it('티어를 강화한 뒤 방출해도 반드시 손해다', () => {
    for (const tier of ['C', 'B', 'A'] as Exclude<Tier, 'S'>[]) {
      const up = nextTier(tier)!;
      const gain = releaseValue(fake(up, 1)) - releaseValue(fake(tier, TIER_MAX_LEVEL[tier]));
      expect(gain).toBeLessThan(TIER_UP_GOLD[tier]);
    }
  });

  it('영입 → 방출을 반복해도 골드가 늘지 않는다', () => {
    let t: Team = { ...rich(300_000), lineup: [], rotation: [] };
    let prev = t.gold;
    for (let i = 0; i < 20; i++) {
      const d = drawPlayer(t, i % 2 ? 'PREMIUM' : 'NORMAL', 'BATTER', i + 1);
      if (!d.ok) break;
      const r = releasePlayer(d.team, d.player.id);
      expect(r.ok).toBe(true);
      t = r.team;
      expect(t.gold).toBeLessThan(prev);
      prev = t.gold;
    }
  });

  it('레벨을 최대까지 올려도 그 티어 강화 비용만큼 벌지 못한다', () => {
    // 레벨 환급이 커지면 "키워서 파는" 것이 티어 경제보다 이득이 되어 버린다.
    // 한 티어를 끝까지 키워 얻는 추가 환급은 그 티어의 강화 비용보다 작아야 한다.
    for (const tier of ['C', 'B', 'A'] as Exclude<Tier, 'S'>[]) {
      const levelGain = releaseValue(fake(tier, TIER_MAX_LEVEL[tier])) - releaseValue(fake(tier, 1));
      expect(levelGain).toBeLessThan(TIER_UP_GOLD[tier]);
    }
  });
});

describe('성장 속도', () => {
  it('자연 누적 훈련 포인트가 C 0 · B 108 · A 450 · S 1,146 이다', () => {
    expect(naturalTrainingPoints('C')).toBe(0);
    expect(naturalTrainingPoints('B')).toBe(108);
    expect(naturalTrainingPoints('A')).toBe(450);
    expect(naturalTrainingPoints('S')).toBe(1146);
  });

  it('TP_PER_LEVEL과 TIER_MAX_LEVEL에서 직접 파생된다', () => {
    let cum = 0;
    for (const t of TIER_ORDER) {
      expect(naturalTrainingPoints(t)).toBe(cum);
      cum += (TIER_MAX_LEVEL[t] - 1) * TP_PER_LEVEL[t];
    }
  });

  it('커리어 전체를 돌면 잠재력 상한에 실제로 닿는다', () => {
    // 성장 속도가 낮으면 S 40레벨까지 키워도 잠재력에 못 미쳐 상한이 장식이 된다.
    let p: Player = {
      ...generatePlayer(new Rng(seedFromString('career')), { position: 'CF', number: 8 }),
      potential: 82,
    };
    for (const t of TIER_ORDER) {
      p = { ...autoInvest({ ...p, tier: t }, (TIER_MAX_LEVEL[t] - 1) * TP_PER_LEVEL[t]).player };
    }
    expect(Math.max(...Object.values(p.batting))).toBe(82);
  });
});
