import { Rng, seedFromString } from './rng';
import { createGame, currentBatter, preparePitch, resolvePitch } from './engine';
import { cpuOffenseCommand, decidePitch, decideSteal, decideSwing, type Difficulty } from './ai';
import type {
  GameSettings,
  GameState,
  League,
  LeagueGame,
  LeagueTeamRef,
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
): League {
  const id = `l_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name,
    ownerUid,
    teams,
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

/** 다음에 치를 경기 (플레이어 팀 포함) */
export function nextGameFor(league: League, teamId: string): LeagueGame | undefined {
  return league.schedule.find(
    (g) => g.status === 'SCHEDULED' && (g.awayTeamId === teamId || g.homeTeamId === teamId),
  );
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
  return {
    ...league,
    schedule: league.schedule.map((g) =>
      g.id === gameId ? { ...g, status: 'FINAL' as const, awayScore, homeScore, playedAt: Date.now() } : g,
    ),
  };
}
