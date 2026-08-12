import { Rng, seedFromString } from './rng';
import {
  bullpenCandidates,
  changePitcher,
  createGame,
  currentBatter,
  preparePitch,
  resolvePitch,
} from './engine';
import {
  cpuOffenseCommand,
  decidePitch,
  decideSteal,
  decideSwing,
  shouldChangePitcher,
  type Difficulty,
} from './ai';
import { mergeSeason, outcomeOf } from './matchReward';
import { rankedOf, type RankedPlayer } from './season';
import type {
  GameSettings,
  GameState,
  Inventory,
  League,
  LeagueGame,
  LeagueTeamRef,
  Postseason,
  PostseasonSeries,
  StandingRow,
  Team,
} from './types';

// ---------------------------------------------------------------------------
// 일정 생성 (라운드 로빈)
// ---------------------------------------------------------------------------

/**
 * 서클 방식 라운드 로빈.
 * 팀 수가 홀수면 부전승(BYE)을 넣어 짝수로 맞춘다.
 * roundsPerOpponent 만큼 반복하며, 홀수 회차마다 홈/어웨이를 뒤집는다.
 */
export function buildSchedule(
  teams: LeagueTeamRef[],
  roundsPerOpponent: number,
  seed: number,
): LeagueGame[] {
  const rng = new Rng(seed);
  const ids = rng.shuffle(teams.map((t) => t.teamId));
  const hasBye = ids.length % 2 === 1;
  if (hasBye) ids.push('__BYE__');

  const n = ids.length;
  const half = n / 2;
  const games: LeagueGame[] = [];
  let gameNo = 0;

  for (let cycle = 0; cycle < roundsPerOpponent; cycle++) {
    const rotation = ids.slice();
    for (let round = 0; round < n - 1; round++) {
      for (let i = 0; i < half; i++) {
        const a = rotation[i];
        const b = rotation[n - 1 - i];
        if (a === '__BYE__' || b === '__BYE__') continue;
        // 사이클마다 홈/어웨이 교대
        const flip = (cycle + round) % 2 === 0;
        const away = flip ? a : b;
        const home = flip ? b : a;
        games.push({
          id: `g${gameNo++}`,
          round: cycle * (n - 1) + round + 1,
          awayTeamId: away,
          homeTeamId: home,
          status: 'SCHEDULED',
        });
      }
      // 첫 팀 고정, 나머지 회전
      const fixed = rotation[0];
      const rest = rotation.slice(1);
      rest.unshift(rest.pop()!);
      rotation.splice(0, rotation.length, fixed, ...rest);
    }
  }

  return games;
}

export function createLeague(
  ownerUid: string,
  name: string,
  teams: LeagueTeamRef[],
  settings: GameSettings,
  roundsPerOpponent: number,
  cpuTeams: Team[] = [],
): League {
  const id = `l_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name,
    ownerUid,
    teams,
    cpuTeams,
    schedule: buildSchedule(teams, roundsPerOpponent, seedFromString(id + name)),
    settings,
    roundsPerOpponent,
    createdAt: Date.now(),
    status: 'ACTIVE',
  };
}

// ---------------------------------------------------------------------------
// 순위표
// ---------------------------------------------------------------------------

export function computeStandings(league: League): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const t of league.teams) {
    rows.set(t.teamId, {
      teamId: t.teamId,
      name: t.name,
      abbr: t.abbr,
      primaryColor: t.primaryColor,
      w: 0,
      l: 0,
      t: 0,
      rf: 0,
      ra: 0,
      pct: 0,
      gb: 0,
      streak: '-',
    });
  }

  const recent = new Map<string, ('W' | 'L' | 'T')[]>();

  for (const g of league.schedule) {
    if (g.status !== 'FINAL' || g.awayScore == null || g.homeScore == null) continue;
    const a = rows.get(g.awayTeamId);
    const h = rows.get(g.homeTeamId);
    if (!a || !h) continue;
    a.rf += g.awayScore;
    a.ra += g.homeScore;
    h.rf += g.homeScore;
    h.ra += g.awayScore;

    const pushRecent = (id: string, r: 'W' | 'L' | 'T') => {
      const arr = recent.get(id) ?? [];
      arr.push(r);
      recent.set(id, arr);
    };

    if (g.awayScore > g.homeScore) {
      a.w += 1;
      h.l += 1;
      pushRecent(a.teamId, 'W');
      pushRecent(h.teamId, 'L');
    } else if (g.awayScore < g.homeScore) {
      h.w += 1;
      a.l += 1;
      pushRecent(h.teamId, 'W');
      pushRecent(a.teamId, 'L');
    } else {
      a.t += 1;
      h.t += 1;
      pushRecent(a.teamId, 'T');
      pushRecent(h.teamId, 'T');
    }
  }

  const list = [...rows.values()];
  for (const r of list) {
    const decided = r.w + r.l;
    r.pct = decided ? r.w / decided : 0;
    const rec = recent.get(r.teamId) ?? [];
    if (rec.length) {
      const last = rec[rec.length - 1];
      let count = 0;
      for (let i = rec.length - 1; i >= 0 && rec[i] === last; i--) count++;
      r.streak = `${count}${last === 'W' ? '승' : last === 'L' ? '패' : '무'}`;
    }
  }

  list.sort((a, b) => b.pct - a.pct || b.w - a.w || b.rf - b.ra - (a.rf - a.ra));
  if (list.length) {
    const top = list[0];
    for (const r of list) {
      r.gb = ((top.w - r.w) + (r.l - top.l)) / 2;
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// CPU vs CPU 자동 경기 시뮬레이션
// ---------------------------------------------------------------------------

export interface SimResult {
  awayScore: number;
  homeScore: number;
  state: GameState;
  innings: number;
}

/**
 * 관전 없이 경기를 끝까지 시뮬레이션한다.
 * 리그의 다른 CPU 팀 경기를 한 번에 처리할 때 쓴다.
 *
 * AI 판단에는 게임 RNG와 분리된 별도 RNG를 사용한다.
 * (게임 RNG를 소비하면 결정론적 재현이 깨진다)
 */
export function simulateGame(
  away: Team,
  home: Team,
  settings: GameSettings,
  seedSource: string,
  difficulty: Difficulty = 'NORMAL',
  maxPitches = 1200,
): SimResult {
  let state = createGame(away, home, settings, seedSource);
  const aiRng = new Rng(seedFromString(seedSource + ':ai'));

  let guard = 0;
  while (state.phase !== 'GAME_OVER' && guard < maxPitches) {
    guard++;
    if (state.phase === 'INNING_BREAK') state.phase = 'SETUP';

    // 지친 투수는 내린다. 이게 없으면 선발이 9이닝을 완투하며 140구를 던지고,
    // 후반에 제구가 무너져 볼넷과 득점이 실제보다 크게 부풀려진다.
    const defSide = state.half === 'TOP' ? 'home' : 'away';
    if (shouldChangePitcher(state, difficulty)) {
      const relief = bullpenCandidates(state, defSide)[0];
      if (relief) state = changePitcher(state, defSide, relief.id);
    }

    const pitchCmd = decidePitch(state, aiRng, difficulty);
    const steal = decideSteal(state, aiRng, difficulty);
    const traj = preparePitch(state, pitchCmd);
    const swing = decideSwing(state, traj, aiRng, difficulty);

    const res = resolvePitch(state, pitchCmd, { steal, swing });
    state = res.state;
  }

  return {
    awayScore: state.away.runs,
    homeScore: state.home.runs,
    state,
    innings: state.inning,
  };
}

/**
 * 리그에 박제된 내 팀 ID를 지금 쓰는 팀으로 이어붙인다.
 *
 * 팀 스키마 버전이 올라 옛 팀이 걸러지거나 팀을 지우고 다시 창단하면, 리그에는 사라진
 * 팀 ID만 남아 순위표·일정 어디에도 내 팀이 없는 상태가 된다. 승패와 득실은 일정에
 * 그대로 남아 있으므로 ID만 갈아끼우면 기록을 잃지 않고 이어서 진행할 수 있다.
 *
 * 이미 맞는 팀을 가리키고 있거나 참가 기록이 없으면 원본을 그대로 돌려준다.
 */
export function relinkPlayerTeam(league: League, team: Team): League {
  const ref = league.teams.find((t) => !t.isCPU && t.ownerUid === team.ownerUid);
  if (!ref || ref.teamId === team.id) return league;
  const staleId = ref.teamId;
  return {
    ...league,
    teams: league.teams.map((t) =>
      t.teamId === staleId
        ? {
            ...t,
            teamId: team.id,
            // 순위표와 참가 팀 카드가 옛 구단명을 계속 보여주지 않도록 브랜드도 함께 갱신한다.
            name: team.name,
            abbr: team.abbr,
            primaryColor: team.primaryColor,
            secondaryColor: team.secondaryColor,
            logoId: team.logoId,
          }
        : t,
    ),
    schedule: league.schedule.map((g) => relinkGame(g, staleId, team.id)),
    // 대진도 같이 잇는다. 일정만 고치면 정규 시즌은 이어지는데 포스트시즌만
    // 사라진 팀 ID를 붙들고 있어, 우승 판정과 보상이 영영 내 팀을 못 찾는다.
    postseason: league.postseason && {
      ...league.postseason,
      championTeamId: relinkId(league.postseason.championTeamId, staleId, team.id),
      runnerUpTeamId: relinkId(league.postseason.runnerUpTeamId, staleId, team.id),
      series: league.postseason.series.map((s) => ({
        ...s,
        hiSeedId: relinkId(s.hiSeedId, staleId, team.id)!,
        loSeedId: relinkId(s.loSeedId, staleId, team.id)!,
        winnerId: relinkId(s.winnerId, staleId, team.id),
        games: s.games.map((g) => relinkGame(g, staleId, team.id)),
      })),
    },
  };
}

function relinkId(id: string | undefined, staleId: string, freshId: string): string | undefined {
  return id === staleId ? freshId : id;
}

function relinkGame(g: LeagueGame, staleId: string, freshId: string): LeagueGame {
  if (g.awayTeamId !== staleId && g.homeTeamId !== staleId) return g;
  return {
    ...g,
    awayTeamId: g.awayTeamId === staleId ? freshId : g.awayTeamId,
    homeTeamId: g.homeTeamId === staleId ? freshId : g.homeTeamId,
  };
}

/** 다음에 치를 경기 (플레이어 팀 포함) */
export function nextGameFor(league: League, teamId: string): LeagueGame | undefined {
  return league.schedule.find(
    (g) => g.status === 'SCHEDULED' && (g.awayTeamId === teamId || g.homeTeamId === teamId),
  );
}

/** 직접 경기 URL을 열었을 때 플레이 가능한 내 경기인지 검증한다. */
export function leagueGameIssue(league: League, gameId: string, playerTeamId: string): string | null {
  const playerRef = league.teams.find((t) => t.teamId === playerTeamId);
  if (!playerRef || playerRef.isCPU) return '이 리그에 참가한 내 팀을 찾을 수 없습니다.';
  // 포스트시즌 경기도 같은 화면에서 치른다
  const game = findLeagueGame(league, gameId);
  if (!game) return '해당 리그 경기를 찾을 수 없습니다.';
  if (game.status === 'FINAL') return '이미 종료된 경기입니다. 결과와 보상은 다시 기록할 수 없습니다.';
  if (game.status !== 'SCHEDULED') return '이미 진행 중인 경기입니다.';
  if (game.awayTeamId !== playerTeamId && game.homeTeamId !== playerTeamId) {
    return '내 팀 경기가 아니므로 직접 플레이할 수 없습니다.';
  }
  const opponentId = game.awayTeamId === playerTeamId ? game.homeTeamId : game.awayTeamId;
  if (!league.teams.some((t) => t.teamId === opponentId)) return '상대 팀 정보를 찾을 수 없습니다.';
  return null;
}

/** 특정 라운드에서 아직 안 치른 경기들 */
export function pendingGamesInRound(league: League, round: number): LeagueGame[] {
  return league.schedule.filter((g) => g.round === round && g.status === 'SCHEDULED');
}

export function recordResult(
  league: League,
  gameId: string,
  awayScore: number,
  homeScore: number,
): League {
  const next: League = {
    ...league,
    schedule: league.schedule.map((g) =>
      g.id === gameId && g.status === 'SCHEDULED'
        ? { ...g, status: 'FINAL' as const, awayScore, homeScore, playedAt: Date.now() }
        : g,
    ),
  };
  // 마지막 경기가 끝나면 리그를 닫는다. 지금까지는 status가 영원히 ACTIVE로 남아
  // 우승도 보상도 없이 일정만 소진됐다.
  if (next.status === 'ACTIVE' && isLeagueComplete(next)) next.status = 'FINISHED';
  return next;
}

// ---------------------------------------------------------------------------
// 리그 종료 보상
//
// 아이템이 나오는 유일한 경로다. 경기 보상은 경험치와 골드뿐이고, 아이템은 리그를
// 끝까지 마쳐 1~3위 안에 들어야 받는다.
// ---------------------------------------------------------------------------

export function isLeagueComplete(l: League): boolean {
  return l.schedule.length > 0 && l.schedule.every((g) => g.status === 'FINAL');
}

/**
 * 정규 시즌 1위 / 2위 / 3위 골드.
 *
 * 포스트시즌이 생기면서 "정규 1위"와 "우승"이 갈렸다. 총 지급량은 예전(21,000G)
 * 그대로 두고 우승 쪽으로 옮겼다 — 정규 10,500 + 포스트시즌 10,500이다.
 * 그래야 골드 인플레이션 없이 "1위로 들어가도 단기전에서 지면 손해"가 성립한다.
 */
export const LEAGUE_PLACE_GOLD = [6000, 3000, 1500];

/** 정규 시즌 1위 / 2위 / 3위 아이템 */
export const LEAGUE_PLACE_ITEMS: Inventory[] = [
  { EXP_L: 2, EXP_M: 2, CURE_INJURY: 1, STAMINA_TONIC: 1 },
  { EXP_M: 2, EXP_S: 3, STAMINA_TONIC: 1 },
  { EXP_S: 3 },
];

/** 우승 / 준우승 골드 */
export const POSTSEASON_GOLD = { champion: 8000, runnerUp: 2500 };

/** 우승 / 준우승 아이템. 능력치초기화권은 이제 우승에서만 나온다. */
export const POSTSEASON_ITEMS: { champion: Inventory; runnerUp: Inventory } = {
  champion: { EXP_XL: 1, EXP_L: 2, RESET_STATS: 1, CURE_INJURY: 2, STAMINA_TONIC: 2 },
  runnerUp: { EXP_L: 1, EXP_M: 2, CURE_INJURY: 1 },
};

export interface LeagueFinishReward {
  rank: number;
  total: number;
  gold: number;
  items: Inventory;
}

/**
 * 리그가 끝났을 때 이 팀이 받을 보상. 4위 이하이거나 아직 안 끝났으면 null.
 * 한 번만 지급하도록 League.rewardedAt으로 막는 건 호출한 쪽의 책임이다.
 */
export function leagueFinishReward(league: League, teamId: string): LeagueFinishReward | null {
  if (!isLeagueComplete(league)) return null;
  const rows = computeStandings(league);
  const idx = rows.findIndex((r) => r.teamId === teamId);
  if (idx < 0 || idx >= LEAGUE_PLACE_GOLD.length) return null;
  return {
    rank: idx + 1,
    total: rows.length,
    gold: LEAGUE_PLACE_GOLD[idx],
    items: LEAGUE_PLACE_ITEMS[idx],
  };
}

// ---------------------------------------------------------------------------
// 포스트시즌
//
// 정규 일정을 다 치르면 순위대로 단기전을 붙인다. 새 시스템을 만드는 게 아니라
// **이미 있는 압력을 처음으로 쓰는 것**에 가깝다 — 로테이션은 경기마다 한 칸씩 돌고
// (Team.rotationIndex) 투수 피로는 경기 사이에 이월되므로(matchReward.nextFatigue),
// 선발 4명으로 5~7경기를 짜는 문제가 저절로 생긴다.
//
// 시리즈는 schedule이 아니라 postseason에 따로 담는다. computeStandings가 schedule을
// 통째로 훑어 승패를 세기 때문에, 여기 섞으면 정규 시즌 순위가 사라진다.
// ---------------------------------------------------------------------------

/** 준결승에 필요한 승수 (5전 3선승) */
export const PS_SEMI_WINS = 3;
/** 결승에 필요한 승수 (7전 4선승). 팀이 4개 이하면 결승도 5전 3선승이다. */
export const PS_FINAL_WINS = 4;
/** 준결승을 두려면 최소 이만큼의 팀이 필요하다 */
export const PS_SEMI_MIN_TEAMS = 5;

/** 시리즈 최대 경기 수 */
export function seriesMaxGames(winsNeeded: number): number {
  return winsNeeded * 2 - 1;
}

/**
 * 상위 시드가 홈인 경기인가. 7전 2-3-2, 5전 2-2-1, 3전 1-1-1.
 *
 * 상위 시드에게 홈을 하나 더 주는 것이 정규 시즌 순위의 값어치다. 이게 없으면
 * 힘들게 1위를 해도 단기전에서 아무 이득이 없다.
 */
export function hiSeedIsHome(gameIndex: number, winsNeeded: number): boolean {
  const max = seriesMaxGames(winsNeeded);
  if (max >= 7) return gameIndex < 2 || gameIndex >= 5;
  if (max >= 5) return gameIndex < 2 || gameIndex >= 4;
  return gameIndex !== 1;
}

function buildSeries(
  id: string,
  round: number,
  hiSeedId: string,
  loSeedId: string,
  winsNeeded: number,
): PostseasonSeries {
  const games: LeagueGame[] = [];
  for (let i = 0; i < seriesMaxGames(winsNeeded); i++) {
    const hiHome = hiSeedIsHome(i, winsNeeded);
    games.push({
      id: `${id}-${i}`,
      round,
      awayTeamId: hiHome ? loSeedId : hiSeedId,
      homeTeamId: hiHome ? hiSeedId : loSeedId,
      status: 'SCHEDULED',
    });
  }
  return { id, round, hiSeedId, loSeedId, winsNeeded, games };
}

/**
 * 정규 일정을 다 치른 리그에 대진을 만든다. 이미 있거나 아직 안 끝났으면 원본 그대로.
 *
 * 5팀 이상이면 상위 4팀이 준결승(1-4, 2-3)을 치르고 결승에 오른다.
 * 4팀 이하면 상위 2팀이 곧바로 결승을 치른다 — 두 팀뿐인 리그에서 준결승을 만들면
 * 같은 상대와 12경기를 붙게 된다.
 */
export function startPostseason(league: League): League {
  if (league.postseason || !isLeagueComplete(league)) return league;
  const rows = computeStandings(league);
  if (rows.length < 2) return league;

  const series: PostseasonSeries[] =
    rows.length >= PS_SEMI_MIN_TEAMS
      ? [
          buildSeries('ps-s1', 1, rows[0].teamId, rows[3].teamId, PS_SEMI_WINS),
          buildSeries('ps-s2', 1, rows[1].teamId, rows[2].teamId, PS_SEMI_WINS),
        ]
      : [buildSeries('ps-f', 2, rows[0].teamId, rows[1].teamId, PS_SEMI_WINS)];

  return { ...league, postseason: { status: 'ACTIVE', series } };
}

/** 시리즈에서 이 팀이 거둔 승수 */
export function seriesWins(s: PostseasonSeries, teamId: string): number {
  return s.games.filter(
    (g) =>
      g.status === 'FINAL' &&
      g.awayScore != null &&
      g.homeScore != null &&
      ((g.awayTeamId === teamId && g.awayScore > g.homeScore) ||
        (g.homeTeamId === teamId && g.homeScore > g.awayScore)),
  ).length;
}

/**
 * 승부가 갈렸으면 그 시리즈를 닫고 남은 경기를 지운다.
 *
 * 남겨 두면 "이미 끝난 시리즈에 예정 경기가 남아 있는" 상태가 되어, 다음 경기 찾기가
 * 치르지 않아도 될 경기를 계속 물어 온다.
 */
function settleSeries(s: PostseasonSeries): PostseasonSeries {
  if (s.winnerId) return s;
  const hi = seriesWins(s, s.hiSeedId);
  const lo = seriesWins(s, s.loSeedId);
  const winnerId = hi >= s.winsNeeded ? s.hiSeedId : lo >= s.winsNeeded ? s.loSeedId : undefined;
  if (!winnerId) return s;
  return { ...s, winnerId, games: s.games.filter((g) => g.status === 'FINAL') };
}

/** 준결승이 모두 끝났으면 결승을 만든다. 정규 순위가 높은 쪽이 상위 시드다. */
function advanceBracket(league: League, ps: Postseason): Postseason {
  const semis = ps.series.filter((s) => s.round === 1);
  if (!semis.length || ps.series.some((s) => s.round === 2)) return ps;
  if (!semis.every((s) => s.winnerId)) return ps;

  const order = computeStandings(league).map((r) => r.teamId);
  const winners = semis
    .map((s) => s.winnerId!)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return {
    ...ps,
    series: [...ps.series, buildSeries('ps-f', 2, winners[0], winners[1], PS_FINAL_WINS)],
  };
}

/** 결승이 끝났으면 우승/준우승을 확정한다 */
function crown(ps: Postseason): Postseason {
  const final = ps.series.find((s) => s.round === 2);
  if (!final?.winnerId) return ps;
  return {
    ...ps,
    status: 'FINISHED',
    championTeamId: final.winnerId,
    runnerUpTeamId: final.winnerId === final.hiSeedId ? final.loSeedId : final.hiSeedId,
  };
}

/** 포스트시즌 경기 결과를 기록하고 대진을 한 칸 굴린다 */
export function recordPostseasonResult(
  league: League,
  gameId: string,
  awayScore: number,
  homeScore: number,
): League {
  const ps = league.postseason;
  if (!ps) return league;

  const withResult: Postseason = {
    ...ps,
    series: ps.series.map((s) =>
      s.games.some((g) => g.id === gameId && g.status === 'SCHEDULED')
        ? settleSeries({
            ...s,
            games: s.games.map((g) =>
              g.id === gameId && g.status === 'SCHEDULED'
                ? { ...g, status: 'FINAL' as const, awayScore, homeScore, playedAt: Date.now() }
                : g,
            ),
          })
        : s,
    ),
  };

  return { ...league, postseason: crown(advanceBracket(league, withResult)) };
}

/** 포스트시즌에서 이 팀이 다음에 치를 경기 */
export function postseasonNextGameFor(league: League, teamId: string): LeagueGame | undefined {
  for (const s of league.postseason?.series ?? []) {
    if (s.winnerId) continue;
    const g = s.games.find(
      (x) => x.status === 'SCHEDULED' && (x.awayTeamId === teamId || x.homeTeamId === teamId),
    );
    if (g) return g;
  }
  return undefined;
}

/** 아직 안 치른 포스트시즌 경기 (내 경기 제외 — 같은 라운드를 먼저 소화시킬 때 쓴다) */
export function pendingPostseasonGames(league: League, exceptTeamId?: string): LeagueGame[] {
  const out: LeagueGame[] = [];
  for (const s of league.postseason?.series ?? []) {
    if (s.winnerId) continue;
    if (exceptTeamId && (s.hiSeedId === exceptTeamId || s.loSeedId === exceptTeamId)) continue;
    // 시리즈는 순서대로 치러야 하므로 한 번에 한 경기씩만 내보낸다
    const g = s.games.find((x) => x.status === 'SCHEDULED');
    if (g) out.push(g);
  }
  return out;
}

/** 일정과 포스트시즌을 통틀어 그 id의 경기를 찾는다 */
export function findLeagueGame(league: League, gameId: string): LeagueGame | undefined {
  return (
    league.schedule.find((g) => g.id === gameId) ??
    league.postseason?.series.flatMap((s) => s.games).find((g) => g.id === gameId)
  );
}

/** 포스트시즌 경기인가 */
export function isPostseasonGame(league: League, gameId: string): boolean {
  return !!league.postseason?.series.some((s) => s.games.some((g) => g.id === gameId));
}

export interface PostseasonReward {
  /** 'CHAMPION' | 'RUNNER_UP' */
  title: 'CHAMPION' | 'RUNNER_UP';
  gold: number;
  items: Inventory;
}

/** 포스트시즌이 끝났을 때 이 팀이 받을 보상. 4강 탈락이면 null. */
export function postseasonReward(league: League, teamId: string): PostseasonReward | null {
  const ps = league.postseason;
  if (ps?.status !== 'FINISHED') return null;
  if (ps.championTeamId === teamId) {
    return { title: 'CHAMPION', gold: POSTSEASON_GOLD.champion, items: POSTSEASON_ITEMS.champion };
  }
  if (ps.runnerUpTeamId === teamId) {
    return { title: 'RUNNER_UP', gold: POSTSEASON_GOLD.runnerUp, items: POSTSEASON_ITEMS.runnerUp };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CPU 선수 기록 · 리그 개인 순위
//
// simulateGame은 CPU 선수의 시즌 델타까지 전부 계산해 놓고 호출하는 쪽이 스코어만
// 꺼내 쓰는 바람에 통째로 버려졌다. 그래서 리그에 순위표는 있는데 개인 순위가 없었고,
// 타이틀도 내 팀 안에서만 잴 수 있었다.
//
// 쌓는 곳은 League.cpuTeams다 — 새 필드가 하나도 필요 없고(Player.season은 이미
// 필수 필드다), 무엇보다 **내 팀은 cpuTeams에 없으므로** Team 문서와의 이중 계산이
// 조건문이 아니라 데이터 배치로 막힌다.
// ---------------------------------------------------------------------------

/** 이 리그에 박제된 CPU 팀. 구버전 리그(cpuTeams 없음)면 undefined. */
export function cpuTeamOf(league: League, teamId: string): Team | undefined {
  return league.cpuTeams?.find((t) => t.id === teamId);
}

/**
 * 한 경기의 CPU 선수 델타를 리그 문서에 누적하고, 그 팀의 로테이션을 한 칸 돌린다.
 *
 * **로테이션을 여기서 돌리는 게 기록만큼 중요하다.** rotationIndex를 올리는 코드는
 * matchReward.applyMatchResult 하나뿐이고 그건 내 팀에만 돌아서, CPU 팀은 창단 이후
 * 영원히 1선발만 냈다(engine의 `rotation[rotationIndex % len]`). 기록을 쌓기 시작하면
 * 다승·방어율·탈삼진 순위가 팀당 한 명으로 굳어 리더보드가 통째로 망가진다.
 *
 * 승패는 경기 종료 시 마운드에 있던 투수에게만 붙인다 — applyMatchResult가
 * decisionPitcherId로 하는 것과 같은 규칙이다.
 */
export function mergeCpuGameStats(league: League, state: GameState): League {
  if (!league.cpuTeams?.length) return league;

  const sides = (['away', 'home'] as const).map((side) => ({
    inGame: state[side],
    outcome: outcomeOf(state.winner, side),
  }));

  let touched = false;
  const cpuTeams = league.cpuTeams.map((t) => {
    const s = sides.find((x) => x.inGame.teamId === t.id);
    if (!s) return t;
    touched = true;
    const rotationLen = Math.max(1, t.rotation.length);
    return {
      ...t,
      players: t.players.map((p) => {
        const line = s.inGame.roster[p.id]?.season;
        if (!line) return p;
        const decision =
          p.id === s.inGame.pitcherId
            ? {
                ...line,
                w: line.w + (s.outcome === 'WIN' ? 1 : 0),
                l: line.l + (s.outcome === 'LOSS' ? 1 : 0),
              }
            : line;
        return { ...p, season: mergeSeason(p.season, decision) };
      }),
      rotationIndex: (t.rotationIndex + 1) % rotationLen,
    };
  });

  return touched ? { ...league, cpuTeams } : league;
}

/**
 * 경기 결과와 CPU 기록을 한 번에 적는다.
 *
 * **이미 끝난 경기는 통째로 무시한다.** 점수만 막고 기록을 안 막으면 새로고침 한 번에
 * CPU 타율이 두 배가 된다. 이 가드가 이중 계산의 유일한 방어선이므로,
 * mergeCpuGameStats를 이 함수 밖에서 따로 부르면 안 된다.
 */
export function recordGame(league: League, gameId: string, state: GameState): League {
  const game = findLeagueGame(league, gameId);
  if (!game || game.status !== 'SCHEDULED') return league;

  const withStats = mergeCpuGameStats(league, state);
  const away = state.away.runs;
  const home = state.home.runs;
  return isPostseasonGame(withStats, gameId)
    ? recordPostseasonResult(withStats, gameId, away, home)
    : recordResult(withStats, gameId, away, home);
}

/**
 * 팀별로 치른 경기 수. 규정 타석·이닝의 분모다.
 *
 * 정규 시즌과 포스트시즌을 함께 센다. 순위표(computeStandings)가 정규만 세는 것과
 * 어긋나 보이지만 이유가 다르다 — 순위표는 "누가 정규 1위인가"를 정하는 장부라
 * 단기전 결과가 섞이면 시드 결정이 자기 자신을 참조하게 된다. 개인 기록은 "이 선수가
 * 실제로 뭘 했나"이고, 내 팀은 이미 포스트시즌 기록까지 Player.season에 쌓고 있다.
 */
export function teamGameCounts(league: League): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string) => out.set(id, (out.get(id) ?? 0) + 1);
  const games = [
    ...league.schedule,
    ...(league.postseason?.series.flatMap((s) => s.games) ?? []),
  ];
  for (const g of games) {
    if (g.status !== 'FINAL') continue;
    bump(g.awayTeamId);
    bump(g.homeTeamId);
  }
  return out;
}

/**
 * 리그 전체 개인 순위 원장.
 *
 * 장부가 두 곳으로 갈려 있다 — CPU는 리그 문서(cpuTeams), 내 팀은 Team 문서다.
 * 내 팀 기록에는 이 리그 밖에서 치른 CPU 대전까지 들어 있어 CPU와 완전히 대칭은
 * 아니다. 싸게 고칠 방법이 없으므로 화면에 그렇다고 적어 둔다.
 */
export function leagueRankedPlayers(league: League, myTeam: Team | null): RankedPlayer[] {
  const games = teamGameCounts(league);
  const out: RankedPlayer[] = [];

  for (const ref of league.teams) {
    const team = ref.isCPU ? cpuTeamOf(league, ref.teamId) : myTeam;
    if (!team || team.id !== ref.teamId) continue;
    out.push(...rankedOf(team.players, games.get(ref.teamId) ?? 0, ref.teamId, ref.abbr));
  }
  return out;
}
