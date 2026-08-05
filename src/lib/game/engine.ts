import { Rng, clamp, norm, seedFromString } from './rng';
import { computePitch, describeLocation, staminaRemaining } from './pitching';
import { judgeSwing, makeBattedBall, effectiveBatting } from './batting';
import { resolveFielding, type DefenseMap } from './fielding';
import { resolveAdvance, resolveSteals } from './baserunning';
import { PITCH_DEFS, POSITION_KO, SWING_DEFS } from './constants';
import { autoLineup, emptySeason } from './generator';
import type {
  GameSettings,
  GameState,
  OffenseCommand,
  PitchClockViolation,
  PitchCommand,
  PitchResult,
  PlayResultKind,
  Player,
  Position,
  Runner,
  RunnerMove,
  Side,
  StealResult,
  Team,
  TeamInGame,
} from './types';

// ---------------------------------------------------------------------------
// 경기 생성
// ---------------------------------------------------------------------------

function toTeamInGame(team: Team, settings: GameSettings): TeamInGame {
  const roster: Record<string, Player> = {};
  for (const p of team.players) {
    const copy = structuredClone(p);
    // GameState에는 시즌 누적값이 아니라 이번 경기에서 생긴 델타만 담는다.
    copy.season = emptySeason();
    roster[p.id] = copy;
  }

  const rotation = team.rotation.filter((id) => roster[id]);
  const pitcherId =
    rotation[0] ?? team.players.find((p) => p.position === 'P')?.id ?? team.players[0].id;

  let lineup = team.lineup.filter((id) => roster[id]);
  const storedLineupIsValid = lineup.length === 9 && new Set(lineup).size === 9;
  if (!storedLineupIsValid || !settings.useDH) lineup = autoLineup(team, settings.useDH);

  // DH 미사용 시 자동 타순이 고른 투수가 실제 선발과 다를 수 있으므로 맞춰 준다.
  if (!settings.useDH && !lineup.includes(pitcherId)) {
    const pitcherSlot = lineup.findIndex((id) => roster[id]?.position === 'P');
    lineup[pitcherSlot >= 0 ? pitcherSlot : lineup.length - 1] = pitcherId;
  }

  for (const id of new Set([...lineup, pitcherId])) {
    if (roster[id]) roster[id].season.g = 1;
  }

  return {
    teamId: team.id,
    name: team.name,
    abbr: team.abbr,
    primaryColor: team.primaryColor,
    secondaryColor: team.secondaryColor,
    accentColor: team.accentColor,
    uniformType: team.uniformType,
    logoId: team.logoId,
    roster,
    lineup,
    atBatIndex: 0,
    pitcherId,
    pitcherPitches: 0,
    usedPitcherIds: [pitcherId],
    defense: buildDefense(roster, lineup, pitcherId, settings.useDH),
    runs: 0,
    hits: 0,
    errors: 0,
    lob: 0,
  };
}

/** 라인업과 로스터로부터 수비 배치를 만든다. */
export function buildDefense(
  roster: Record<string, Player>,
  lineup: string[],
  pitcherId: string,
  useDH: boolean,
): Partial<Record<Position, string>> {
  const defense: Partial<Record<Position, string>> = { P: pitcherId };
  const need: Position[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
  const used = new Set<string>([pitcherId]);

  // 1) 라인업에서 본 포지션이 맞는 선수를 우선 배치
  for (const pos of need) {
    const id = lineup.find((x) => !used.has(x) && roster[x]?.position === pos);
    if (id) {
      defense[pos] = id;
      used.add(id);
    }
  }
  // 2) 남은 자리는 라인업의 남은 선수로 채운다
  for (const pos of need) {
    if (defense[pos]) continue;
    const id = lineup.find((x) => !used.has(x) && roster[x]?.position !== 'P');
    if (id) {
      defense[pos] = id;
      used.add(id);
    }
  }
  // 3) 그래도 비면 로스터에서 채운다
  for (const pos of need) {
    if (defense[pos]) continue;
    const id = Object.keys(roster).find((x) => !used.has(x) && roster[x].position !== 'P');
    if (id) {
      defense[pos] = id;
      used.add(id);
    }
  }
  if (!useDH) {
    // DH 미사용 시 투수가 타순에 들어간다 (라인업은 호출측에서 구성)
  }
  return defense;
}

export function createGame(
  away: Team,
  home: Team,
  settings: GameSettings,
  seedSource: string,
): GameState {
  const innings = settings.regulationInnings;
  return {
    id: seedSource,
    settings,
    away: toTeamInGame(away, settings),
    home: toTeamInGame(home, settings),
    inning: 1,
    half: 'TOP',
    outs: 0,
    balls: 0,
    strikes: 0,
    bases: [null, null, null],
    lineScore: { away: Array(innings).fill(0), home: Array(innings).fill(0) },
    phase: 'SETUP',
    rngState: seedFromString(seedSource),
    pitchCount: 0,
  };
}

// ---------------------------------------------------------------------------
// 조회 헬퍼
// ---------------------------------------------------------------------------

export function battingSide(s: GameState): Side {
  return s.half === 'TOP' ? 'away' : 'home';
}
export function fieldingSide(s: GameState): Side {
  return s.half === 'TOP' ? 'home' : 'away';
}
export function offense(s: GameState): TeamInGame {
  return s[battingSide(s)];
}
export function defenseTeam(s: GameState): TeamInGame {
  return s[fieldingSide(s)];
}
export function currentBatter(s: GameState): Player {
  const o = offense(s);
  const id = o.lineup[o.atBatIndex % o.lineup.length];
  return o.roster[id];
}
export function currentPitcher(s: GameState): Player {
  const d = defenseTeam(s);
  return d.roster[d.pitcherId];
}
export function currentCatcher(s: GameState): Player | undefined {
  const d = defenseTeam(s);
  const id = d.defense.C;
  return id ? d.roster[id] : undefined;
}
export function onDeckBatter(s: GameState): Player {
  const o = offense(s);
  return o.roster[o.lineup[(o.atBatIndex + 1) % o.lineup.length]];
}

function defenseMap(s: GameState): DefenseMap {
  const d = defenseTeam(s);
  const players: Partial<Record<Position, Player>> = {};
  for (const [pos, id] of Object.entries(d.defense)) {
    if (id && d.roster[id]) players[pos as Position] = d.roster[id];
  }
  return { players };
}

export function runnersOnBase(s: GameState): boolean[] {
  return [!!s.bases[0], !!s.bases[1], !!s.bases[2]];
}

/** 현재 이닝 라인스코어 인덱스. 연장이면 배열을 늘린다. */
function ensureLineScore(s: GameState) {
  const idx = s.inning - 1;
  if (s.lineScore.away.length <= idx) {
    s.lineScore.away.push(0);
    s.lineScore.home.push(0);
  }
}

// ---------------------------------------------------------------------------
// 투구 해석
// ---------------------------------------------------------------------------

/**
 * 투구 궤적만 미리 계산한다 (상태는 바꾸지 않는다).
 *
 * computePitch가 resolvePitch에서 RNG를 소비하는 첫 함수이므로,
 * 같은 state.rngState에서 시작하면 반드시 같은 궤적이 나온다.
 * 덕분에 "공을 던져서 날아가는 연출"을 먼저 보여주고, 타자의 스윙 입력을 받은 뒤
 * resolvePitch를 호출해도 결과가 어긋나지 않는다.
 */
export function preparePitch(state: GameState, pitchCmd: PitchCommand) {
  const rng = new Rng(state.rngState);
  const pitcher = currentPitcher(state);
  const def = defenseTeam(state);
  const cmd: PitchCommand = pitcher.pitching?.arsenal[pitchCmd.type]
    ? pitchCmd
    : { ...pitchCmd, type: 'FOURSEAM' };
  return computePitch(rng, pitcher, cmd, def.pitcherPitches);
}

/**
 * 피치 클락 위반을 해석한다.
 *
 * 공을 던지지 않았으므로 궤적도 없고 RNG도 소비하지 않는다.
 * (rngState가 그대로여야 다음 투구가 온라인 양쪽에서 같은 결과로 재현된다.
 *  투구 수·스태미나도 늘지 않는다 — 던진 공이 아니기 때문이다.)
 */
export function resolvePitchClockViolation(
  prev: GameState,
  by: PitchClockViolation,
): PitchResult {
  const s = structuredClone(prev) as GameState;
  const rng = new Rng(s.rngState);
  const batter = currentBatter(s);
  const pitcher = currentPitcher(s);

  const result: PitchResult = {
    pitchNumber: s.pitchCount,
    pitchClockViolation: by,
    swing: { swing: false, type: 'NORMAL', aimX: 0, aimY: 0, timingMs: 0 },
    contact: false,
    kind: by === 'DEFENSE' ? 'BALL' : 'STRIKE_LOOKING',
    stealResults: [],
    runnerMoves: [],
    fielders: [],
    outsRecorded: 0,
    runsScored: 0,
    scoringPlayerIds: [],
    rbi: 0,
    description: '',
    state: s,
    atBatEnded: false,
  };

  const notice =
    by === 'DEFENSE'
      ? `피치 클락 위반! ${pitcher.name}에게 자동 볼이 선언됩니다.`
      : `피치 클락 위반! ${batter.name}에게 자동 스트라이크가 선언됩니다.`;

  if (by === 'DEFENSE') s.balls += 1;
  else s.strikes += 1;

  // 볼넷·삼진이 되면 resolveCount가 실황을 덮어쓰므로 위반 사실을 앞에 붙인다
  resolveCount(s, batter, pitcher, result, rng);
  result.description = result.description ? `${notice} ${result.description}` : notice;

  endPitch(s, rng, result);
  return result;
}

export function resolvePitch(
  prev: GameState,
  pitchCmd: PitchCommand,
  offCmd: OffenseCommand,
): PitchResult {
  const s = structuredClone(prev) as GameState;
  const rng = new Rng(s.rngState);
  s.pitchCount += 1;

  const off = offense(s);
  const def = defenseTeam(s);
  const batter = currentBatter(s);
  const pitcher = currentPitcher(s);
  const catcher = currentCatcher(s);

  // 보유하지 않은 구종이면 직구로 대체 (부정 입력 방어)
  const cmd: PitchCommand = pitcher.pitching?.arsenal[pitchCmd.type]
    ? pitchCmd
    : { ...pitchCmd, type: 'FOURSEAM' };

  const traj = computePitch(rng, pitcher, cmd, def.pitcherPitches);
  def.pitcherPitches += 1;

  const result: PitchResult = {
    pitchNumber: s.pitchCount,
    trajectory: traj,
    swing: offCmd.swing,
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
    state: s,
    atBatEnded: false,
  };

  // ---- 도루 -------------------------------------------------------------
  const validSteals = offCmd.steal.filter((b) => b >= 0 && b <= 2 && s.bases[b]);
  let stealResults: StealResult[] = [];
  if (validSteals.length) {
    stealResults = resolveSteals(
      rng,
      s.bases,
      validSteals,
      off.roster,
      pitcher,
      catcher,
      cmd.quickPitch,
      traj.velocity,
    );
    result.stealResults = stealResults;
  }

  // ---- 몸에 맞는 공 ------------------------------------------------------
  const insideEdge = batter.bats === 'L' ? 2.6 : -2.6;
  const hbp =
    (batter.bats === 'L' ? traj.zoneX > insideEdge : traj.zoneX < insideEdge) &&
    Math.abs(traj.zoneY) < 1.6 &&
    rng.chance(0.3);

  if (hbp && !offCmd.swing.swing) {
    result.kind = 'HIT_BY_PITCH';
    applySteals(s, stealResults, result, rng);
    forceAdvanceForWalk(s, batter, result);
    result.description = `${batter.name}, 몸에 맞는 공! 출루합니다.`;
    finishAtBat(s, result, { walk: true });
    endPitch(s, rng, result);
    return result;
  }

  // ---- 스윙 판정 --------------------------------------------------------
  const swing = offCmd.swing;
  let outcomeKind: PlayResultKind;

  if (!swing.swing) {
    applySteals(s, stealResults, result, rng);
    if (traj.isStrikeZone) {
      s.strikes += 1;
      outcomeKind = 'STRIKE_LOOKING';
      result.description = `${PITCH_DEFS[traj.type].ko} ${Math.round(traj.velocity)}km/h, ${describeLocation(traj.zoneX, traj.zoneY)} 스트라이크!`;
    } else {
      s.balls += 1;
      outcomeKind = 'BALL';
      result.description = `${PITCH_DEFS[traj.type].ko} ${Math.round(traj.velocity)}km/h, ${describeLocation(traj.zoneX, traj.zoneY)} 볼.`;
      maybeWildPitch(s, rng, traj, catcher, result);
    }
    result.kind = outcomeKind;
    resolveCount(s, batter, pitcher, result, rng);
    endPitch(s, rng, result);
    return result;
  }

  const judged = judgeSwing(rng, batter, pitcher, traj, swing);

  if (judged.kind === 'WHIFF') {
    applySteals(s, stealResults, result, rng);
    s.strikes += 1;
    result.kind = 'STRIKE_SWINGING';
    result.description =
      swing.type === 'BUNT'
        ? `${batter.name}, 번트 헛스윙!`
        : `${batter.name}, 헛스윙! ${PITCH_DEFS[traj.type].ko}에 방망이가 헛돕니다.`;
    resolveCount(s, batter, pitcher, result, rng);
    endPitch(s, rng, result);
    return result;
  }

  if (judged.kind === 'FOUL_TIP') {
    applySteals(s, stealResults, result, rng);
    // 2스트라이크에서 번트 파울은 삼진
    if (s.strikes < 2 || swing.type === 'BUNT') s.strikes += 1;
    result.kind = 'FOUL';
    result.description = `${batter.name}, 파울팁.`;
    resolveCount(s, batter, pitcher, result, rng);
    endPitch(s, rng, result);
    return result;
  }

  // ---- 인플레이 ---------------------------------------------------------
  result.contact = true;
  const bb = makeBattedBall(rng, batter, swing, traj, judged.quality, judged.timingErr);
  result.battedBall = bb;

  const play = resolveFielding(rng, bb, defenseMap(s), s.outs, runnersOnBase(s));

  // 파울: 카운트만 올린다 (도루는 무효)
  if (play.foul && !play.foulCaught) {
    if (s.strikes < 2) s.strikes += 1;
    else if (swing.type === 'BUNT') {
      s.strikes += 1; // 2스트라이크 후 번트 파울 = 삼진
    }
    result.kind = 'FOUL';
    result.description = `${batter.name}, 파울!`;
    resolveCount(s, batter, pitcher, result, rng);
    endPitch(s, rng, result);
    return result;
  }

  // 연출 계층이 야수 이동/송구를 그릴 수 있도록 수비 처리 상세를 넘긴다
  result.fieldPlay = play;

  // 인필드 플라이는 포구 여부와 무관하게 타자 자동 아웃이다.
  // 떨어뜨린 경우 주자에게 진루 의무가 없으므로 현재 베이스는 그대로 둔다.
  if (play.infieldFly && !play.caught) {
    result.kind = 'INFIELD_FLY';
    result.outsRecorded = 1;
    result.fielders = [play.primary];
    result.description = `${batter.name}, 인필드 플라이 선언. 타자 아웃!`;
    recordMove(result, batter.id, -1, -1);
    s.outs += 1;
    recordBatterStat(batter, pitcher, result, 0);
    result.atBatEnded = true;
    advanceLineup(s);
    s.balls = 0;
    s.strikes = 0;
    endPitch(s, rng, result);
    return result;
  }

  // 도루 중 인플레이 타구: 주자는 이미 스타트를 끊었으므로 진루가 유리하다
  const runningStart = [0, 1, 2].map((i) => validSteals.includes(i));

  // 인필드 플라이 선언
  if (play.infieldFly && play.caught) {
    result.kind = 'INFIELD_FLY';
  }

  const adv = resolveAdvance(rng, {
    bases: s.bases,
    batter,
    roster: off.roster,
    play,
    outs: s.outs,
    bunt: swing.type === 'BUNT',
    caught: play.caught,
    forced: [],
    runningStart,
  });

  // 연출용 주루 기록 (베이스를 갱신하기 전에 이전 상태로 만든다)
  movesFromAdvance(result, prev.bases, adv, batter.id, {
    tagUp: play.caught && !play.foulCaught,
    running: runningStart,
  });

  // 상태 반영
  const pitcherId = def.pitcherId;
  s.bases = adv.bases.map((r) =>
    r ? { ...r, responsiblePitcherId: r.responsiblePitcherId || pitcherId, stealing: false } : null,
  ) as GameState['bases'];

  result.outsRecorded = adv.outsMade.length;
  s.outs += adv.outsMade.length;
  result.fielders = adv.fielders;

  // 3아웃을 넘겨 득점이 인정되지 않는 경우 처리
  const outsAtScore = prev.outs;
  const scoreAllowed = outsAtScore + adv.outsMade.length < 3 || !adv.doublePlay;
  let scoringRunners: Runner[] = [];
  if (s.outs < 3 || scoreAllowed) {
    // 3아웃째가 타자주자 아웃(포스)이면 득점 무효
    scoringRunners = adv.scored;
  }
  if (s.outs >= 3 && adv.doublePlay) {
    // 병살로 이닝 종료된 경우 득점 취소
    scoringRunners = [];
  }

  for (const runner of scoringRunners) scoreRunner(s, runner, result, !play.error);
  const runs = scoringRunners.length;

  // 결과 종류 결정
  result.kind = classifyPlay(play, adv, swing.type, bb);
  result.rbi = computeRbi(result.kind, runs, play);
  result.description = describePlay(batter, bb, play, adv, result.kind, runs);

  // 스탯
  recordBatterStat(batter, pitcher, result, runs);
  if (play.error) def.errors += 1;
  if (isHit(result.kind)) {
    off.hits += 1;
  }

  result.atBatEnded = true;
  advanceLineup(s);
  s.balls = 0;
  s.strikes = 0;

  endPitch(s, rng, result);
  return result;
}

// ---------------------------------------------------------------------------
// 세부 처리
// ---------------------------------------------------------------------------

/**
 * 주자 이동을 연출용으로 기록한다.
 * 같은 투구에서 한 주자가 두 번 움직이면(도루 후 밀어내기 등) 도착지만 갱신해
 * 한 번의 연속된 주루로 보이게 한다.
 */
function recordMove(out: PitchResult, playerId: string, from: number, to: number, extra?: Partial<RunnerMove>) {
  const existing = out.runnerMoves.find((m) => m.playerId === playerId);
  if (existing) {
    existing.to = to;
    if (extra?.outAt !== undefined) existing.outAt = extra.outAt;
    return;
  }
  out.runnerMoves.push({ playerId, from, to, ...extra });
}

/** 이전 베이스 상태에서 주자의 출발 지점을 찾는다. 없으면 타자주자(-1). */
function fromBaseOf(before: readonly (Runner | null)[], playerId: string): number {
  for (let i = 0; i < 3; i++) if (before[i]?.playerId === playerId) return i;
  return -1;
}

/** resolveAdvance 결과를 주자별 이동 목록으로 변환한다. */
function movesFromAdvance(
  out: PitchResult,
  before: readonly (Runner | null)[],
  adv: ReturnType<typeof resolveAdvance>,
  batterId: string,
  opts: { tagUp: boolean; running: boolean[] },
) {
  const add = (playerId: string, from: number, to: number, outAt?: number) => {
    recordMove(out, playerId, from, to, {
      outAt,
      running: from >= 0 && opts.running[from] ? true : undefined,
      tagUp: opts.tagUp && from >= 0 ? true : undefined,
    });
  };

  for (const o of adv.outsMade) {
    // runner가 null이면 타자주자
    add(o.runner?.playerId ?? batterId, o.runner ? o.base : -1, -1, o.where);
  }
  for (const r of adv.scored) add(r.playerId, fromBaseOf(before, r.playerId), 3);
  for (let i = 0; i < 3; i++) {
    const r = adv.bases[i];
    if (r) add(r.playerId, fromBaseOf(before, r.playerId), i);
  }
}

function applySteals(s: GameState, results: StealResult[], out: PitchResult, rng: Rng) {
  if (!results.length) return;
  const off = offense(s);
  for (const r of results) {
    const runner = s.bases[r.fromBase];
    if (!runner || runner.playerId !== r.playerId) continue;
    s.bases[r.fromBase] = null;
    const p = off.roster[r.playerId];
    if (r.safe) {
      recordMove(out, r.playerId, r.fromBase, r.fromBase + 1, { running: true });
      if (r.fromBase === 2) {
        scoreRunner(s, runner, out, true);
      } else {
        s.bases[r.fromBase + 1] = runner;
      }
      if (p) p.season.sb += 1;
    } else {
      recordMove(out, r.playerId, r.fromBase, -1, { running: true, outAt: r.fromBase + 1 });
      s.outs += 1;
      out.outsRecorded += 1;
      if (p) p.season.cs += 1;
    }
  }
  const anySafe = results.some((r) => r.safe);
  const anyOut = results.some((r) => !r.safe);
  if (anySafe && !anyOut) out.kind = 'STOLEN_BASE';
  else if (anyOut) out.kind = 'CAUGHT_STEALING';
}

/** 폭투/포일 판정 */
function maybeWildPitch(
  s: GameState,
  rng: Rng,
  traj: { zoneY: number; zoneX: number; type: string },
  catcher: Player | undefined,
  out: PitchResult,
) {
  if (!s.bases[0] && !s.bases[1] && !s.bases[2]) return;
  const wildness = Math.max(0, -traj.zoneY - 1.7) + Math.max(0, Math.abs(traj.zoneX) - 1.9);
  if (wildness <= 0) return;
  const block = catcher ? norm(catcher.batting.fielding) : 0.4;
  const p = clamp(wildness * 0.32 - block * 0.18, 0, 0.5);
  if (!rng.chance(p)) return;

  for (let i = 2; i >= 0; i--) {
    const r = s.bases[i];
    if (!r) continue;
    s.bases[i] = null;
    recordMove(out, r.playerId, i, i + 1);
    if (i === 2) {
      scoreRunner(s, r, out, true);
    } else {
      s.bases[i + 1] = r;
    }
  }
  out.kind = 'WILD_PITCH';
  out.description += ' 폭투! 주자가 진루합니다.';
}

/** 볼넷/사구 시 밀어내기 진루 */
function forceAdvanceForWalk(s: GameState, batter: Player, out: PitchResult) {
  const b = s.bases;
  if (b[0]) {
    if (b[1]) {
      if (b[2]) {
        recordMove(out, b[2].playerId, 2, 3);
        scoreRunner(s, b[2], out, true);
        out.rbi += 1;
        batter.season.rbi += 1;
      }
      recordMove(out, b[1].playerId, 1, 2);
      b[2] = b[1];
    }
    recordMove(out, b[0].playerId, 0, 1);
    b[1] = b[0];
  }
  recordMove(out, batter.id, -1, 0);
  b[0] = { playerId: batter.id, responsiblePitcherId: defenseTeam(s).pitcherId, stealing: false };
}

/** 볼/스트라이크 카운트에 따른 타석 종료 처리 */
function resolveCount(s: GameState, batter: Player, pitcher: Player, out: PitchResult, rng: Rng) {
  if (s.strikes >= 3) {
    s.outs += 1;
    out.outsRecorded += 1;
    out.kind = 'STRIKEOUT';
    out.description = `${batter.name} 삼진 아웃!`;
    batter.season.pa += 1;
    batter.season.ab += 1;
    batter.season.so += 1;
    if (pitcher.pitching) pitcher.season.pk += 1;
    finishAtBat(s, out, {});
    return;
  }
  if (s.balls >= 4) {
    out.kind = 'WALK';
    out.description = `${batter.name} 볼넷으로 출루합니다.`;
    forceAdvanceForWalk(s, batter, out);
    batter.season.pa += 1;
    batter.season.bb += 1;
    pitcher.season.pbb += 1;
    finishAtBat(s, out, { walk: true });
  }
}

function finishAtBat(s: GameState, out: PitchResult, opt: { walk?: boolean }) {
  out.atBatEnded = true;
  if (opt.walk) {
    const batter = currentBatter(s);
    if (batter && out.kind === 'HIT_BY_PITCH') {
      batter.season.pa += 1;
    }
  }
  advanceLineup(s);
  s.balls = 0;
  s.strikes = 0;
}

function advanceLineup(s: GameState) {
  const o = offense(s);
  o.atBatIndex = (o.atBatIndex + 1) % o.lineup.length;
}

function addRuns(s: GameState, n: number, out: PitchResult) {
  if (n <= 0) return;
  const side = battingSide(s);
  ensureLineScore(s);
  s[side].runs += n;
  s.lineScore[side][s.inning - 1] += n;
  out.runsScored += n;
}

/** 득점·득점자·책임 투수 기록을 한 번에 반영한다. */
function scoreRunner(s: GameState, runner: Runner, out: PitchResult, earned: boolean) {
  addRuns(s, 1, out);
  out.scoringPlayerIds.push(runner.playerId);
  const scorer = offense(s).roster[runner.playerId];
  if (scorer) scorer.season.r += 1;
  if (!earned) return;
  const def = defenseTeam(s);
  const responsibleId = runner.responsiblePitcherId || def.pitcherId;
  const responsible = def.roster[responsibleId];
  if (responsible) responsible.season.er += 1;
}

function isHit(kind: PlayResultKind): boolean {
  return kind === 'SINGLE' || kind === 'DOUBLE' || kind === 'TRIPLE' || kind === 'HOME_RUN';
}

function classifyPlay(
  play: ReturnType<typeof resolveFielding>,
  adv: ReturnType<typeof resolveAdvance>,
  swingType: 'NORMAL' | 'POWER' | 'BUNT',
  bb: { kind: string; launchAngle: number },
): PlayResultKind {
  if (play.infieldFly) return 'INFIELD_FLY';
  if (play.homeRun) return 'HOME_RUN';
  if (play.error) return 'ERROR';
  if (play.foulCaught) return 'FOUL_OUT';
  if (play.caught) {
    if (adv.scored.length > 0) return 'SAC_FLY';
    if (bb.launchAngle > 50) return 'POP_OUT';
    if (bb.launchAngle < 20) return 'LINE_OUT';
    return 'FLY_OUT';
  }
  if (adv.doublePlay) return 'DOUBLE_PLAY';
  if (adv.batterBase === -1) {
    if (swingType === 'BUNT' && adv.scored.length + adv.bases.filter(Boolean).length > 0) return 'SAC_BUNT';
    return 'GROUND_OUT';
  }
  if (adv.fieldersChoice && adv.outsMade.length > 0) return 'FIELDERS_CHOICE';
  if (adv.batterBase === 3) return 'HOME_RUN';
  if (adv.batterBase === 2) return 'TRIPLE';
  if (adv.batterBase === 1) return 'DOUBLE';
  return 'SINGLE';
}

function computeRbi(kind: PlayResultKind, runs: number, play: { error: boolean }): number {
  if (runs === 0) return 0;
  if (play.error) return 0;
  if (kind === 'DOUBLE_PLAY') return 0;
  return runs;
}

function recordBatterStat(batter: Player, pitcher: Player, r: PitchResult, runs: number) {
  const st = batter.season;
  st.pa += 1;
  const noAb: PlayResultKind[] = ['SAC_FLY', 'SAC_BUNT'];
  if (!noAb.includes(r.kind)) st.ab += 1;
  st.rbi += r.rbi;
  if (isHit(r.kind)) {
    st.h += 1;
    pitcher.season.ph += 1;
    if (r.kind === 'DOUBLE') st.double += 1;
    if (r.kind === 'TRIPLE') st.triple += 1;
    if (r.kind === 'HOME_RUN') st.hr += 1;
  }
}

const KIND_KO: Partial<Record<PlayResultKind, string>> = {
  SINGLE: '안타',
  DOUBLE: '2루타',
  TRIPLE: '3루타',
  HOME_RUN: '홈런',
  GROUND_OUT: '땅볼 아웃',
  FLY_OUT: '뜬공 아웃',
  LINE_OUT: '직선타 아웃',
  POP_OUT: '내야 뜬공 아웃',
  FOUL_OUT: '파울 플라이 아웃',
  SAC_FLY: '희생플라이',
  SAC_BUNT: '희생번트',
  DOUBLE_PLAY: '병살타',
  FIELDERS_CHOICE: '야수선택',
  ERROR: '실책 출루',
  INFIELD_FLY: '인필드 플라이',
};

function describePlay(
  batter: Player,
  bb: { exitVelocity: number; distance: number; kind: string },
  play: { primary: Position; error: boolean; homeRun: boolean },
  adv: { scored: unknown[]; fielders: Position[] },
  kind: PlayResultKind,
  runs: number,
): string {
  const who = POSITION_KO[play.primary] ?? '';
  const label = KIND_KO[kind] ?? '';
  let base: string;

  switch (kind) {
    case 'HOME_RUN':
      base = `${batter.name}, 홈런! 비거리 ${Math.round(bb.distance)}m, 타구속도 ${Math.round(bb.exitVelocity)}km/h!`;
      break;
    case 'ERROR':
      base = `${who} 실책! ${batter.name} 출루합니다.`;
      break;
    case 'DOUBLE_PLAY':
      base = `${batter.name}, ${adv.fielders.map((f) => POSITION_KO[f]).join('-')} 병살타!`;
      break;
    case 'SAC_FLY':
      base = `${batter.name}, ${who} 방면 희생플라이.`;
      break;
    case 'SAC_BUNT':
      base = `${batter.name}, 희생번트 성공.`;
      break;
    case 'FIELDERS_CHOICE':
      base = `${batter.name}, 야수선택으로 출루.`;
      break;
    default:
      if (isHit(kind)) {
        base = `${batter.name}, ${who} 방면 ${label}! (${Math.round(bb.exitVelocity)}km/h)`;
      } else {
        base = `${batter.name}, ${who} ${label}.`;
      }
  }

  if (runs > 0 && kind !== 'HOME_RUN') base += ` ${runs}점 득점!`;
  return base;
}

// ---------------------------------------------------------------------------
// 이닝 / 경기 종료
// ---------------------------------------------------------------------------

function endPitch(s: GameState, rng: Rng, out: PitchResult) {
  s.rngState = rng.state;

  // 아웃이 만들어진 시점의 수비 투수에게 아웃 카운트 단위 이닝을 기록한다.
  const pitcher = currentPitcher(s);
  if (pitcher?.pitching) pitcher.season.ip3 += out.outsRecorded;

  if (s.outs >= 3) {
    // 잔루 집계
    offense(s).lob += s.bases.filter(Boolean).length;
    nextHalfInning(s);
  }

  checkGameEnd(s);
  out.state = s;
}

function nextHalfInning(s: GameState) {
  s.bases = [null, null, null];
  s.outs = 0;
  s.balls = 0;
  s.strikes = 0;
  if (s.half === 'TOP') {
    s.half = 'BOTTOM';
  } else {
    s.half = 'TOP';
    s.inning += 1;
  }
  ensureLineScore(s);
  s.phase = 'INNING_BREAK';
}

export function checkGameEnd(s: GameState): void {
  const reg = s.settings.regulationInnings;
  const a = s.away.runs;
  const h = s.home.runs;

  // 콜드게임: 홈 리드는 초 종료/말 공격 중, 원정 리드는 말 종료 뒤에만 확정한다.
  const homeHadChance = h > a && s.half === 'BOTTOM';
  const awayHadChance =
    a > h &&
    s.phase === 'INNING_BREAK' &&
    s.half === 'TOP' &&
    s.inning - 1 >= s.settings.mercyFromInning;
  if (
    s.settings.mercyRule &&
    (homeHadChance ? s.inning >= s.settings.mercyFromInning : awayHadChance)
  ) {
    const diff = Math.abs(a - h);
    if (diff >= s.settings.mercyRunDiff && (homeHadChance || awayHadChance)) {
      s.phase = 'GAME_OVER';
      s.winner = a > h ? 'away' : 'home';
      s.endedByMercy = true;
      return;
    }
  }

  // 끝내기: 정규 이닝 이후 말 공격 중 홈팀이 앞서면 즉시 종료
  if (s.inning >= reg && s.half === 'BOTTOM' && h > a) {
    s.phase = 'GAME_OVER';
    s.winner = 'home';
    return;
  }

  // 정규 이닝 종료
  if (s.inning > reg) {
    if (a !== h) {
      s.phase = 'GAME_OVER';
      s.winner = a > h ? 'away' : 'home';
      return;
    }
    // 연장 12회까지
    if (s.inning > reg + 3) {
      s.phase = 'GAME_OVER';
      s.winner = 'TIE';
      return;
    }
  }

  // 정규 마지막 이닝 초가 끝났고 홈이 이기고 있으면 말 공격 불필요
  if (s.inning === reg && s.half === 'BOTTOM' && h > a && s.outs === 0 && s.phase === 'INNING_BREAK') {
    s.phase = 'GAME_OVER';
    s.winner = 'home';
  }
}

/** 투수 교체 */
export function changePitcher(s: GameState, side: Side, newPitcherId: string): GameState {
  const t = s[side];
  const nextPitcher = t.roster[newPitcherId];
  const used = t.usedPitcherIds ?? [t.pitcherId];
  if (
    !nextPitcher?.pitching ||
    newPitcherId === t.pitcherId ||
    used.includes(newPitcherId) ||
    t.lineup.includes(newPitcherId)
  ) {
    return s;
  }
  const oldPitcherId = t.pitcherId;
  t.pitcherId = newPitcherId;
  t.pitcherPitches = 0;
  t.usedPitcherIds = [...used, newPitcherId];
  t.defense.P = newPitcherId;
  nextPitcher.season.g = 1;
  if (!s.settings.useDH) {
    const battingSlot = t.lineup.indexOf(oldPitcherId);
    if (battingSlot >= 0) t.lineup[battingSlot] = newPitcherId;
  }
  return s;
}

/** 현재 투수가 지쳤는지 (교체 권장) */
export function pitcherIsTired(s: GameState, side: Side): boolean {
  const t = s[side];
  const p = t.roster[t.pitcherId];
  if (!p) return false;
  return staminaRemaining(p, t.pitcherPitches) < 0.15;
}

/** 불펜에서 다음 투수 후보 */
export function bullpenCandidates(s: GameState, side: Side): Player[] {
  const t = s[side];
  const inLineup = new Set(t.lineup);
  const used = new Set(t.usedPitcherIds ?? [t.pitcherId]);
  return Object.values(t.roster)
    .filter((p) => p.position === 'P' && p.pitching && !used.has(p.id) && !inLineup.has(p.id))
    .sort((a, b) => (b.pitching?.stamina ?? 0) - (a.pitching?.stamina ?? 0));
}

/** 스코어보드 표시용 요약 */
export function scoreSummary(s: GameState) {
  return {
    away: s.away.runs,
    home: s.home.runs,
    inning: s.inning,
    half: s.half,
    outs: s.outs,
    balls: s.balls,
    strikes: s.strikes,
  };
}

export { SWING_DEFS, PITCH_DEFS };
