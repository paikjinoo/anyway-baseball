import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import {
  LEAGUE_PLACE_GOLD,
  POSTSEASON_GOLD,
  PS_FINAL_WINS,
  PS_SEMI_WINS,
  computeStandings,
  cpuTeamOf,
  createLeague,
  leagueRankedPlayers,
  nextGameFor,
  pendingPostseasonGames,
  postseasonNextGameFor,
  postseasonReward,
  recordGame,
  recordPostseasonResult,
  recordResult,
  relinkPlayerTeam,
  seriesWins,
  simulateGame,
  startPostseason,
  teamGameCounts,
} from './league';
import { computeLeaders, computeTitlesOf, qualifiedPA } from './season';
import { DEFAULT_SETTINGS } from './types';
import type { League, LeagueTeamRef, Team } from './types';

function team(seed: string, ownerUid: string): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid });
}

function ref(t: Team, isCPU: boolean): LeagueTeamRef {
  return {
    teamId: t.id,
    ownerUid: t.ownerUid,
    name: t.name,
    abbr: t.abbr,
    primaryColor: t.primaryColor,
    secondaryColor: t.secondaryColor,
    logoId: t.logoId,
    isCPU,
  };
}

/** 내 팀 하나와 CPU 셋으로 만든 리그, 내 첫 경기는 이겨 둔 상태 */
function setup(): { league: League; mine: Team } {
  const mine = team('lg-mine', 'me');
  const cpus = [team('lg-a', 'cpu'), team('lg-b', 'cpu'), team('lg-c', 'cpu')];
  const league = createLeague(
    'me',
    '테스트 리그',
    [ref(mine, false), ...cpus.map((c) => ref(c, true))],
    DEFAULT_SETTINGS,
    1,
    cpus,
  );
  const g = nextGameFor(league, mine.id)!;
  const mineIsAway = g.awayTeamId === mine.id;
  return { league: recordResult(league, g.id, mineIsAway ? 5 : 1, mineIsAway ? 1 : 5), mine };
}

describe('relinkPlayerTeam', () => {
  it('사라진 팀 ID를 새 팀으로 갈아끼우고 승패 기록을 그대로 옮긴다', () => {
    const { league, mine } = setup();
    const before = computeStandings(league).find((r) => r.teamId === mine.id)!;
    expect(before.w).toBe(1);

    // 스키마 버전이 올라 옛 팀이 사라지고, 같은 계정으로 새로 창단한 상황
    const reborn = { ...team('lg-reborn', 'me'), name: '새 구단', abbr: '새구' };
    const fixed = relinkPlayerTeam(league, reborn);

    expect(fixed.teams.some((t) => t.teamId === mine.id)).toBe(false);
    expect(fixed.schedule.some((g) => g.awayTeamId === mine.id || g.homeTeamId === mine.id)).toBe(
      false,
    );

    const after = computeStandings(fixed).find((r) => r.teamId === reborn.id)!;
    expect(after.w).toBe(1);
    expect(after.rf).toBe(before.rf);
    expect(after.ra).toBe(before.ra);
    expect(after.name).toBe('새 구단');
  });

  it('남은 일정은 새 팀 ID로 이어서 치를 수 있다', () => {
    const { league } = setup();
    const reborn = team('lg-reborn', 'me');
    const fixed = relinkPlayerTeam(league, reborn);

    const next = nextGameFor(fixed, reborn.id);
    expect(next).toBeDefined();
    expect(next!.awayTeamId === reborn.id || next!.homeTeamId === reborn.id).toBe(true);
  });

  it('CPU 팀과 다른 계정의 참가 기록은 건드리지 않는다', () => {
    const { league } = setup();
    const reborn = team('lg-reborn', 'me');
    const fixed = relinkPlayerTeam(league, reborn);

    const cpuBefore = league.teams.filter((t) => t.isCPU);
    expect(fixed.teams.filter((t) => t.isCPU)).toEqual(cpuBefore);
    expect(fixed.schedule).toHaveLength(league.schedule.length);
  });

  it('이미 맞는 팀을 가리키거나 참가 기록이 없으면 원본을 그대로 돌려준다', () => {
    const { league, mine } = setup();
    expect(relinkPlayerTeam(league, mine)).toBe(league);
    expect(relinkPlayerTeam(league, team('lg-other', 'someone-else'))).toBe(league);
  });
});

// ---------------------------------------------------------------------------
// 포스트시즌
// ---------------------------------------------------------------------------

/** 팀 n개짜리 리그를 만들고 정규 일정을 전부 소화한다. 승수는 seed로 갈린다. */
function finishedLeague(n: number, rounds = 1): { league: League; teams: Team[] } {
  const teams = Array.from({ length: n }, (_, i) => team(`ps-${i}`, i === 0 ? 'me' : 'cpu'));
  let league = createLeague(
    'me',
    '포스트시즌 리그',
    teams.map((t, i) => ref(t, i !== 0)),
    DEFAULT_SETTINGS,
    rounds,
    teams.slice(1),
  );
  // 앞 순번 팀이 이기게 해서 순위를 결정론적으로 만든다
  const rank = new Map(teams.map((t, i) => [t.id, i]));
  for (const g of league.schedule) {
    const awayBetter = rank.get(g.awayTeamId)! < rank.get(g.homeTeamId)!;
    league = recordResult(league, g.id, awayBetter ? 4 : 1, awayBetter ? 1 : 4);
  }
  return { league, teams };
}

/** 시리즈를 winnerId가 정해질 때까지 진행한다. hiSeedWins면 상위 시드가 이긴다. */
function playSeries(league: League, seriesId: string, hiSeedWins: boolean): League {
  let l = league;
  for (let i = 0; i < 10; i++) {
    const s = l.postseason!.series.find((x) => x.id === seriesId);
    if (!s || s.winnerId) break;
    const g = s.games.find((x) => x.status === 'SCHEDULED');
    if (!g) break;
    const hiIsAway = g.awayTeamId === s.hiSeedId;
    const awayWins = hiIsAway === hiSeedWins;
    l = recordPostseasonResult(l, g.id, awayWins ? 3 : 1, awayWins ? 1 : 3);
  }
  return l;
}

describe('포스트시즌 대진', () => {
  it('정규 시즌이 끝나야 시작된다', () => {
    const { league } = setup(); // 아직 일정이 남아 있다
    expect(startPostseason(league).postseason).toBeUndefined();
  });

  it('5팀 이상이면 상위 4팀이 준결승 1-4 / 2-3으로 붙는다', () => {
    const { league } = finishedLeague(6);
    const ps = startPostseason(league).postseason!;
    const rows = computeStandings(league);

    expect(ps.series).toHaveLength(2);
    expect(ps.series.every((s) => s.round === 1)).toBe(true);
    expect(ps.series[0].hiSeedId).toBe(rows[0].teamId);
    expect(ps.series[0].loSeedId).toBe(rows[3].teamId);
    expect(ps.series[1].hiSeedId).toBe(rows[1].teamId);
    expect(ps.series[1].loSeedId).toBe(rows[2].teamId);
  });

  it('4팀 이하면 상위 2팀이 곧바로 결승을 치른다', () => {
    const { league } = finishedLeague(4);
    const ps = startPostseason(league).postseason!;
    expect(ps.series).toHaveLength(1);
    expect(ps.series[0].round).toBe(2);
    expect(ps.series[0].winsNeeded).toBe(PS_SEMI_WINS);
  });

  it('두 번 불러도 대진이 다시 만들어지지 않는다', () => {
    const { league } = finishedLeague(6);
    const once = startPostseason(league);
    expect(startPostseason(once)).toBe(once);
  });

  it('상위 시드가 홈을 더 많이 갖는다', () => {
    const { league } = finishedLeague(6);
    const s = startPostseason(league).postseason!.series[0];
    const hiHome = s.games.filter((g) => g.homeTeamId === s.hiSeedId).length;
    const loHome = s.games.filter((g) => g.homeTeamId === s.loSeedId).length;
    expect(hiHome).toBeGreaterThan(loHome);
    // 5전 3선승은 2-2-1
    expect(s.games).toHaveLength(5);
    expect(hiHome).toBe(3);
  });

  it('과반 승수에 닿는 즉시 시리즈가 끝나고 남은 경기가 사라진다', () => {
    const { league } = finishedLeague(6);
    const started = startPostseason(league);
    const done = playSeries(started, 'ps-s1', true);
    const s = done.postseason!.series.find((x) => x.id === 'ps-s1')!;

    expect(s.winnerId).toBe(s.hiSeedId);
    expect(seriesWins(s, s.hiSeedId)).toBe(PS_SEMI_WINS);
    // 3승으로 끝났으므로 최대 5경기 중 치른 것만 남는다
    expect(s.games.length).toBeLessThan(5);
    expect(s.games.every((g) => g.status === 'FINAL')).toBe(true);
  });

  it('준결승이 모두 끝나면 결승이 생기고, 정규 순위가 높은 쪽이 상위 시드다', () => {
    const { league } = finishedLeague(6);
    let l = startPostseason(league);
    const rows = computeStandings(league);

    l = playSeries(l, 'ps-s1', false); // 4번 시드가 1번 시드를 잡는다
    expect(l.postseason!.series.some((s) => s.round === 2)).toBe(false);
    l = playSeries(l, 'ps-s2', true); // 2번 시드가 올라온다

    const final = l.postseason!.series.find((s) => s.round === 2)!;
    expect(final.winsNeeded).toBe(PS_FINAL_WINS);
    expect(final.games).toHaveLength(7);
    // 올라온 두 팀은 2번 시드와 4번 시드. 상위 시드는 2번이어야 한다.
    expect(final.hiSeedId).toBe(rows[1].teamId);
    expect(final.loSeedId).toBe(rows[3].teamId);
  });

  it('결승이 끝나면 우승·준우승이 정해지고 보상이 나온다', () => {
    const { league } = finishedLeague(6);
    let l = startPostseason(league);
    l = playSeries(l, 'ps-s1', true);
    l = playSeries(l, 'ps-s2', true);
    l = playSeries(l, 'ps-f', true);

    const ps = l.postseason!;
    expect(ps.status).toBe('FINISHED');
    expect(ps.championTeamId).toBeDefined();
    expect(ps.runnerUpTeamId).toBeDefined();
    expect(ps.championTeamId).not.toBe(ps.runnerUpTeamId);

    expect(postseasonReward(l, ps.championTeamId!)!.title).toBe('CHAMPION');
    expect(postseasonReward(l, ps.runnerUpTeamId!)!.title).toBe('RUNNER_UP');
    // 4강에서 떨어진 팀은 못 받는다
    const loser = ps.series[0].loSeedId;
    if (loser !== ps.championTeamId && loser !== ps.runnerUpTeamId) {
      expect(postseasonReward(l, loser)).toBeNull();
    }
  });

  it('포스트시즌 결과는 정규 시즌 순위표를 건드리지 않는다', () => {
    const { league } = finishedLeague(6);
    const before = computeStandings(league);
    let l = startPostseason(league);
    l = playSeries(l, 'ps-s1', false);
    l = playSeries(l, 'ps-s2', false);

    const after = computeStandings(l);
    expect(after.map((r) => [r.teamId, r.w, r.l])).toEqual(before.map((r) => [r.teamId, r.w, r.l]));
  });

  it('내 다음 경기는 시리즈 안에서 한 경기씩만 나온다', () => {
    const { league, teams } = finishedLeague(6);
    const l = startPostseason(league);
    const rows = computeStandings(league);
    const topTeam = rows[0].teamId;

    const g = postseasonNextGameFor(l, topTeam)!;
    expect(g).toBeDefined();
    expect(g.awayTeamId === topTeam || g.homeTeamId === topTeam).toBe(true);
    // 다른 시리즈 경기는 내 팀 것이 아니다
    expect(pendingPostseasonGames(l, topTeam).every((x) => x.id !== g.id)).toBe(true);
    expect(teams.length).toBe(6);
  });

  it('보상 총량은 예전 리그 보상과 같다', () => {
    const regular = LEAGUE_PLACE_GOLD.reduce((a, b) => a + b, 0);
    const post = POSTSEASON_GOLD.champion + POSTSEASON_GOLD.runnerUp;
    expect(regular + post).toBe(21000);
  });

  it('팀 ID가 갈려도 대진이 이어진다', () => {
    const { league, teams } = finishedLeague(6);
    let l = startPostseason(league);
    l = playSeries(l, 'ps-s1', true);

    const reborn = { ...team('ps-reborn', 'me'), name: '새 구단' };
    const fixed = relinkPlayerTeam(l, reborn);

    const stale = teams[0].id;
    const inBracket = fixed.postseason!.series.flatMap((s) => [
      s.hiSeedId,
      s.loSeedId,
      ...s.games.flatMap((g) => [g.awayTeamId, g.homeTeamId]),
    ]);
    expect(inBracket.includes(stale)).toBe(false);
    expect(inBracket.includes(reborn.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CPU 선수 기록 집계
// ---------------------------------------------------------------------------

/** 리그의 CPU 팀 전체 안타 수 */
function cpuHits(l: League): number {
  return (l.cpuTeams ?? [])
    .flatMap((t) => t.players)
    .reduce((a, p) => a + p.season.h, 0);
}

/** 그 CPU 팀 선수들의 시즌 기록 합 */
function statsOf(l: League, teamId: string) {
  const t = cpuTeamOf(l, teamId);
  const ps = t?.players ?? [];
  return {
    h: ps.reduce((a, p) => a + p.season.h, 0),
    ip3: ps.reduce((a, p) => a + p.season.ip3, 0),
    w: ps.reduce((a, p) => a + p.season.w, 0),
    l: ps.reduce((a, p) => a + p.season.l, 0),
    g: ps.filter((p) => p.season.g > 0).length,
  };
}

/** CPU끼리 붙는 첫 경기를 한 판 돌려 기록까지 적는다 */
function playOneCpuGame(l: League, mineId: string): { league: League; gameId: string } {
  const g = l.schedule.find(
    (x) => x.status === 'SCHEDULED' && x.awayTeamId !== mineId && x.homeTeamId !== mineId,
  )!;
  const a = cpuTeamOf(l, g.awayTeamId)!;
  const h = cpuTeamOf(l, g.homeTeamId)!;
  const r = simulateGame(a, h, l.settings, `t-${g.id}`);
  return { league: recordGame(l, g.id, r.state), gameId: g.id };
}

describe('CPU 선수 기록 집계', () => {
  it('시뮬레이션한 경기의 CPU 로스터 델타가 리그 문서에 쌓인다', () => {
    const { league, mine } = setup();
    expect(cpuHits(league)).toBe(0);

    const { league: after, gameId } = playOneCpuGame(league, mine.id);
    const game = league.schedule.find((g) => g.id === gameId)!;

    expect(cpuHits(after)).toBeGreaterThan(0);
    expect(statsOf(after, game.awayTeamId).ip3).toBeGreaterThan(0);
    expect(statsOf(after, game.homeTeamId).g).toBeGreaterThan(8);
  });

  it('두 경기를 치르면 합산된다', () => {
    const { league, mine } = setup();
    const one = playOneCpuGame(league, mine.id).league;
    const two = playOneCpuGame(one, mine.id).league;
    expect(cpuHits(two)).toBeGreaterThan(cpuHits(one));
  });

  it('이미 끝난 경기를 다시 기록해도 두 번 쌓이지 않는다', () => {
    // 새로고침이나 중복 호출로 같은 경기가 두 번 들어와도 CPU 타율이 두 배가 되면 안 된다.
    const { league, mine } = setup();
    const { league: after, gameId } = playOneCpuGame(league, mine.id);

    const g = after.schedule.find((x) => x.id === gameId)!;
    const a = cpuTeamOf(after, g.awayTeamId)!;
    const h = cpuTeamOf(after, g.homeTeamId)!;
    const again = recordGame(after, gameId, simulateGame(a, h, after.settings, `t-${gameId}`).state);

    expect(again).toBe(after);
    expect(cpuHits(again)).toBe(cpuHits(after));
  });

  it('내 팀 기록은 리그 문서에 쌓지 않는다 (Team 문서와 이중 계산 방지)', () => {
    const { league, mine } = setup();
    const g = nextGameFor(league, mine.id)!;
    const foe = cpuTeamOf(league, g.awayTeamId === mine.id ? g.homeTeamId : g.awayTeamId)!;
    const [a, h] = g.awayTeamId === mine.id ? [mine, foe] : [foe, mine];
    const after = recordGame(league, g.id, simulateGame(a, h, league.settings, 'mine').state);

    // 내 팀은 cpuTeams에 없으므로 구조적으로 닿지 않는다
    expect(cpuTeamOf(after, mine.id)).toBeUndefined();
    expect(statsOf(after, foe.id).h).toBeGreaterThan(0);
  });

  it('cpuTeams가 없는 옛 리그는 원본을 그대로 돌려준다', () => {
    const { league, mine } = setup();
    const legacy: League = { ...league, cpuTeams: undefined };
    const g = legacy.schedule.find(
      (x) => x.status === 'SCHEDULED' && x.awayTeamId !== mine.id && x.homeTeamId !== mine.id,
    )!;
    const r = simulateGame(mine, mine, legacy.settings, 'legacy');
    const after = recordGame(legacy, g.id, r.state);

    expect(after.cpuTeams).toBeUndefined();
    expect(after.schedule.find((x) => x.id === g.id)!.status).toBe('FINAL');
  });

  it('승패는 경기 종료 시 마운드에 있던 투수에게만 붙고, 한 경기에 승 1 · 패 1이다', () => {
    const { league, mine } = setup();
    const { league: after, gameId } = playOneCpuGame(league, mine.id);
    const g = after.schedule.find((x) => x.id === gameId)!;
    const away = statsOf(after, g.awayTeamId);
    const home = statsOf(after, g.homeTeamId);

    expect(away.w + home.w).toBe(1);
    expect(away.l + home.l).toBe(1);
    // 이긴 쪽이 승, 진 쪽이 패
    const awayWon = g.awayScore! > g.homeScore!;
    expect(away.w).toBe(awayWon ? 1 : 0);
    expect(home.w).toBe(awayWon ? 0 : 1);
  });

  it('로테이션이 한 칸 돌아 다음 경기 선발이 바뀐다', () => {
    // 이걸 안 돌리면 CPU 팀이 영원히 1선발만 내서 다승·방어율 순위가 팀당 한 명으로 굳는다.
    const { league, mine } = setup();
    const { league: after, gameId } = playOneCpuGame(league, mine.id);
    const g = league.schedule.find((x) => x.id === gameId)!;

    for (const id of [g.awayTeamId, g.homeTeamId]) {
      const before = cpuTeamOf(league, id)!;
      const now = cpuTeamOf(after, id)!;
      expect(now.rotationIndex).toBe((before.rotationIndex + 1) % before.rotation.length);
    }
  });

  it('누적 기록을 품은 CPU 팀을 다시 경기에 넣어도 델타에 섞이지 않는다', () => {
    // engine.toTeamInGame이 season을 비우기 때문에 성립하는 불변식이다.
    const { league, mine } = setup();
    const one = playOneCpuGame(league, mine.id).league;
    const g = one.schedule.find(
      (x) => x.status === 'SCHEDULED' && x.awayTeamId !== mine.id && x.homeTeamId !== mine.id,
    )!;
    const a = cpuTeamOf(one, g.awayTeamId)!;
    const h = cpuTeamOf(one, g.homeTeamId)!;
    const r = simulateGame(a, h, one.settings, 'delta');

    for (const p of Object.values(r.state.away.roster)) {
      expect(p.season.g).toBeLessThanOrEqual(1);
      expect(p.season.h).toBeLessThan(8);
    }
  });
});

describe('리그 리더보드', () => {
  /** CPU끼리의 경기를 n판 치른 리그. 4팀 1라운드에서는 최대 3판이다. */
  function played(n: number): { league: League; mine: Team } {
    const { league, mine } = setup();
    let l = league;
    for (let i = 0; i < n; i++) l = playOneCpuGame(l, mine.id).league;
    return { league: l, mine };
  }

  it('CPU 선수가 팀 약칭과 함께 순위에 오른다', () => {
    const { league, mine } = played(3);
    const ranked = leagueRankedPlayers(league, mine);

    expect(ranked.length).toBeGreaterThan(10);
    expect(ranked.every((e) => e.teamAbbr.length > 0)).toBe(true);
    expect(ranked.some((e) => e.teamId !== mine.id)).toBe(true);
  });

  it('팀별 경기 수를 따로 세고, 그게 그 선수의 규정 타석 기준이 된다', () => {
    const { league, mine } = played(2);
    const counts = teamGameCounts(league);
    const ranked = leagueRankedPlayers(league, mine);

    for (const e of ranked) {
      expect(e.teamGames).toBe(counts.get(e.teamId) ?? 0);
    }
    // 아직 안 뛴 팀과 뛴 팀의 기준이 실제로 다르다
    expect(new Set(ranked.map((e) => e.teamGames)).size).toBeGreaterThan(1);
  });

  it('경기 수가 적은 팀의 1타수 1안타는 타율 1위가 되지 않는다', () => {
    const { league, mine } = played(3);
    const counts = teamGameCounts(league);
    const ranked = leagueRankedPlayers(league, mine).map((e) =>
      e.stat.ab > 0 ? e : { ...e, stat: { ...e.stat, ab: 1, h: 1, pa: 1 } },
    );
    // 1타수 1안타를 하나 심는다
    const spiked = [
      ...ranked,
      {
        playerId: 'spike',
        name: '한타석',
        teamId: [...counts.keys()][0],
        teamAbbr: 'SPK',
        stat: { ...ranked[0].stat, pa: 1, ab: 1, h: 1 },
        teamGames: [...counts.values()][0],
      },
    ];
    const top = computeLeaders(spiked, 'AVG', 5);
    expect(top.some((r) => r.playerId === 'spike')).toBe(false);
    expect(qualifiedPA([...counts.values()][0])).toBeGreaterThan(1);
  });

  it('리더보드 1위와 타이틀 수상자가 항상 같다', () => {
    const { league, mine } = played(3);
    const ranked = leagueRankedPlayers(league, mine);
    const titles = computeTitlesOf(ranked);

    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      const top = computeLeaders(ranked, t.id, 1)[0];
      expect(top?.playerId).toBe(t.playerId);
      expect(top?.value).toBe(t.value);
    }
  });

  it('부문마다 상위 N명까지만, 기록 순으로 나온다', () => {
    const { league, mine } = played(3);
    const ranked = leagueRankedPlayers(league, mine);
    const hr = computeLeaders(ranked, 'HR', 5);

    expect(hr.length).toBeLessThanOrEqual(5);
    const values = hr.map((r) => parseInt(r.value, 10));
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it('cpuTeams 없이 내 팀만으로도 리더보드가 만들어진다', () => {
    const { league, mine } = setup();
    const legacy: League = { ...league, cpuTeams: undefined };
    const withStats: Team = {
      ...mine,
      players: mine.players.map((p, i) =>
        i === 0 ? { ...p, season: { ...p.season, g: 3, pa: 12, ab: 10, h: 4, hr: 2 } } : p,
      ),
    };
    const ranked = leagueRankedPlayers(legacy, withStats);
    expect(ranked).toHaveLength(1);
    expect(computeLeaders(ranked, 'HR', 5)[0].name).toBe(withStats.players[0].name);
  });

  it('리그에 낀 내 팀을 못 찾으면 CPU 기록만 나온다', () => {
    const { league, mine } = played(2);
    const ranked = leagueRankedPlayers(league, null);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((e) => e.teamId !== mine.id)).toBe(true);
  });
});
