import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { emptySeason, generatePlayer, generateTeam } from './generator';
import { pitchCapacity } from './pitching';
import { LEAGUE_PLACE_GOLD, LEAGUE_PLACE_ITEMS } from './league';
import {
  DIFFICULTY_REWARD_MULT,
  OUTCOME_MULT,
  REST_RECOVERY,
  applyMatchResult,
  matchGold,
  mergeSeason,
  nextFatigue,
  outcomeOf,
  playerMatchExp,
  relayOutcome,
  type MatchRewardContext,
} from './matchReward';
import type { Player, SeasonStat, Team, TeamInGame } from './types';

function ctx(over: Partial<MatchRewardContext> = {}): MatchRewardContext {
  return {
    kind: 'CPU',
    difficulty: 'NORMAL',
    outcome: 'WIN',
    runsScored: 5,
    runsAllowed: 3,
    seed: 12345,
    recordSeason: true,
    ...over,
  };
}

function batter(over: Partial<Player> = {}): Player {
  const rng = new Rng(seedFromString('mr-batter'));
  return { ...generatePlayer(rng, { position: 'CF', number: 8 }), ...over };
}

function starter(over: Partial<Player> = {}): Player {
  const rng = new Rng(seedFromString('mr-pitcher'));
  return { ...generatePlayer(rng, { position: 'P', role: 'SP', number: 21 }), ...over };
}

function team(): Team {
  return generateTeam(new Rng(seedFromString('mr-team')), { ownerUid: 'u1' });
}

/** 로스터 전원의 경기 델타가 비어 있는 TeamInGame */
function inGame(t: Team, lines: Record<string, Partial<SeasonStat>> = {}): TeamInGame {
  const roster: Record<string, Player> = {};
  for (const p of t.players) {
    roster[p.id] = { ...p, season: { ...emptySeason(), ...(lines[p.id] ?? {}) } };
  }
  return {
    teamId: t.id,
    name: t.name,
    abbr: t.abbr,
    primaryColor: t.primaryColor,
    secondaryColor: t.secondaryColor,
    accentColor: t.accentColor,
    uniformType: t.uniformType,
    logoId: t.logoId,
    roster,
    lineup: t.lineup,
    atBatIndex: 0,
    pitcherId: t.rotation[0],
    pitcherPitches: 0,
    usedPitcherIds: [t.rotation[0]],
    usedBatterIds: [],
    defense: {},
    runs: 5,
    hits: 9,
    errors: 0,
    lob: 6,
  };
}

describe('시즌 기록 병합', () => {
  it('모든 필드를 빠짐없이 더한다', () => {
    const a = emptySeason();
    const b = emptySeason();
    // 키마다 서로 다른 값을 넣어 누락을 잡는다
    const keys = Object.keys(a) as (keyof SeasonStat)[];
    keys.forEach((k, i) => {
      a[k] = i + 1;
      b[k] = 100;
    });
    const merged = mergeSeason(a, b);
    keys.forEach((k, i) => expect(merged[k]).toBe(i + 101));
  });

  it('새 필드(np, hbp)도 포함한다', () => {
    const merged = mergeSeason({ ...emptySeason(), np: 90, hbp: 1 }, { ...emptySeason(), np: 12, hbp: 2 });
    expect(merged.np).toBe(102);
    expect(merged.hbp).toBe(3);
  });
});

describe('경험치 산정', () => {
  it('출전하지 않은 선수는 0이다', () => {
    expect(playerMatchExp(batter(), emptySeason(), ctx())).toBe(0);
    expect(playerMatchExp(starter(), emptySeason(), ctx())).toBe(0);
  });

  it('안타와 홈런이 많을수록 많이 받는다', () => {
    const quiet = playerMatchExp(batter(), { ...emptySeason(), pa: 4, ab: 4 }, ctx());
    const hits = playerMatchExp(batter(), { ...emptySeason(), pa: 4, ab: 4, h: 3 }, ctx());
    const homers = playerMatchExp(batter(), { ...emptySeason(), pa: 4, ab: 4, h: 3, hr: 2 }, ctx());
    expect(hits).toBeGreaterThan(quiet);
    expect(homers).toBeGreaterThan(hits);
  });

  it('투수는 이닝과 탈삼진이 많을수록 많이 받는다', () => {
    const short = playerMatchExp(starter(), { ...emptySeason(), np: 40, ip3: 6 }, ctx());
    const long = playerMatchExp(starter(), { ...emptySeason(), np: 95, ip3: 21 }, ctx());
    const dominant = playerMatchExp(
      starter(),
      { ...emptySeason(), np: 95, ip3: 21, pk: 10 },
      ctx(),
    );
    expect(long).toBeGreaterThan(short);
    expect(dominant).toBeGreaterThan(long);
  });

  it('난이도가 높을수록, 이길수록 많이 받는다', () => {
    const line = { ...emptySeason(), pa: 4, ab: 4, h: 2 };
    const easy = playerMatchExp(batter(), line, ctx({ difficulty: 'EASY' }));
    const pro = playerMatchExp(batter(), line, ctx({ difficulty: 'PRO' }));
    const loss = playerMatchExp(batter(), line, ctx({ outcome: 'LOSS' }));
    expect(pro).toBeGreaterThan(easy);
    expect(playerMatchExp(batter(), line, ctx())).toBeGreaterThan(loss);
    expect(DIFFICULTY_REWARD_MULT.PRO).toBeGreaterThan(DIFFICULTY_REWARD_MULT.EASY);
    expect(OUTCOME_MULT.LOSS).toBeGreaterThan(0);
  });

  it('expScale로 지급량을 비례 축소할 수 있다 (온라인 한도용)', () => {
    const line = { ...emptySeason(), pa: 4, ab: 4, h: 2 };
    const full = playerMatchExp(batter(), line, ctx());
    const half = playerMatchExp(batter(), line, ctx({ expScale: 0.5 }));
    expect(half).toBeLessThan(full);
    expect(playerMatchExp(batter(), line, ctx({ expScale: 0 }))).toBe(0);
  });
});

describe('골드 산정', () => {
  it('이기면 더 받고 져도 0은 아니다', () => {
    expect(matchGold(ctx())).toBeGreaterThan(matchGold(ctx({ outcome: 'LOSS' })));
    expect(matchGold(ctx({ outcome: 'LOSS' }))).toBeGreaterThan(0);
  });

  it('난이도가 높을수록 많이 받는다', () => {
    expect(matchGold(ctx({ difficulty: 'PRO' }))).toBeGreaterThan(
      matchGold(ctx({ difficulty: 'EASY' })),
    );
  });

  it('온라인·릴레이는 득점과 완봉에 값을 매기지 않는다 (담합 방지)', () => {
    const lowScore = matchGold(ctx({ kind: 'ONLINE', runsScored: 0, runsAllowed: 5 }));
    const blowout = matchGold(ctx({ kind: 'ONLINE', runsScored: 30, runsAllowed: 0 }));
    expect(blowout).toBe(lowScore);

    // 오프라인은 반대로 득점·완봉이 반영된다
    expect(matchGold(ctx({ runsScored: 12, runsAllowed: 0 }))).toBeGreaterThan(
      matchGold(ctx({ runsScored: 0, runsAllowed: 5 })),
    );
  });
});

describe('투수 피로 이월', () => {
  it('던진 만큼 쌓인다', () => {
    const p = starter({ fatigue: 0 });
    const cap = pitchCapacity(p);
    expect(nextFatigue(p, cap)).toBeCloseTo(1, 5);
    expect(nextFatigue(p, cap / 2)).toBeCloseTo(0.5, 5);
  });

  it('완전히 지친 선발이 정확히 3경기 쉬면 회복된다', () => {
    let p = starter({ fatigue: 1 });
    expect(p.fatigue).toBe(1);

    p = { ...p, fatigue: nextFatigue(p, 0) }; // 1경기 휴식
    expect(p.fatigue).toBeGreaterThan(0);
    p = { ...p, fatigue: nextFatigue(p, 0) }; // 2경기 휴식
    expect(p.fatigue).toBeGreaterThan(0);
    p = { ...p, fatigue: nextFatigue(p, 0) }; // 3경기 휴식
    expect(p.fatigue).toBe(0);

    expect(REST_RECOVERY).toBeCloseTo(1 / 3, 10);
  });

  it('0 아래로 내려가거나 1을 넘지 않는다', () => {
    expect(nextFatigue(starter({ fatigue: 0 }), 0)).toBe(0);
    expect(nextFatigue(starter({ fatigue: 0.9 }), 10_000)).toBe(1);
  });
});

describe('경기 결과 적용', () => {
  it('골드가 팀에 들어가고 출전 선수만 경험치를 받는다', () => {
    const t = team();
    const hitter = t.players.find((p) => p.id === t.lineup[0])!;
    const mine = inGame(t, { [hitter.id]: { pa: 4, ab: 4, h: 2, hr: 1, rbi: 3 } });

    const r = applyMatchResult(t, mine, ctx());
    expect(r.team.gold).toBe(t.gold + r.gold);

    const line = r.lines.find((l) => l.playerId === hitter.id);
    expect(line?.exp).toBeGreaterThan(0);
    // 출전 기록이 없는 선수는 내역에 뜨지 않는다
    const bench = t.players.find((p) => !t.lineup.includes(p.id) && p.kind === 'BATTER')!;
    expect(r.lines.find((l) => l.playerId === bench.id)).toBeUndefined();
  });

  it('경기 보상으로는 아이템이 나오지 않는다', () => {
    const t = team();
    const r = applyMatchResult(t, inGame(t), ctx());
    expect(r.team.inventory).toEqual(t.inventory);
  });

  it('로테이션이 한 칸 돈다', () => {
    const t = team();
    const r = applyMatchResult(t, inGame(t), ctx());
    expect(r.team.rotationIndex).toBe((t.rotationIndex + 1) % t.rotation.length);
  });

  it('온라인은 시즌 기록을 남기지 않는다', () => {
    const t = team();
    const hitter = t.players.find((p) => p.id === t.lineup[0])!;
    const mine = inGame(t, { [hitter.id]: { g: 1, pa: 4, ab: 4, h: 2 } });

    const offline = applyMatchResult(t, mine, ctx({ recordSeason: true }));
    const online = applyMatchResult(t, mine, ctx({ kind: 'ONLINE', recordSeason: false }));

    expect(offline.team.players.find((p) => p.id === hitter.id)!.season.h).toBe(hitter.season.h + 2);
    expect(online.team.players.find((p) => p.id === hitter.id)!.season.h).toBe(hitter.season.h);
  });

  it('등판한 투수는 피로가 쌓이고, 쉰 투수는 회복한다', () => {
    const t = team();
    const usedId = t.rotation[0];
    const restedId = t.rotation[1];
    const tired: Team = {
      ...t,
      players: t.players.map((p) => (p.id === restedId ? { ...p, fatigue: 1 } : p)),
    };
    const mine = inGame(tired, { [usedId]: { np: 95, ip3: 18, pk: 6 } });

    const r = applyMatchResult(tired, mine, ctx());
    expect(r.team.players.find((p) => p.id === usedId)!.fatigue).toBeGreaterThan(0);
    expect(r.team.players.find((p) => p.id === restedId)!.fatigue).toBeCloseTo(1 - REST_RECOVERY, 5);
  });

  it('부상 카운트다운이 경기마다 줄고 0이 되면 풀린다', () => {
    const t = team();
    const hurtId = t.players[0].id;
    let cur: Team = {
      ...t,
      players: t.players.map((p) =>
        p.id === hurtId ? { ...p, injury: { gamesLeft: 2, reason: '테스트' } } : p,
      ),
    };
    cur = applyMatchResult(cur, inGame(cur), ctx()).team;
    expect(cur.players.find((p) => p.id === hurtId)!.injury?.gamesLeft).toBe(1);
    cur = applyMatchResult(cur, inGame(cur), ctx()).team;
    expect(cur.players.find((p) => p.id === hurtId)!.injury).toBeUndefined();
  });

  it('같은 시드면 같은 결과가 나온다 (부상 판정 포함)', () => {
    const t = team();
    const mine = inGame(t, { [t.rotation[0]]: { np: 200, ip3: 24 } });
    const a = applyMatchResult(t, mine, ctx({ seed: 777 }));
    const b = applyMatchResult(t, mine, ctx({ seed: 777 }));
    expect(a.team.players.map((p) => p.injury?.gamesLeft ?? 0)).toEqual(
      b.team.players.map((p) => p.injury?.gamesLeft ?? 0),
    );
  });
});

describe('승패 판정 헬퍼', () => {
  it('승/패/무를 올바로 가른다', () => {
    expect(outcomeOf('home', 'home')).toBe('WIN');
    expect(outcomeOf('away', 'home')).toBe('LOSS');
    expect(outcomeOf('TIE', 'home')).toBe('DRAW');
    expect(outcomeOf(undefined, 'home')).toBe('DRAW');
  });

  it('릴레이는 1위가 승리, 최하위가 패배다', () => {
    expect(relayOutcome(1, 5)).toBe('WIN');
    expect(relayOutcome(5, 5)).toBe('LOSS');
    expect(relayOutcome(3, 5)).toBe('DRAW');
    expect(relayOutcome(1, 1)).toBe('DRAW');
  });
});

describe('리그 종료 보상', () => {
  it('1~3위만 받고 위로 갈수록 많다', () => {
    expect(LEAGUE_PLACE_GOLD).toHaveLength(3);
    expect(LEAGUE_PLACE_GOLD[0]).toBeGreaterThan(LEAGUE_PLACE_GOLD[1]);
    expect(LEAGUE_PLACE_GOLD[1]).toBeGreaterThan(LEAGUE_PLACE_GOLD[2]);
  });

  it('순위마다 아이템 구성이 다르고 비어 있지 않다', () => {
    expect(LEAGUE_PLACE_ITEMS).toHaveLength(3);
    for (const items of LEAGUE_PLACE_ITEMS) {
      expect(Object.keys(items).length).toBeGreaterThan(0);
    }
    // 1등만 받는 아이템이 있다
    expect(LEAGUE_PLACE_ITEMS[0].EXP_XL).toBeGreaterThan(0);
    expect(LEAGUE_PLACE_ITEMS[1].EXP_XL).toBeUndefined();
  });
});
