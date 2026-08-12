import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generatePlayer, generateTeam } from './generator';
import {
  TIER_MAX_LEVEL,
  TIER_PITCH_SLOTS,
  TIER_STAT_CAP,
  TIER_UP_GOLD,
  TP_PER_LEVEL,
  canTierUp,
  expToNext,
  grantExp,
  isMaxLevel,
  pitchSlots,
  pitchSlotsUsed,
  statCap,
  upgradeTier,
} from './progression';
import {
  learnPitch,
  learnPitchGold,
  learnablePitchesFor,
  pitchTrainingRefund,
  replaceablePitchesOf,
  replacePitch,
  statUpgradeCost,
  trainBatting,
  trainPitch,
} from './training';
import { useItem } from './items';
import type { Player, Team, Tier } from './types';

function batter(overrides: Partial<Player> = {}): Player {
  const rng = new Rng(seedFromString('test-batter'));
  return { ...generatePlayer(rng, { position: 'CF', number: 8 }), ...overrides };
}

function pitcher(overrides: Partial<Player> = {}): Player {
  const rng = new Rng(seedFromString('test-pitcher'));
  return { ...generatePlayer(rng, { position: 'P', role: 'SP', number: 21 }), ...overrides };
}

function team(): Team {
  return generateTeam(new Rng(seedFromString('test-team')), { ownerUid: 'u1' });
}

/** 선수 한 명만 든 팀. 골드를 쓰는 함수(구종 습득 등)를 단독 검증할 때 쓴다. */
function teamWith(p: Player, gold = 1_000_000): Team {
  return { ...team(), gold, players: [p], lineup: [], rotation: [] };
}

/** 경험치를 부어 최대 레벨까지 올린다 */
function toMaxLevel(p: Player): Player {
  let cur = p;
  let guard = 0;
  while (!isMaxLevel(cur) && guard++ < 200) {
    cur = grantExp(cur, expToNext(cur.level)).player;
  }
  return cur;
}

describe('경험치 곡선', () => {
  it('레벨이 오를수록 필요 경험치가 단조 증가한다', () => {
    for (let lv = 1; lv < 40; lv++) {
      expect(expToNext(lv + 1)).toBeGreaterThan(expToNext(lv));
    }
  });

  it('C1 -> S40 전체에 필요한 누적 경험치가 목표 구간 안에 있다', () => {
    // 티어가 오르면 레벨이 1로 돌아가므로 티어마다 1..(max-1)을 다시 쌓는다
    let total = 0;
    for (const t of ['C', 'B', 'A', 'S'] as Tier[]) {
      for (let lv = 1; lv < TIER_MAX_LEVEL[t]; lv++) total += expToNext(lv);
    }
    // 주전 한 명이 대략 300경기 규모. 밸런스를 바꾸면 이 범위를 함께 조정한다.
    expect(total).toBeGreaterThan(15_000);
    expect(total).toBeLessThan(30_000);
  });
});

describe('레벨업', () => {
  it('필요 경험치를 채우면 레벨이 오르고 훈련 포인트를 준다', () => {
    const p = batter({ tier: 'C', level: 1, exp: 0, trainingPoints: 0 });
    const gain = grantExp(p, expToNext(1));
    expect(gain.levelUps).toBe(1);
    expect(gain.player.level).toBe(2);
    expect(gain.pointsGained).toBe(TP_PER_LEVEL.C);
    expect(gain.player.trainingPoints).toBe(TP_PER_LEVEL.C);
  });

  it('한 번에 여러 레벨이 오를 수 있다', () => {
    const p = batter({ tier: 'C', level: 1, exp: 0, trainingPoints: 0 });
    const need = expToNext(1) + expToNext(2) + expToNext(3);
    const gain = grantExp(p, need);
    expect(gain.levelUps).toBe(3);
    expect(gain.player.level).toBe(4);
  });

  it('원본을 바꾸지 않는다', () => {
    const p = batter({ level: 1, exp: 0 });
    grantExp(p, 5000);
    expect(p.level).toBe(1);
    expect(p.exp).toBe(0);
  });

  it('티어 최대 레벨에서 멈추고 넘친 경험치는 버려진다', () => {
    const maxed = toMaxLevel(batter({ tier: 'C', level: 1, exp: 0 }));
    expect(maxed.level).toBe(TIER_MAX_LEVEL.C);
    const gain = grantExp(maxed, 9999);
    expect(gain.levelUps).toBe(0);
    expect(gain.wasted).toBe(9999);
    expect(gain.player.exp).toBe(0);
  });
});

describe('티어 강화', () => {
  it('최대 레벨에 도달해야 강화할 수 있다', () => {
    expect(canTierUp(batter({ tier: 'C', level: 1 }))).toBe(false);
    expect(canTierUp(batter({ tier: 'C', level: TIER_MAX_LEVEL.C }))).toBe(true);
    expect(canTierUp(batter({ tier: 'S', level: TIER_MAX_LEVEL.S }))).toBe(false);
  });

  it('강화해도 능력치가 그대로 유지된다 (요구사항의 핵심)', () => {
    const t = team();
    const target = toMaxLevel(t.players[0]);
    const withMax: Team = {
      ...t,
      gold: 999_999,
      players: t.players.map((p) => (p.id === target.id ? target : p)),
    };

    const r = upgradeTier(withMax, target.id);
    expect(r.ok).toBe(true);
    const after = r.team.players.find((p) => p.id === target.id)!;

    expect(after.tier).toBe('B');
    expect(after.level).toBe(1);
    expect(after.exp).toBe(0);
    // 능력치는 손대지 않는다
    expect(after.batting).toEqual(target.batting);
    expect(after.pitching?.stamina).toBe(target.pitching?.stamina);
    expect(after.pitching?.arsenal).toEqual(target.pitching?.arsenal);
    expect(after.trainingPoints).toBe(target.trainingPoints);
  });

  it('골드가 부족하면 강화되지 않는다', () => {
    const t = team();
    const target = toMaxLevel(t.players[0]);
    const poor: Team = {
      ...t,
      gold: TIER_UP_GOLD.C - 1,
      players: t.players.map((p) => (p.id === target.id ? target : p)),
    };
    const r = upgradeTier(poor, target.id);
    expect(r.ok).toBe(false);
    expect(r.team.gold).toBe(TIER_UP_GOLD.C - 1);
  });

  it('강화 비용만큼 골드가 빠진다', () => {
    const t = team();
    const target = toMaxLevel(t.players[0]);
    const rich: Team = {
      ...t,
      gold: 50_000,
      players: t.players.map((p) => (p.id === target.id ? target : p)),
    };
    const r = upgradeTier(rich, target.id);
    expect(r.team.gold).toBe(50_000 - TIER_UP_GOLD.C);
  });
});

describe('능력치 상한', () => {
  it('티어 상한과 잠재력 중 낮은 쪽을 따른다', () => {
    expect(statCap(batter({ tier: 'C', potential: 99 }))).toBe(TIER_STAT_CAP.C);
    expect(statCap(batter({ tier: 'S', potential: 70 }))).toBe(70);
    expect(statCap(batter({ tier: 'A', potential: 99 }))).toBe(TIER_STAT_CAP.A);
  });

  it('훈련이 티어 상한에서 막히고, 티어를 올리면 다시 오른다', () => {
    const capped = batter({
      tier: 'C',
      potential: 99,
      trainingPoints: 10_000,
      batting: { ...batter().batting, power: TIER_STAT_CAP.C },
    });
    const blocked = trainBatting(capped, 'power', 1);
    expect(blocked.ok).toBe(false);
    expect(blocked.player.batting.power).toBe(TIER_STAT_CAP.C);

    const promoted = { ...capped, tier: 'B' as Tier, level: 1 };
    const ok = trainBatting(promoted, 'power', 1);
    expect(ok.ok).toBe(true);
    expect(ok.player.batting.power).toBe(TIER_STAT_CAP.C + 1);
  });

  it('상한에 도달하면 비용이 무한이 된다', () => {
    expect(statUpgradeCost(65, 65)).toBe(Infinity);
    expect(Number.isFinite(statUpgradeCost(64, 65))).toBe(true);
  });

  it('훈련에 쓴 포인트가 spentPoints에 누적된다', () => {
    const p = batter({ tier: 'S', potential: 99, trainingPoints: 500, spentPoints: 0 });
    const r = trainBatting(p, 'contact', 3);
    expect(r.ok).toBe(true);
    expect(r.player.spentPoints).toBe(500 - r.player.trainingPoints);
    expect(r.player.spentPoints).toBeGreaterThan(0);
  });
});

describe('구종 슬롯', () => {
  it('신규 선수는 C등급 슬롯을 넘지 않는다', () => {
    const t = team();
    for (const p of t.players.filter((x) => x.kind === 'PITCHER')) {
      expect(pitchSlotsUsed(p)).toBeLessThanOrEqual(TIER_PITCH_SLOTS.C);
    }
  });

  it('슬롯이 가득 차면 새 구종을 익힐 수 없다', () => {
    let t = teamWith(pitcher({ tier: 'C' }));
    const id = t.players[0].id;
    // C 슬롯(3)을 채운다
    let guard = 0;
    while (pitchSlotsUsed(t.players[0]) < TIER_PITCH_SLOTS.C && guard++ < 10) {
      const next = learnablePitchesFor(t.players[0])[0];
      if (!next) break;
      t = learnPitch(t, id, next, guard).team;
    }
    expect(pitchSlotsUsed(t.players[0])).toBe(TIER_PITCH_SLOTS.C);

    const wanted = learnablePitchesFor(t.players[0])[0];
    const blocked = learnPitch(t, id, wanted, 99);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('슬롯');

    const promoted: Team = {
      ...t,
      players: [{ ...t.players[0], tier: 'B' as Tier, level: 1 }],
    };
    expect(pitchSlots(promoted.players[0])).toBe(TIER_PITCH_SLOTS.B);
    expect(learnPitch(promoted, id, wanted, 99).ok).toBe(true);
  });
});

describe('구종 습득 (골드)', () => {
  it('골드가 부족하면 배우지 못하고 팀이 그대로다', () => {
    const t = teamWith(pitcher({ tier: 'B' }), 0);
    const wanted = learnablePitchesFor(t.players[0])[0];
    const r = learnPitch(t, t.players[0].id, wanted, 1);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('골드');
    expect(r.team).toBe(t);
  });

  it('골드만 빠지고 훈련 포인트는 그대로다', () => {
    const t = teamWith(pitcher({ tier: 'B', trainingPoints: 500 }), 50_000);
    const p = t.players[0];
    const wanted = learnablePitchesFor(p)[0];
    const cost = learnPitchGold(wanted, p);

    const r = learnPitch(t, p.id, wanted, 7);
    expect(r.ok).toBe(true);
    expect(r.team.gold).toBe(50_000 - cost);
    expect(r.team.players[0].trainingPoints).toBe(500);
    expect(r.team.players[0].spentPoints).toBe(p.spentPoints);
    expect(pitchSlotsUsed(r.team.players[0])).toBe(pitchSlotsUsed(p) + 1);
  });

  it('습득 비용이 spentGold에 누적된다', () => {
    let t = teamWith(pitcher({ tier: 'S' }), 200_000);
    const id = t.players[0].id;
    let expected = 0;
    for (let i = 0; i < 2; i++) {
      const wanted = learnablePitchesFor(t.players[0])[0];
      expected += learnPitchGold(wanted, t.players[0]);
      t = learnPitch(t, id, wanted, i + 1).team;
    }
    expect(t.players[0].spentGold).toBe(expected);
    expect(t.gold).toBe(200_000 - expected);
  });

  it('능력치초기화권이 구종 습득 골드를 팀에 환급한다', () => {
    let t = teamWith(pitcher({ tier: 'B' }), 50_000);
    t = { ...t, inventory: { RESET_STATS: 1 } };
    const id = t.players[0].id;
    const before = pitchSlotsUsed(t.players[0]);
    const wanted = learnablePitchesFor(t.players[0])[0];

    t = learnPitch(t, id, wanted, 3).team;
    expect(t.gold).toBeLessThan(50_000);

    const r = useItem(t, id, 'RESET_STATS');
    expect(r.ok).toBe(true);
    // 골드가 전액 돌아오고, 골드로 배운 구종은 사라진다
    expect(r.team.gold).toBe(50_000);
    expect(r.team.players[0].spentGold).toBe(0);
    expect(pitchSlotsUsed(r.team.players[0])).toBe(before);
  });

  it('훈련 포인트도 골드도 쓴 적 없으면 초기화권을 쓸 수 없다', () => {
    const t = {
      ...teamWith(pitcher({ spentPoints: 0, spentGold: 0 })),
      inventory: { RESET_STATS: 1 },
    };
    const r = useItem(t, t.players[0].id, 'RESET_STATS');
    expect(r.ok).toBe(false);
  });
});

describe('구종 교체 (골드)', () => {
  /** 슬롯을 끝까지 채운 C등급 투수와 그 팀 */
  function fullSlots(): Team {
    let t = teamWith(pitcher({ tier: 'C' }), 1_000_000);
    const id = t.players[0].id;
    let guard = 0;
    while (pitchSlotsUsed(t.players[0]) < TIER_PITCH_SLOTS.C && guard++ < 10) {
      const next = learnablePitchesFor(t.players[0])[0];
      if (!next) break;
      t = learnPitch(t, id, next, guard).team;
    }
    return t;
  }

  it('슬롯이 가득 차도 보유 구종을 다른 구종으로 바꿀 수 있다', () => {
    const t = fullSlots();
    const p = t.players[0];
    expect(learnPitch(t, p.id, learnablePitchesFor(p)[0], 1).ok).toBe(false);

    const from = replaceablePitchesOf(p)[0];
    const to = learnablePitchesFor(p)[0];
    const cost = learnPitchGold(to, p);

    const r = replacePitch(t, p.id, from, to, 5);
    expect(r.ok).toBe(true);
    expect(r.team.gold).toBe(t.gold - cost);
    // 슬롯 수는 그대로 — 그래서 가득 찬 투수도 쓸 수 있다
    expect(pitchSlotsUsed(r.team.players[0])).toBe(pitchSlotsUsed(p));
    expect(r.team.players[0].pitching?.arsenal[from]).toBeUndefined();
    expect(r.team.players[0].pitching?.arsenal[to]).toBeDefined();
  });

  it('직구는 바꿀 수 없다', () => {
    const t = fullSlots();
    const p = t.players[0];
    const r = replacePitch(t, p.id, 'FOURSEAM', learnablePitchesFor(p)[0], 2);
    expect(r.ok).toBe(false);
    expect(r.team).toBe(t);
    expect(replaceablePitchesOf(p)).not.toContain('FOURSEAM');
  });

  it('보유하지 않은 구종에서, 또는 이미 보유한 구종으로는 바꿀 수 없다', () => {
    const t = fullSlots();
    const p = t.players[0];
    const owned = replaceablePitchesOf(p);
    const missing = learnablePitchesFor(p)[0];

    expect(replacePitch(t, p.id, missing, owned[0], 3).ok).toBe(false);
    expect(replacePitch(t, p.id, owned[0], owned[1], 3).ok).toBe(false);
    expect(replacePitch(t, p.id, owned[0], owned[0], 3).ok).toBe(false);
  });

  it('타자에게는 쓸 수 없고 골드도 빠지지 않는다', () => {
    const t = teamWith(batter(), 1_000_000);
    const r = replacePitch(t, t.players[0].id, 'SLIDER', 'CURVE', 4);
    expect(r.ok).toBe(false);
    expect(r.team.gold).toBe(1_000_000);
  });

  it('골드가 부족하면 구종이 그대로 남는다', () => {
    const t = { ...fullSlots(), gold: 0 };
    const p = t.players[0];
    const from = replaceablePitchesOf(p)[0];
    const r = replacePitch(t, p.id, from, learnablePitchesFor(p)[0], 6);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('골드');
    expect(r.team.players[0].pitching?.arsenal[from]).toBeDefined();
  });

  it('버린 구종에 부은 훈련 포인트를 전액 돌려준다', () => {
    // 훈련으로 올린 만큼만 돌아와야 하므로, 창단 구종을 실제로 훈련시켜 놓고 잰다
    const raw = pitcher({ tier: 'S', potential: 99, trainingPoints: 3000 });
    const from = replaceablePitchesOf(raw)[0];
    let trained = raw;
    for (const key of ['velocity', 'control', 'movement'] as const) {
      trained = trainPitch(trained, from, key, 5).player;
    }
    const paid = raw.trainingPoints - trained.trainingPoints;
    expect(paid).toBeGreaterThan(0);
    expect(pitchTrainingRefund(trained, from)).toBe(paid);

    const t = teamWith(trained, 1_000_000);
    const r = replacePitch(t, trained.id, from, learnablePitchesFor(trained)[0], 21);
    expect(r.ok).toBe(true);
    expect(r.team.players[0].trainingPoints).toBe(raw.trainingPoints);
    expect(r.message).toContain('환급');
  });

  it('훈련한 적 없는 구종을 버려도 포인트가 생기지 않는다', () => {
    const p = pitcher({ tier: 'C' });
    const from = replaceablePitchesOf(p)[0];
    expect(pitchTrainingRefund(p, from)).toBe(0);

    const t = teamWith(p, 1_000_000);
    const r = replacePitch(t, p.id, from, learnablePitchesFor(p)[0], 22);
    expect(r.ok).toBe(true);
    expect(r.team.players[0].trainingPoints).toBe(p.trainingPoints);
    expect(r.message).not.toContain('환급');
  });

  it('골드로 익힌 구종은 습득 시점부터의 훈련만 돌려준다', () => {
    const t0 = teamWith(pitcher({ tier: 'S', potential: 99, trainingPoints: 3000 }), 1_000_000);
    const id = t0.players[0].id;
    const bought = learnablePitchesFor(t0.players[0])[0];
    const t1 = learnPitch(t0, id, bought, 23).team;
    // 습득 직후에는 돌려받을 것이 없다
    expect(pitchTrainingRefund(t1.players[0], bought)).toBe(0);

    const before = t1.players[0].trainingPoints;
    const trained = trainPitch(t1.players[0], bought, 'movement', 6).player;
    const paid = before - trained.trainingPoints;
    expect(paid).toBeGreaterThan(0);

    const t2: Team = { ...t1, players: [trained] };
    const r = replacePitch(t2, id, bought, learnablePitchesFor(trained)[0], 24);
    expect(r.ok).toBe(true);
    expect(r.team.players[0].trainingPoints).toBe(before);
  });

  it('환급받은 포인트를 초기화권이 다시 주지 않는다', () => {
    const raw = pitcher({ tier: 'S', potential: 99, trainingPoints: 3000 });
    const from = replaceablePitchesOf(raw)[0];
    const trained = trainPitch(raw, from, 'control', 4).player;
    const t = { ...teamWith(trained, 1_000_000), inventory: { RESET_STATS: 1 } };

    const swapped = replacePitch(t, raw.id, from, learnablePitchesFor(trained)[0], 25).team;
    expect(swapped.players[0].trainingPoints).toBe(raw.trainingPoints);

    const r = useItem(swapped, raw.id, 'RESET_STATS');
    expect(r.ok).toBe(true);
    // 이미 돌려받았으므로 초기화권은 그 위에 더 얹지 않는다
    expect(r.team.players[0].trainingPoints).toBe(raw.trainingPoints);
    expect(r.team.players[0].base.learned).toBeUndefined();
  });

  it('버린 구종의 훈련치를 물려받지 않는다', () => {
    const base = pitcher({ tier: 'S' });
    const from = replaceablePitchesOf(base)[0];
    const boosted = structuredClone(base);
    boosted.pitching!.arsenal[from] = { velocity: 88, control: 88, movement: 88 };

    const t = teamWith(boosted, 1_000_000);
    const to = learnablePitchesFor(boosted)[0];
    const r = replacePitch(t, boosted.id, from, to, 11);
    expect(r.ok).toBe(true);

    // 습득과 같은 규칙으로 낮게 시작한다 (learnPitch의 상한: 60 / 55 / 62)
    const fresh = r.team.players[0].pitching!.arsenal[to]!;
    expect(fresh.velocity).toBeLessThanOrEqual(60);
    expect(fresh.control).toBeLessThanOrEqual(55);
    expect(fresh.movement).toBeLessThanOrEqual(62);
  });

  it('새 구종이 버린 구종의 자리를 그대로 물려받는다', () => {
    const t = fullSlots();
    const p = t.players[0];
    const before = Object.keys(p.pitching!.arsenal);
    const from = replaceablePitchesOf(p)[0];
    const to = learnablePitchesFor(p)[0];

    const r = replacePitch(t, p.id, from, to, 12);
    const after = Object.keys(r.team.players[0].pitching!.arsenal);
    expect(after).toEqual(before.map((k) => (k === from ? to : k)));
  });

  it('교체 비용도 spentGold에 쌓여 초기화권으로 돌아온다', () => {
    const t = { ...fullSlots(), inventory: { RESET_STATS: 1 } };
    const p = t.players[0];
    const spentBefore = p.spentGold ?? 0;
    const goldBefore = t.gold;
    const from = replaceablePitchesOf(p)[0];
    const to = learnablePitchesFor(p)[0];
    const cost = learnPitchGold(to, p);

    const swapped = replacePitch(t, p.id, from, to, 13).team;
    expect(swapped.players[0].spentGold).toBe(spentBefore + cost);

    const r = useItem(swapped, p.id, 'RESET_STATS');
    expect(r.ok).toBe(true);
    expect(r.team.gold).toBe(goldBefore + spentBefore);
    expect(r.team.players[0].pitching!.arsenal).toEqual(p.base.arsenal);
  });
});

describe('능력치초기화권', () => {
  it('base로 되돌리고 쓴 포인트를 전액 환급한다', () => {
    const t = team();
    const target = { ...t.players.find((p) => p.kind === 'BATTER')!, tier: 'S' as Tier, trainingPoints: 400 };
    const trained = trainBatting(trainBatting(target, 'contact', 4).player, 'power', 3).player;
    expect(trained.spentPoints).toBeGreaterThan(0);

    const withItem: Team = {
      ...t,
      inventory: { RESET_STATS: 1 },
      players: t.players.map((p) => (p.id === trained.id ? trained : p)),
    };
    const r = useItem(withItem, trained.id, 'RESET_STATS');
    expect(r.ok).toBe(true);

    const after = r.team.players.find((p) => p.id === trained.id)!;
    expect(after.batting).toEqual(after.base.batting);
    expect(after.trainingPoints).toBe(trained.trainingPoints + trained.spentPoints);
    expect(after.spentPoints).toBe(0);
    expect(r.team.inventory.RESET_STATS).toBe(0);
  });
});

describe('아이템', () => {
  it('경험치보충제가 경험치를 주고 레벨을 올린다', () => {
    const t = team();
    const target = t.players[0];
    const withItem: Team = { ...t, inventory: { EXP_XL: 1 } };
    const r = useItem(withItem, target.id, 'EXP_XL');
    expect(r.ok).toBe(true);
    const after = r.team.players.find((p) => p.id === target.id)!;
    expect(after.level).toBeGreaterThan(target.level);
    expect(after.trainingPoints).toBeGreaterThan(target.trainingPoints);
  });

  it('최대 레벨에 막혀 버려진 분량을 메시지에 알린다', () => {
    // C티어 한 구간(602)보다 특대(1,000)가 크므로 낮은 레벨에 쓰면 일부가 버려진다.
    const t = team();
    const target = { ...t.players.find((p) => p.kind === 'BATTER')!, tier: 'C' as Tier, level: 1, exp: 0 };
    const withItem: Team = {
      ...t,
      inventory: { EXP_XL: 1 },
      players: t.players.map((p) => (p.id === target.id ? target : p)),
    };

    const r = useItem(withItem, target.id, 'EXP_XL');
    expect(r.ok).toBe(true);
    expect(r.team.players.find((p) => p.id === target.id)!.level).toBe(TIER_MAX_LEVEL.C);
    expect(r.message).toContain('버려짐');

    // 버릴 것이 없으면 군더더기를 붙이지 않는다
    expect(useItem(withItem, target.id, 'EXP_S').message).not.toContain('버려짐');
  });

  it('스테미나회복제는 투수에게만 쓸 수 있다', () => {
    const t = team();
    const hitter = t.players.find((p) => p.kind === 'BATTER')!;
    const arm = t.players.find((p) => p.kind === 'PITCHER')!;
    const withItem: Team = {
      ...t,
      inventory: { STAMINA_TONIC: 2 },
      players: t.players.map((p) => (p.id === arm.id ? { ...p, fatigue: 0.8 } : p)),
    };
    expect(useItem(withItem, hitter.id, 'STAMINA_TONIC').ok).toBe(false);
    const r = useItem(withItem, arm.id, 'STAMINA_TONIC');
    expect(r.ok).toBe(true);
    expect(r.team.players.find((p) => p.id === arm.id)!.fatigue).toBe(0);
  });

  it('없는 아이템은 쓸 수 없다', () => {
    const t = team();
    expect(useItem(t, t.players[0].id, 'CURE_INJURY').ok).toBe(false);
  });
});
