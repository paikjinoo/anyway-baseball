import { effectiveBatSide, isFoul, judgeSwing, makeBattedBall } from './batting';
import { PITCH_DEFS } from './constants';
import { emptySeason, hitterScore, pitcherScore } from './generator';
import { computePitch, describeLocation } from './pitching';
import { Rng, seedFromString } from './rng';
import type {
  GameSettings,
  GameState,
  PitchClockViolation,
  PitchCommand,
  PitchResult,
  Player,
  SwingCommand,
  Team,
  TeamInGame,
  UniformType,
} from './types';

export const RELAY_MIN_PLAYERS = 2;
export const RELAY_MAX_PLAYERS = 7;
export const RELAY_MAX_ROUNDS = 10;
export const RELAY_HIT_EXIT_VELOCITY = 100;
export const RELAY_HIT_LAUNCH_MIN = -25;
export const RELAY_HIT_LAUNCH_MAX = 50;

export interface RelayRoomRules {
  /** null이면 현재 인원에 맞는 라운드를 아직 고르지 않은 상태다. */
  roundCount: number | null;
  pitchSpeedScale: number;
}

export interface RelayRules {
  roundCount: number;
  pitchSpeedScale: number;
}

export interface RelayPick {
  batterId: string;
  pitcherId: string;
}

export interface RelayLobbyPlayer {
  uid: string;
  name: string;
  teamId: string;
  teamName: string;
  teamAbbr: string;
  logoId: string;
  primaryColor: string;
  secondaryColor: string;
  ready: boolean;
  connected: boolean;
  pickedBatter: string;
  pickedPitcher: string;
}

export interface RelayTeamStyle {
  teamId: string;
  teamName: string;
  teamAbbr: string;
  logoId: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  uniformType: UniformType;
}

export interface RelayParticipant extends RelayTeamStyle {
  uid: string;
  name: string;
  batter: Player;
  pitcher: Player;
  forfeited: boolean;
}

export type RelayOutcome =
  | 'BALL'
  | 'CALLED_STRIKE'
  | 'SWINGING_STRIKE'
  | 'FOUL'
  | 'HIT'
  | 'HOME_RUN'
  | 'WALK'
  | 'HIT_BY_PITCH'
  | 'STRIKEOUT'
  | 'QUALITY_OUT';

export interface RelayScoreEvent {
  id: string;
  round: number;
  pitcherUid: string;
  batterUid: string;
  outcome: RelayOutcome;
  points: number;
}

export interface RelayState {
  id: string;
  rules: RelayRules;
  participants: RelayParticipant[];
  phase: 'PLAYING' | 'GAME_OVER';
  /** 0-base. 화면에는 +1 해서 표시한다. */
  roundIndex: number;
  pitcherUid: string;
  /** 이번 투수 라운드의 타자 순서. 기권자는 즉시 제거된다. */
  batterOrder: string[];
  batterIndex: number;
  balls: number;
  strikes: number;
  /** 현재 투수 라운드에서 던진 실제 투구 수. 다음 투수 때 0으로 초기화한다. */
  pitcherPitches: number;
  pitchCount: number;
  /** 네트워크 중복 입력 방지용. 타석이 바뀔 때 증가한다. */
  turnId: number;
  /** 판정(피치 클락 포함)이 하나 확정될 때마다 증가한다. */
  pitchSeq: number;
  rngState: number;
  /** 타석이 끝나 다음 타자/라운드로 넘길 준비가 되었는가. */
  awaitingAdvance: boolean;
  scoreEvents: RelayScoreEvent[];
  /** 현재 투수 라운드의 임시 점수. 투수 기권 시 전부 롤백한다. */
  roundEvents: RelayScoreEvent[];
  winnerUids: string[];
}

export interface RelayStanding {
  uid: string;
  name: string;
  score: number;
  homeRuns: number;
  hits: number;
  walks: number;
  hitByPitch: number;
  rank: number;
}

export function validRelayRoundCounts(playerCount: number): number[] {
  if (playerCount < RELAY_MIN_PLAYERS || playerCount > RELAY_MAX_PLAYERS) return [];
  const out: number[] = [];
  for (let n = playerCount; n <= RELAY_MAX_ROUNDS; n += playerCount) out.push(n);
  return out;
}

export function isValidRelayRoundCount(playerCount: number, roundCount: number | null): boolean {
  return roundCount !== null && validRelayRoundCounts(playerCount).includes(roundCount);
}

export function suggestRelayPick(team: Team): RelayPick {
  const batter = [...team.players]
    .filter((p) => p.position !== 'P')
    .sort((a, b) => hitterScore(b) - hitterScore(a))[0];
  const pitcher = [...team.players]
    .filter((p) => p.position === 'P' && p.pitching)
    .sort((a, b) => pitcherScore(b) - pitcherScore(a))[0];
  return { batterId: batter?.id ?? '', pitcherId: pitcher?.id ?? '' };
}

export function validateRelayPick(team: Team, pick: RelayPick): string | null {
  if (!pick || typeof pick.batterId !== 'string' || typeof pick.pitcherId !== 'string') {
    return '선수 선택 형식이 올바르지 않습니다.';
  }
  const batter = team.players.find((p) => p.id === pick.batterId);
  const pitcher = team.players.find((p) => p.id === pick.pitcherId);
  if (!batter || batter.position === 'P') return '소속 팀의 타자를 한 명 선택해 주세요.';
  if (!pitcher || pitcher.position !== 'P' || !pitcher.pitching) {
    return '소속 팀의 투수를 한 명 선택해 주세요.';
  }
  return null;
}

export function relayParticipant(uid: string, name: string, team: Team, pick: RelayPick): RelayParticipant {
  const batter = team.players.find((p) => p.id === pick.batterId);
  const pitcher = team.players.find((p) => p.id === pick.pitcherId);
  if (!batter || !pitcher || validateRelayPick(team, pick)) {
    throw new Error('릴레이 선수 선택이 올바르지 않습니다.');
  }
  return {
    uid,
    name,
    teamId: team.id,
    teamName: team.name,
    teamAbbr: team.abbr,
    logoId: team.logoId,
    primaryColor: team.primaryColor,
    secondaryColor: team.secondaryColor,
    accentColor: team.accentColor,
    uniformType: team.uniformType,
    batter: clonePlayer(batter),
    pitcher: clonePlayer(pitcher),
    forfeited: false,
  };
}

export function createRelayState(
  participants: RelayParticipant[],
  rules: RelayRules,
  seedSource: string,
): RelayState {
  if (!isValidRelayRoundCount(participants.length, rules.roundCount)) {
    throw new Error('현재 인원에 맞는 라운드 수가 아닙니다.');
  }
  if (participants.length < RELAY_MIN_PLAYERS || participants.length > RELAY_MAX_PLAYERS) {
    throw new Error('릴레이 대결은 2명부터 7명까지 가능합니다.');
  }
  const firstPitcher = participants[0];
  return {
    id: seedSource,
    rules,
    participants: structuredClone(participants),
    phase: 'PLAYING',
    roundIndex: 0,
    pitcherUid: firstPitcher.uid,
    batterOrder: batterOrderFor(participants, firstPitcher.uid),
    batterIndex: 0,
    balls: 0,
    strikes: 0,
    pitcherPitches: 0,
    pitchCount: 0,
    turnId: 1,
    pitchSeq: 0,
    rngState: seedFromString(seedSource),
    awaitingAdvance: false,
    scoreEvents: [],
    roundEvents: [],
    winnerUids: [],
  };
}

export function currentRelayPitcher(state: RelayState): RelayParticipant | null {
  return state.participants.find((p) => p.uid === state.pitcherUid) ?? null;
}

export function currentRelayBatter(state: RelayState): RelayParticipant | null {
  const uid = state.batterOrder[state.batterIndex];
  return state.participants.find((p) => p.uid === uid) ?? null;
}

export function canAcceptRelayPitch(
  state: RelayState,
  senderUid: string,
  turnId: number,
  pitchSeq: number,
): boolean {
  return (
    state.phase === 'PLAYING' &&
    !state.awaitingAdvance &&
    currentRelayPitcher(state)?.uid === senderUid &&
    state.turnId === turnId &&
    state.pitchSeq + 1 === pitchSeq
  );
}

export function canAcceptRelaySwing(
  state: RelayState,
  senderUid: string,
  turnId: number,
  pitchSeq: number,
): boolean {
  return (
    state.phase === 'PLAYING' &&
    !state.awaitingAdvance &&
    currentRelayBatter(state)?.uid === senderUid &&
    state.turnId === turnId &&
    state.pitchSeq + 1 === pitchSeq
  );
}

export function relayStandings(state: RelayState): RelayStanding[] {
  const events = [...state.scoreEvents, ...state.roundEvents];
  const rows = state.participants
    .filter((p) => !p.forfeited)
    .map((p) => {
      const mine = events.filter((e) => e.batterUid === p.uid);
      return {
        uid: p.uid,
        name: p.name,
        score: mine.reduce((sum, e) => sum + e.points, 0),
        homeRuns: mine.filter((e) => e.outcome === 'HOME_RUN').length,
        hits: mine.filter((e) => e.outcome === 'HIT').length,
        walks: mine.filter((e) => e.outcome === 'WALK').length,
        hitByPitch: mine.filter((e) => e.outcome === 'HIT_BY_PITCH').length,
        rank: 0,
      };
    })
    .sort((a, b) => b.score - a.score || b.homeRuns - a.homeRuns || a.name.localeCompare(b.name, 'ko'));

  let prior: RelayStanding | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    row.rank = prior && row.score === prior.score && row.homeRuns === prior.homeRuns ? prior.rank : i + 1;
    prior = row;
  }
  return rows;
}

/** PitchResult의 카운트/RNG를 릴레이 점수 원장에 반영한다. */
export function applyRelayPitchResult(state: RelayState, result: PitchResult): RelayState {
  if (state.phase === 'GAME_OVER') return state;
  const next = structuredClone(state);
  next.balls = result.state.balls;
  next.strikes = result.state.strikes;
  next.pitcherPitches = result.state.home.pitcherPitches;
  next.pitchCount = result.state.pitchCount;
  next.rngState = result.state.rngState;
  next.pitchSeq += 1;

  if (!result.atBatEnded) return next;
  const outcome = relayOutcomeOf(result);
  const batter = currentRelayBatter(next);
  if (batter) {
    next.roundEvents.push({
      id: `${next.turnId}:${next.pitchSeq}`,
      round: next.roundIndex + 1,
      pitcherUid: next.pitcherUid,
      batterUid: batter.uid,
      outcome,
      points: relayPoints(outcome),
    });
  }
  next.awaitingAdvance = true;
  return next;
}

/** 결과 연출이 끝난 뒤 다음 투구/타자/라운드로 이동한다. */
export function advanceRelayState(state: RelayState): RelayState {
  if (state.phase === 'GAME_OVER') return state;
  const next = structuredClone(state);

  if (!next.awaitingAdvance) return next;
  if (next.batterIndex + 1 < next.batterOrder.length) {
    next.batterIndex += 1;
    resetPlateAppearance(next);
    return next;
  }
  return finishRelayRound(next, true);
}

export function forfeitRelayParticipant(state: RelayState, uid: string): RelayState {
  if (state.phase === 'GAME_OVER') return state;
  const next = structuredClone(state);
  const participant = next.participants.find((p) => p.uid === uid);
  if (!participant || participant.forfeited) return next;
  participant.forfeited = true;

  const active = next.participants.filter((p) => !p.forfeited);
  if (active.length <= 1) {
    next.phase = 'GAME_OVER';
    next.winnerUids = active.map((p) => p.uid);
    next.roundEvents = [];
    return next;
  }

  // 현재 투수가 나가면 공정성을 위해 아직 확정되지 않은 이 라운드 전체를 취소한다.
  if (next.pitcherUid === uid) {
    next.roundEvents = [];
    return finishRelayRound(next, false);
  }

  const removedAt = next.batterOrder.indexOf(uid);
  if (removedAt < 0) return next;
  const wasCurrent = removedAt === next.batterIndex;
  next.batterOrder.splice(removedAt, 1);
  if (removedAt < next.batterIndex) next.batterIndex -= 1;

  if (wasCurrent) {
    if (next.batterIndex >= next.batterOrder.length) return finishRelayRound(next, true);
    resetPlateAppearance(next);
  }
  return next;
}

/** 3D 장면과 기존 투구 패널이 읽을 수 있는 1타석짜리 GameState를 만든다. */
export function relayGameState(state: RelayState, localSettings: GameSettings): GameState {
  const pitcher = currentRelayPitcher(state) ?? state.participants[0];
  const batter = currentRelayBatter(state) ?? state.participants.find((p) => p.uid !== pitcher.uid) ?? pitcher;
  const settings: GameSettings = {
    ...localSettings,
    pitchSpeedScale: state.rules.pitchSpeedScale,
    useDH: true,
  };

  return {
    id: `${state.id}:${state.turnId}`,
    settings,
    away: relayTeamInGame(batter, 'BATTER', 0),
    home: relayTeamInGame(pitcher, 'PITCHER', state.pitcherPitches),
    inning: state.roundIndex + 1,
    half: 'TOP',
    outs: 0,
    balls: state.balls,
    strikes: state.strikes,
    bases: [null, null, null],
    lineScore: { away: [0], home: [0] },
    phase: state.phase === 'GAME_OVER' ? 'GAME_OVER' : 'SETUP',
    rngState: state.rngState,
    pitchCount: state.pitchCount,
    winner: state.phase === 'GAME_OVER' ? 'TIE' : undefined,
  };
}

/** 수비·주루를 제거한 릴레이 1구 판정. */
export function resolveRelayPitch(
  prev: GameState,
  pitchCmd: PitchCommand,
  swing: SwingCommand,
): PitchResult {
  const state = structuredClone(prev) as GameState;
  const rng = new Rng(state.rngState);
  const pitcher = state.home.roster[state.home.pitcherId];
  const batter = state.away.roster[state.away.lineup[0]];
  const cmd: PitchCommand = pitcher.pitching?.arsenal[pitchCmd.type]
    ? pitchCmd
    : { ...pitchCmd, type: 'FOURSEAM' };
  const trajectory = computePitch(rng, pitcher, cmd, state.home.pitcherPitches);
  state.home.pitcherPitches += 1;
  state.pitchCount += 1;

  const result = emptyRelayResult(state, swing);
  result.pitchNumber = state.pitchCount;
  result.trajectory = trajectory;

  // 몸쪽은 타자가 실제로 선 쪽으로 정해진다 (스위치히터는 투수에 따라 바뀐다)
  const batSide = effectiveBatSide(batter, pitcher);
  const insideEdge = batSide === 'L' ? 2.6 : -2.6;
  const hitByPitch =
    (batSide === 'L' ? trajectory.zoneX > insideEdge : trajectory.zoneX < insideEdge) &&
    Math.abs(trajectory.zoneY) < 1.6 &&
    rng.chance(0.3);
  if (hitByPitch && !swing.swing) {
    result.kind = 'HIT_BY_PITCH';
    result.description = `${batter.name}, 몸에 맞는 공! 1점을 얻습니다.`;
    finishRelayAtBat(state, result);
    return endRelayPitch(state, result, rng);
  }

  if (!swing.swing) {
    if (trajectory.isStrikeZone) {
      state.strikes += 1;
      result.kind = 'STRIKE_LOOKING';
      result.description = `${PITCH_DEFS[trajectory.type].ko} ${Math.round(trajectory.velocity)}km/h, ${describeLocation(trajectory.zoneX, trajectory.zoneY)} 스트라이크!`;
    } else {
      state.balls += 1;
      result.kind = 'BALL';
      result.description = `${PITCH_DEFS[trajectory.type].ko} ${Math.round(trajectory.velocity)}km/h, ${describeLocation(trajectory.zoneX, trajectory.zoneY)} 볼.`;
    }
    resolveRelayCount(state, batter, result);
    return endRelayPitch(state, result, rng);
  }

  const judged = judgeSwing(rng, batter, pitcher, trajectory, swing);
  if (judged.kind === 'WHIFF') {
    state.strikes += 1;
    result.kind = 'STRIKE_SWINGING';
    result.description = `${batter.name}, 헛스윙!`;
    resolveRelayCount(state, batter, result);
    return endRelayPitch(state, result, rng);
  }
  if (judged.kind === 'FOUL_TIP') {
    if (state.strikes < 2) state.strikes += 1;
    result.kind = 'FOUL';
    result.description = `${batter.name}, 파울팁.`;
    return endRelayPitch(state, result, rng);
  }

  result.contact = true;
  const battedBall = makeBattedBall(
    rng,
    batter,
    pitcher,
    swing,
    trajectory,
    judged.quality,
    judged.timingErr,
  );
  result.battedBall = battedBall;
  if (isFoul(battedBall.sprayAngle)) {
    if (state.strikes < 2) state.strikes += 1;
    result.kind = 'FOUL';
    result.description = `${batter.name}, 파울!`;
    return endRelayPitch(state, result, rng);
  }

  if (battedBall.overFence) {
    result.kind = 'HOME_RUN';
    result.description = `${batter.name}, 홈런! 비거리 ${Math.round(battedBall.distance)}m — 3점!`;
  } else if (isRelayHit(battedBall.exitVelocity, battedBall.launchAngle)) {
    result.kind = 'SINGLE';
    result.description = `${batter.name}, 좋은 타구! ${Math.round(battedBall.exitVelocity)}km/h — 1점!`;
  } else {
    result.kind = battedBall.launchAngle < 8 ? 'GROUND_OUT' : 'FLY_OUT';
    result.outsRecorded = 1;
    result.description = `${batter.name}, 타구 품질이 부족해 아웃.`;
  }
  finishRelayAtBat(state, result);
  return endRelayPitch(state, result, rng);
}

export function resolveRelayPitchClockViolation(
  prev: GameState,
  by: PitchClockViolation = 'DEFENSE',
): PitchResult {
  const state = structuredClone(prev) as GameState;
  const batter = state.away.roster[state.away.lineup[0]];
  const swing: SwingCommand = { swing: false, type: 'NORMAL', aimX: 0, aimY: 0, timingMs: 0 };
  const result = emptyRelayResult(state, swing);
  result.pitchClockViolation = by;
  if (by === 'DEFENSE') {
    state.balls += 1;
    result.kind = 'BALL';
    result.description = '피치 클락 위반! 자동 볼이 선언됩니다.';
  } else {
    state.strikes += 1;
    result.kind = 'STRIKE_LOOKING';
    result.description = '피치 클락 위반! 자동 스트라이크가 선언됩니다.';
  }
  resolveRelayCount(state, batter, result);
  result.state = state;
  return result;
}

export function isRelayHit(exitVelocity: number, launchAngle: number): boolean {
  return (
    exitVelocity >= RELAY_HIT_EXIT_VELOCITY &&
    launchAngle >= RELAY_HIT_LAUNCH_MIN &&
    launchAngle <= RELAY_HIT_LAUNCH_MAX
  );
}

function clonePlayer(player: Player): Player {
  const copy = structuredClone(player);
  copy.season = emptySeason();
  return copy;
}

function batterOrderFor(participants: RelayParticipant[], pitcherUid: string): string[] {
  const pitcherIndex = participants.findIndex((p) => p.uid === pitcherUid);
  if (pitcherIndex < 0) return [];
  const out: string[] = [];
  for (let offset = 1; offset < participants.length; offset++) {
    const p = participants[(pitcherIndex + offset) % participants.length];
    if (!p.forfeited) out.push(p.uid);
  }
  return out;
}

function resetPlateAppearance(state: RelayState) {
  state.balls = 0;
  state.strikes = 0;
  state.awaitingAdvance = false;
  state.turnId += 1;
}

function finishRelayRound(state: RelayState, commit: boolean): RelayState {
  if (commit) state.scoreEvents.push(...state.roundEvents);
  state.roundEvents = [];

  let roundIndex = state.roundIndex + 1;
  while (roundIndex < state.rules.roundCount) {
    const pitcher = state.participants[roundIndex % state.participants.length];
    if (!pitcher.forfeited) break;
    roundIndex += 1;
  }

  if (roundIndex >= state.rules.roundCount) {
    state.phase = 'GAME_OVER';
    const rows = relayStandings(state);
    const best = rows[0];
    state.winnerUids = best
      ? rows.filter((r) => r.score === best.score && r.homeRuns === best.homeRuns).map((r) => r.uid)
      : [];
    state.awaitingAdvance = false;
    return state;
  }

  const pitcher = state.participants[roundIndex % state.participants.length];
  state.roundIndex = roundIndex;
  state.pitcherUid = pitcher.uid;
  state.batterOrder = batterOrderFor(state.participants, pitcher.uid);
  state.batterIndex = 0;
  state.pitcherPitches = 0;
  resetPlateAppearance(state);
  return state;
}

function relayTeamInGame(
  participant: RelayParticipant,
  role: 'BATTER' | 'PITCHER',
  pitcherPitches: number,
): TeamInGame {
  const selected = role === 'BATTER' ? participant.batter : participant.pitcher;
  const player = clonePlayer(selected);
  player.id = `${role === 'BATTER' ? 'b' : 'p'}~${participant.uid}~${selected.id}`;
  return {
    teamId: participant.teamId,
    name: participant.teamName,
    abbr: participant.teamAbbr,
    primaryColor: participant.primaryColor,
    secondaryColor: participant.secondaryColor,
    accentColor: participant.accentColor,
    uniformType: participant.uniformType,
    logoId: participant.logoId,
    roster: { [player.id]: player },
    lineup: [player.id],
    atBatIndex: 0,
    pitcherId: player.id,
    pitcherPitches: role === 'PITCHER' ? pitcherPitches : 0,
    usedPitcherIds: role === 'PITCHER' ? [player.id] : [],
    usedBatterIds: [],
    defense: role === 'PITCHER' ? { P: player.id } : {},
    runs: 0,
    hits: 0,
    errors: 0,
    lob: 0,
  };
}

function emptyRelayResult(state: GameState, swing: SwingCommand): PitchResult {
  return {
    pitchNumber: state.pitchCount,
    swing,
    contact: false,
    kind: 'BALL',
    stealResults: [],
    runnerMoves: [],
    fielders: [],
    outsRecorded: 0,
    runsScored: 0,
    scoringPlayerIds: [],
    rbi: 0,
    description: '',
    state,
    atBatEnded: false,
  };
}

function finishRelayAtBat(state: GameState, result: PitchResult) {
  result.atBatEnded = true;
  state.balls = 0;
  state.strikes = 0;
}

function resolveRelayCount(state: GameState, batter: Player, result: PitchResult) {
  if (state.strikes >= 3) {
    result.kind = 'STRIKEOUT';
    result.outsRecorded = 1;
    result.description = `${batter.name}, 삼진 아웃!`;
    finishRelayAtBat(state, result);
  } else if (state.balls >= 4) {
    result.kind = 'WALK';
    result.description = `${batter.name}, 볼넷으로 1점을 얻습니다.`;
    finishRelayAtBat(state, result);
  }
}

function endRelayPitch(state: GameState, result: PitchResult, rng: Rng): PitchResult {
  state.rngState = rng.state;
  result.state = state;
  return result;
}

function relayOutcomeOf(result: PitchResult): RelayOutcome {
  switch (result.kind) {
    case 'HOME_RUN':
      return 'HOME_RUN';
    case 'SINGLE':
      return 'HIT';
    case 'WALK':
      return 'WALK';
    case 'HIT_BY_PITCH':
      return 'HIT_BY_PITCH';
    case 'STRIKEOUT':
      return 'STRIKEOUT';
    case 'GROUND_OUT':
    case 'FLY_OUT':
      return 'QUALITY_OUT';
    case 'FOUL':
      return 'FOUL';
    case 'STRIKE_SWINGING':
      return 'SWINGING_STRIKE';
    case 'STRIKE_LOOKING':
      return 'CALLED_STRIKE';
    default:
      return 'BALL';
  }
}

function relayPoints(outcome: RelayOutcome): number {
  if (outcome === 'HOME_RUN') return 3;
  return outcome === 'HIT' || outcome === 'WALK' || outcome === 'HIT_BY_PITCH' ? 1 : 0;
}
