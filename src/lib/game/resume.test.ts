import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { createGame, resolvePitch } from './engine';
import {
  CPU_RESUME_KEY,
  RESUME_MAX_AGE_MS,
  buildSuspendedMatch,
  describeSuspended,
  isSuspendable,
  matchResumeKey,
  readSuspendedMatch,
  resumeIssue,
  savedAgoText,
  trimSuspendedMatches,
  type SuspendedMatch,
} from './resume';
import { DEFAULT_SETTINGS } from './types';
import type { GameState, OffenseCommand, PitchCommand, Runner } from './types';

/**
 * 이어서 하기.
 *
 * 여기서 재는 것은 하나다: **저장했다 되살린 경기가 나가지 않은 경기와 똑같이 흘러가는가.**
 * 나머지(누구 것인지·언제 것인지 가리는 검사)는 그 하나를 잘못 되살리지 않기 위한 울타리다.
 */

const NOW = 1_700_000_000_000;

function teamPair() {
  const away = generateTeam(new Rng(seedFromString('away')), { ownerUid: 'me', id: 'away' });
  const home = generateTeam(new Rng(seedFromString('home')), { ownerUid: 'cpu', id: 'home' });
  return { away, home };
}

function runner(playerId: string): Runner {
  return { playerId, responsiblePitcherId: 'p', stealing: false };
}

function newGame(): GameState {
  const { away, home } = teamPair();
  return createGame(away, home, DEFAULT_SETTINGS, 'resume-test');
}

/** i번째 투구 명령. 난수를 쓰지 않아 두 번 돌려도 같은 순서가 나온다. */
function scriptedPitch(i: number): PitchCommand {
  return {
    type: 'FOURSEAM',
    targetX: ((i % 5) - 2) * 0.4,
    targetY: ((i % 3) - 1) * 0.5,
    quickPitch: i % 7 === 0,
  };
}

function scriptedOffense(i: number): OffenseCommand {
  return {
    steal: [],
    swing: {
      swing: i % 3 !== 0,
      type: i % 11 === 0 ? 'POWER' : 'NORMAL',
      aimX: ((i % 4) - 1.5) * 0.3,
      aimY: ((i % 5) - 2) * 0.3,
      timingMs: ((i * 37) % 90) - 45,
    },
  };
}

/** 공을 n개 던진다. 공수 교대는 matchStore.advance()가 하는 것과 같이 넘긴다. */
function playPitches(from: GameState, n: number, offset = 0): GameState {
  let s = from;
  for (let i = 0; i < n; i++) {
    if (s.phase === 'GAME_OVER') break;
    if (s.phase === 'INNING_BREAK') s = { ...s, phase: 'SETUP' };
    s = resolvePitch(s, scriptedPitch(offset + i), scriptedOffense(offset + i)).state;
  }
  return s;
}

function saveOf(state: GameState, patch: Partial<SuspendedMatch> = {}): SuspendedMatch {
  return {
    ...buildSuspendedMatch({
      key: CPU_RESUME_KEY,
      uid: 'me',
      teamId: 'away',
      savedAt: NOW,
      rewardKind: 'CPU',
      difficulty: 'NORMAL',
      playerSide: 'away',
      leagueRef: null,
      aiRngState: 12345,
      state,
      log: [{ id: 0, text: '1회 초 시작', kind: 'inning' }],
    }),
    ...patch,
  };
}

/** 저장소를 지난 것과 같은 상태로 만든다 (JSON 직렬화 한 번). */
function roundTrip(saved: SuspendedMatch): SuspendedMatch {
  const back = readSuspendedMatch(JSON.parse(JSON.stringify(saved)));
  expect(back).not.toBeNull();
  return back!;
}

describe('저장 → 복원', () => {
  it('되살린 경기는 나가지 않은 경기와 한 공도 다르지 않다', () => {
    const mid = playPitches(newGame(), 60);
    // 중간에 나갔다 — 저장하고, 저장소를 지나 다시 읽는다
    const restored = roundTrip(saveOf(mid));

    const keptPlaying = playPitches(mid, 40, 60);
    const resumed = playPitches(restored.state, 40, 60);

    expect(resumed).toEqual(keptPlaying);
  });

  it('점수·카운트·주자·투수 기록이 그대로 돌아온다', () => {
    const mid = playPitches(newGame(), 120);
    const restored = roundTrip(saveOf(mid)).state;

    expect(restored.inning).toBe(mid.inning);
    expect(restored.half).toBe(mid.half);
    expect(restored.outs).toBe(mid.outs);
    expect(restored.balls).toBe(mid.balls);
    expect(restored.strikes).toBe(mid.strikes);
    expect(restored.rngState).toBe(mid.rngState);
    expect(restored.pitchCount).toBe(mid.pitchCount);
    expect(restored.away.runs).toBe(mid.away.runs);
    expect(restored.home.runs).toBe(mid.home.runs);
    expect(restored.away.pitcherPitches).toBe(mid.away.pitcherPitches);
    // 이 경기에서 쌓은 선수 기록(경기 후 보상의 근거)도 같이 돌아와야 한다
    const id = mid.away.lineup[0];
    expect(restored.away.roster[id].season).toEqual(mid.away.roster[id].season);
  });

  it('AI 난수는 저장된 상태에서 이어진다 (같은 판단을 반복하지 않는다)', () => {
    const live = new Rng(seedFromString('ai'));
    for (let i = 0; i < 9; i++) live.next();

    const resumed = new Rng(live.state);
    expect([resumed.next(), resumed.next()]).toEqual(
      (() => {
        const shadow = new Rng(live.state);
        return [shadow.next(), shadow.next()];
      })(),
    );
    // 처음부터 다시 감으면 같은 값이 다시 나온다 — 그래서 상태를 저장한다
    const restarted = new Rng(seedFromString('ai'));
    expect(restarted.next()).not.toBe(new Rng(live.state).next());
  });

  it('다시 보기 클립은 담지 않는다 (매 투구 쓰기가 다섯 배로 불어난다)', () => {
    const saved = saveOf(newGame());
    expect(Object.keys(saved)).not.toContain('clips');
  });
});

describe('읽기', () => {
  it('형식이 아니면 null이다', () => {
    expect(readSuspendedMatch(null)).toBeNull();
    expect(readSuspendedMatch('저장')).toBeNull();
    expect(readSuspendedMatch({})).toBeNull();
  });

  it('버전이 다른 저장은 버린다', () => {
    const saved = roundTripSafe({ ...saveOf(newGame()), version: 99 });
    expect(saved).toBeNull();
  });

  it('엔진 상태가 깨져 있으면 버린다', () => {
    expect(roundTripSafe({ ...saveOf(newGame()), state: { id: 'x' } })).toBeNull();
    expect(roundTripSafe({ ...saveOf(newGame()), playerSide: 'left' })).toBeNull();
  });

  function roundTripSafe(doc: unknown) {
    return readSuspendedMatch(JSON.parse(JSON.stringify(doc)));
  }
});

describe('이어서 할 수 있는가', () => {
  const check = { uid: 'me', teamId: 'away' };

  it('저장한 그대로면 이어서 한다', () => {
    expect(resumeIssue(saveOf(newGame()), check, NOW + 60_000)).toBeNull();
  });

  it('다른 계정·다른 팀의 저장은 막는다', () => {
    expect(resumeIssue(saveOf(newGame()), { ...check, uid: 'other' }, NOW)).toBe('OWNER');
    // 보상은 지금 고른 팀으로 간다. 저장 시점과 다르면 엉뚱한 팀이 받는다.
    expect(resumeIssue(saveOf(newGame()), { ...check, teamId: 'other' }, NOW)).toBe('TEAM');
  });

  it('오래된 저장은 막는다', () => {
    expect(resumeIssue(saveOf(newGame()), check, NOW + RESUME_MAX_AGE_MS + 1)).toBe('EXPIRED');
  });

  it('이미 끝난 경기는 막는다', () => {
    const over: GameState = { ...newGame(), phase: 'GAME_OVER', winner: 'away' };
    expect(isSuspendable(over)).toBe(false);
    expect(resumeIssue(saveOf(over), check, NOW)).toBe('FINISHED');
  });

  it('리그에서 이미 처리된 경기는 막는다 (자동 진행으로 먼저 끝난 경우)', () => {
    const saved = saveOf(newGame(), {
      leagueRef: { leagueId: 'L1', gameId: 'g3' },
      key: matchResumeKey({ leagueId: 'L1', gameId: 'g3' }),
    });
    expect(resumeIssue(saved, { ...check, leagueGameStatus: 'FINAL' }, NOW)).toBe('LEAGUE_DONE');
    expect(resumeIssue(saved, { ...check, leagueGameStatus: 'SCHEDULED' }, NOW)).toBeNull();
  });
});

describe('슬롯', () => {
  it('리그 경기는 일정마다, CPU 경기는 하나로 묶인다', () => {
    expect(matchResumeKey(null)).toBe(CPU_RESUME_KEY);
    expect(matchResumeKey({ leagueId: 'L1', gameId: 'g1' })).not.toBe(
      matchResumeKey({ leagueId: 'L1', gameId: 'g2' }),
    );
    expect(matchResumeKey({ leagueId: 'L1', gameId: 'g1' })).not.toBe(
      matchResumeKey({ leagueId: 'L2', gameId: 'g1' }),
    );
  });

  it('넘치면 오래된 것부터 버린다', () => {
    const slots = {
      a: { savedAt: 300 },
      b: { savedAt: 100 },
      c: { savedAt: 200 },
      d: { savedAt: 400 },
    };
    expect(Object.keys(trimSuspendedMatches(slots, 2)).sort()).toEqual(['a', 'd']);
    expect(Object.keys(trimSuspendedMatches(slots, 9))).toHaveLength(4);
  });
});

describe('표시', () => {
  it('상황을 한 줄로 요약한다', () => {
    const s = newGame();
    const mid: GameState = {
      ...s,
      inning: 7,
      half: 'BOTTOM',
      outs: 1,
      away: { ...s.away, runs: 3 },
      home: { ...s.home, runs: 5 },
      bases: [runner(s.away.lineup[0]), null, runner(s.away.lineup[1])],
    };
    const info = describeSuspended(saveOf(mid));
    expect(info.inning).toBe('7회말');
    expect(info.situation).toBe('1사 1루·3루');
    expect(info.score).toBe(`${s.away.abbr} 3 : 5 ${s.home.abbr}`);
    expect(info.headline).toContain('7회말');
  });

  it('저장 시각을 사람이 읽는 말로 바꾼다', () => {
    expect(savedAgoText(NOW, NOW + 30_000)).toBe('방금 전');
    expect(savedAgoText(NOW, NOW + 5 * 60_000)).toBe('5분 전');
    expect(savedAgoText(NOW, NOW + 3 * 3600_000)).toBe('3시간 전');
    expect(savedAgoText(NOW, NOW + 50 * 3600_000)).toBe('2일 전');
  });
});
