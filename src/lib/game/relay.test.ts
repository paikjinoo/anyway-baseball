import { describe, expect, it } from 'vitest';
import { generateTeam } from './generator';
import { Rng } from './rng';
import {
  DEFAULT_SETTINGS,
  type PitchCommand,
  type PitchResult,
  type PlayResultKind,
  type SwingCommand,
} from './types';
import {
  advanceRelayState,
  applyRelayPitchResult,
  canAcceptRelayPitch,
  canAcceptRelaySwing,
  createRelayState,
  currentRelayBatter,
  currentRelayPitcher,
  forfeitRelayParticipant,
  isRelayHit,
  relayGameState,
  relayParticipant,
  relayStandings,
  resolveRelayPitch,
  resolveRelayPitchClockViolation,
  suggestRelayPick,
  validRelayRoundCounts,
  type RelayScoreEvent,
  type RelayState,
} from './relay';

function makeState(count: number, rounds: number): RelayState {
  const participants = Array.from({ length: count }, (_, index) => {
    const uid = `u${index}`;
    const team = generateTeam(new Rng(100 + index), {
      ownerUid: uid,
      id: `team-${index}`,
      name: `팀${index}`,
      abbr: `T${index}`,
    });
    return relayParticipant(uid, `선수${index}`, team, suggestRelayPick(team));
  });
  return createRelayState(participants, { roundCount: rounds, pitchSpeedScale: 0.55 }, 'relay-test');
}

function terminalResult(state: RelayState, kind: PlayResultKind): PitchResult {
  const game = relayGameState(state, DEFAULT_SETTINGS);
  return {
    pitchNumber: game.pitchCount + 1,
    swing: { swing: true, type: 'NORMAL', aimX: 0, aimY: 0, timingMs: 0 },
    contact: kind === 'SINGLE' || kind === 'HOME_RUN' || kind === 'GROUND_OUT' || kind === 'FLY_OUT',
    kind,
    stealResults: [],
    runnerMoves: [],
    fielders: [],
    outsRecorded: kind === 'STRIKEOUT' || kind === 'GROUND_OUT' || kind === 'FLY_OUT' ? 1 : 0,
    runsScored: 0,
    scoringPlayerIds: [],
    rbi: 0,
    description: String(kind),
    state: game,
    atBatEnded: true,
  };
}

const centerFastball: PitchCommand = {
  type: 'FOURSEAM',
  targetX: 0,
  targetY: 0,
  quickPitch: false,
};
const normalSwing: SwingCommand = {
  swing: true,
  type: 'NORMAL',
  aimX: 0,
  aimY: 0,
  timingMs: 0,
};

function seededPitch(seed: number, pitch = centerFastball, swing = normalSwing, balls = 0, strikes = 0) {
  const relay = makeState(2, 2);
  const game = relayGameState(relay, DEFAULT_SETTINGS);
  game.rngState = seed;
  game.balls = balls;
  game.strikes = strikes;
  return resolveRelayPitch(game, pitch, swing);
}

describe('릴레이 라운드 순환', () => {
  it('현재 인원수의 배수만 1~10에서 허용한다', () => {
    expect(validRelayRoundCounts(2)).toEqual([2, 4, 6, 8, 10]);
    expect(validRelayRoundCounts(3)).toEqual([3, 6, 9]);
    expect(validRelayRoundCounts(4)).toEqual([4, 8]);
    expect(validRelayRoundCounts(5)).toEqual([5, 10]);
    expect(validRelayRoundCounts(6)).toEqual([6]);
    expect(validRelayRoundCounts(7)).toEqual([7]);
  });

  for (const count of [2, 3, 4, 5, 6, 7]) {
    it(`${count}명 경기에서 투수·타격 기회를 똑같이 배정한다`, () => {
      const rounds = validRelayRoundCounts(count).at(-1)!;
      let state = makeState(count, rounds);
      const pitcherRounds = new Map<string, Set<number>>();
      const plateAppearances = new Map<string, number>();

      while (state.phase !== 'GAME_OVER') {
        const pitcher = currentRelayPitcher(state)!;
        const batter = currentRelayBatter(state)!;
        if (!pitcherRounds.has(pitcher.uid)) pitcherRounds.set(pitcher.uid, new Set());
        pitcherRounds.get(pitcher.uid)!.add(state.roundIndex);
        plateAppearances.set(batter.uid, (plateAppearances.get(batter.uid) ?? 0) + 1);
        state = advanceRelayState(applyRelayPitchResult(state, terminalResult(state, 'STRIKEOUT')));
      }

      const expectedPitcherRounds = rounds / count;
      const expectedPlateAppearances = rounds - expectedPitcherRounds;
      expect([...pitcherRounds.values()].map((roundSet) => roundSet.size)).toEqual(
        Array(count).fill(expectedPitcherRounds),
      );
      expect([...plateAppearances.values()]).toEqual(Array(count).fill(expectedPlateAppearances));
    });
  }
});

describe('릴레이 점수와 순위', () => {
  it.each([
    ['SINGLE', 1],
    ['WALK', 1],
    ['HIT_BY_PITCH', 1],
    ['HOME_RUN', 3],
    ['STRIKEOUT', 0],
    ['FLY_OUT', 0],
  ] as const)('%s 결과를 %d점으로 기록한다', (kind, expected) => {
    let state = makeState(2, 2);
    const batterUid = currentRelayBatter(state)!.uid;
    state = applyRelayPitchResult(state, terminalResult(state, kind));
    expect(relayStandings(state).find((row) => row.uid === batterUid)?.score).toBe(expected);
  });

  it('동점이면 홈런 수를 우선하고 이후에는 공동 순위로 둔다', () => {
    const state = makeState(3, 3);
    const event = (id: string, batterUid: string, outcome: 'HIT' | 'HOME_RUN', points: number): RelayScoreEvent => ({
      id,
      round: 1,
      pitcherUid: 'pitcher',
      batterUid,
      outcome,
      points,
    });
    state.scoreEvents = [
      event('a', 'u0', 'HOME_RUN', 3),
      event('b1', 'u1', 'HIT', 1),
      event('b2', 'u1', 'HIT', 1),
      event('b3', 'u1', 'HIT', 1),
      event('c', 'u2', 'HOME_RUN', 3),
    ];
    const rows = relayStandings(state);
    expect(rows.map((row) => [row.uid, row.rank])).toEqual([
      ['u0', 1],
      ['u2', 1],
      ['u1', 3],
    ]);
  });
});

describe('릴레이 판정과 입력 검증', () => {
  it.each([
    [1, 'SINGLE'],
    [5, 'GROUND_OUT'],
    [16, 'FOUL'],
    [19, 'HOME_RUN'],
    [21, 'FLY_OUT'],
  ] as const)('고정 시드 %d에서 %s 판정을 재현한다', (seed, expected) => {
    expect(seededPitch(seed).kind).toBe(expected);
  });

  it('볼·사구·삼진·헛스윙과 2스트라이크 파울을 고정 시드로 판정한다', () => {
    const take: SwingCommand = { ...normalSwing, swing: false };
    expect(seededPitch(1, { ...centerFastball, targetY: 2 }, take).kind).toBe('BALL');
    expect(seededPitch(1, centerFastball, take, 0, 2).kind).toBe('STRIKEOUT');
    expect(seededPitch(1, centerFastball, { ...normalSwing, aimX: 3, aimY: 3, timingMs: 500 }).kind)
      .toBe('STRIKE_SWINGING');

    const state = makeState(2, 2);
    const batter = currentRelayBatter(state)!;
    const bodyPitch = {
      ...centerFastball,
      targetX: batter.batter.bats === 'L' ? 3.2 : -3.2,
    };
    expect(seededPitch(3, bodyPitch, take).kind).toBe('HIT_BY_PITCH');

    const foul = seededPitch(16, centerFastball, normalSwing, 0, 2);
    expect(foul.kind).toBe('FOUL');
    expect(foul.state.strikes).toBe(2);
    expect(foul.atBatEnded).toBe(false);
  });

  it('타구 품질 경계값을 적용한다', () => {
    expect(isRelayHit(100, -25)).toBe(true);
    expect(isRelayHit(100, 50)).toBe(true);
    expect(isRelayHit(99.9, 10)).toBe(false);
    expect(isRelayHit(150, 50.1)).toBe(false);
  });

  it('네 번째 자동 볼은 볼넷과 1점으로 끝난다', () => {
    const state = makeState(2, 2);
    const game = relayGameState(state, DEFAULT_SETTINGS);
    game.balls = 3;
    const result = resolveRelayPitchClockViolation(game, 'DEFENSE');
    expect(result.kind).toBe('WALK');
    expect(result.atBatEnded).toBe(true);
    const scored = applyRelayPitchResult(state, result);
    expect(relayStandings(scored)[0].score).toBe(1);
  });

  it('현재 역할과 turnId·pitchSeq가 모두 맞는 입력만 허용한다', () => {
    const state = makeState(3, 3);
    const pitcher = currentRelayPitcher(state)!;
    const batter = currentRelayBatter(state)!;
    expect(canAcceptRelayPitch(state, pitcher.uid, state.turnId, 1)).toBe(true);
    expect(canAcceptRelayPitch(state, batter.uid, state.turnId, 1)).toBe(false);
    expect(canAcceptRelayPitch(state, pitcher.uid, state.turnId - 1, 1)).toBe(false);
    expect(canAcceptRelaySwing(state, batter.uid, state.turnId, 1)).toBe(true);
    expect(canAcceptRelaySwing(state, batter.uid, state.turnId, 2)).toBe(false);

    const after = applyRelayPitchResult(state, terminalResult(state, 'SINGLE'));
    expect(canAcceptRelaySwing(after, batter.uid, state.turnId, 1)).toBe(false);
  });

  it('현재 투수가 기권하면 미완료 라운드 점수를 롤백한다', () => {
    let state = makeState(3, 3);
    const pitcherUid = state.pitcherUid;
    state = advanceRelayState(applyRelayPitchResult(state, terminalResult(state, 'SINGLE')));
    state = applyRelayPitchResult(state, terminalResult(state, 'HOME_RUN'));
    expect(state.roundEvents).toHaveLength(2);
    state = forfeitRelayParticipant(state, pitcherUid);
    expect(state.roundEvents).toHaveLength(0);
    expect(state.roundIndex).toBe(1);
    expect(relayStandings(state).every((row) => row.score === 0)).toBe(true);
  });
});
