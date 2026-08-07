import { Rng, clamp, lerp, norm } from './rng';
import { BASE_COORDS, BASE_DISTANCE } from './constants';
import { throwArrivalTime, type FieldPlay } from './fielding';
import type { Player, Position, Runner, StealResult, Vec3 } from './types';

// ---------------------------------------------------------------------------
// 주루 시간 모델
// ---------------------------------------------------------------------------

/**
 * 타격 후 1루까지 (s).
 *
 * 라인업에 서는 타자의 speed 능력치는 실제로 대략 28~68에 몰려 있어서,
 * 매핑 구간을 능력치 0~99에 그대로 걸면 전원이 4.2~4.6초의 좁은 구간에
 * 뭉친다. 진짜 빠른 주자가 없어지면 내야안타가 통째로 사라진다.
 * MLB 실측(최속 3.9 / 평균 4.30 / 최저 4.75)에 그 구간이 맞도록 넓혔다.
 */
export function homeToFirst(p: Player, bunt: boolean): number {
  const t = lerp(5.2, 3.35, norm(p.batting.speed));
  return bunt ? t - 0.18 : t;
}

/** 이미 달리고 있는 주자가 다음 베이스까지 (s) */
export function baseToBase(p: Player): number {
  return lerp(3.75, 2.95, norm(p.batting.speed));
}

/** 정지 상태(리드오프)에서 다음 베이스까지 — 도루 시 */
export function stealTime(p: Player, from: number): number {
  // 1루->2루 기준 엘리트 3.35초, 느린 선수 4.15초. 3루 도루는 리드가 짧아 조금 더 걸린다.
  const t = lerp(4.02, 3.26, norm(p.batting.speed));
  return from === 1 ? t + 0.1 : t;
}

/** 타구가 잡힌 뒤 태그업해서 진루하는 시간 */
export function tagUpTime(p: Player): number {
  return lerp(4.1, 3.25, norm(p.batting.speed));
}

// ---------------------------------------------------------------------------
// 도루
// ---------------------------------------------------------------------------

/**
 * 도루 판정.
 * 주자 도달 시간 vs (투수 딜리버리 + 포수 팝타임 + 송구).
 */
export function resolveSteals(
  rng: Rng,
  bases: [Runner | null, Runner | null, Runner | null],
  stealFrom: number[],
  roster: Record<string, Player>,
  pitcher: Player,
  catcher: Player | undefined,
  quickPitch: boolean,
  pitchVelocityKmh: number,
): StealResult[] {
  const results: StealResult[] = [];
  // 투수 딜리버리 타임 (셋포지션). 퀵모션이면 짧다.
  const delivery = (quickPitch ? 1.05 : 1.32) + rng.normal(0, 0.06);
  // 공이 포수 미트에 도달하는 시간
  const flight = 18.44 / ((pitchVelocityKmh / 3.6) * 0.92);
  // 포수 팝타임 (포구 -> 2루 송구 도달). 실제 MLB 1.85~2.10초.
  const catcherArm = catcher ? norm(catcher.batting.arm) : 0.4;
  const catcherField = catcher ? norm(catcher.batting.fielding) : 0.4;
  const popTime = lerp(2.1, 1.82, catcherArm * 0.65 + catcherField * 0.35) + rng.normal(0, 0.08);

  for (const from of stealFrom.slice().sort((a, b) => b - a)) {
    const runner = bases[from];
    if (!runner) continue;
    // 다음 베이스가 이미 차 있으면 뛰지 않는다 (더블 스틸은 앞 주자부터 처리되므로 갱신 확인)
    if (from < 2 && bases[from + 1] && !stealFrom.includes(from + 1)) continue;
    const p = roster[runner.playerId];
    if (!p) continue;

    if (from === 2) {
      // 홈 스틸. 성공률이 매우 낮다.
      const runTime = stealTime(p, 2) * 0.86;
      const defTime = delivery + rng.range(-0.05, 0.15);
      const safe = runTime < defTime && rng.chance(0.35 + norm(p.batting.speed) * 0.25);
      results.push({ fromBase: from, playerId: runner.playerId, safe });
      continue;
    }

    const runTime = stealTime(p, from) + rng.normal(0, 0.08);
    // 3루 도루는 거리가 같지만 포수 송구가 짧아 유리 -> popTime 보정
    const throwAdj = from === 1 ? -0.12 : 0;
    const defTime = delivery + flight + popTime + throwAdj;
    const safe = runTime < defTime;
    results.push({ fromBase: from, playerId: runner.playerId, safe });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 타구 후 자동 주루
// ---------------------------------------------------------------------------

export interface AdvanceInput {
  bases: [Runner | null, Runner | null, Runner | null];
  batter: Player;
  roster: Record<string, Player>;
  play: FieldPlay;
  outs: number;
  bunt: boolean;
  /** 뜬공을 잡았는가 (태그업 상황) */
  caught: boolean;
  /** 강제 진루 상황인가 */
  forced: boolean[];
  /** 투구와 동시에 스타트를 끊은 주자 (히트앤런/도루). 진루 시간이 크게 단축된다. */
  runningStart?: boolean[];
}

/** 스타트를 끊은 주자가 절약하는 시간 (s) */
const RUNNING_START_BONUS = 1.35;

export interface AdvanceResult {
  /** 새로운 베이스 상태 */
  bases: [Runner | null, Runner | null, Runner | null];
  /** 득점한 주자 */
  scored: Runner[];
  /** 아웃된 주자 (베이스 인덱스, -1은 타자주자) */
  outsMade: { runner: Runner | null; base: number; where: number }[];
  /** 타자가 도달한 베이스 (0=1루 ... 3=홈, -1=아웃) */
  batterBase: number;
  /** 병살 */
  doublePlay: boolean;
  /** 야수선택 */
  fieldersChoice: boolean;
  /** 처리 야수 순서 */
  fielders: Position[];
}

const SAFETY_MARGIN = 0.28;

/**
 * 인플레이 타구에 대한 주루를 자동으로 결정한다.
 *
 * 원칙:
 *  1. 뜬공을 잡으면 태그업. 잡히지 않으면 전원 진루 시도.
 *  2. 포스 상황에서는 선행 주자부터 아웃 여부를 판정한다.
 *  3. 각 주자는 "송구 도달 시간 - 내 도달 시간 > 안전 마진"일 때만 추가 진루한다.
 */
export function resolveAdvance(rng: Rng, input: AdvanceInput): AdvanceResult {
  const { bases, batter, roster, play, outs, bunt, caught } = input;
  const newBases: [Runner | null, Runner | null, Runner | null] = [null, null, null];
  const scored: Runner[] = [];
  const outsMade: AdvanceResult['outsMade'] = [];
  const fielders: Position[] = [play.primary];
  let doublePlay = false;
  let fieldersChoice = false;

  // ---- 홈런 -----------------------------------------------------------
  if (play.homeRun) {
    for (let i = 2; i >= 0; i--) if (bases[i]) scored.push(bases[i]!);
    // 타자 본인도 득점한다. 이것을 빼먹으면 솔로 홈런이 0점이 된다.
    scored.push({ playerId: batter.id, responsiblePitcherId: '', stealing: false });
    return { bases: newBases, scored, outsMade, batterBase: 3, doublePlay, fieldersChoice, fielders };
  }

  // ---- 파울 -----------------------------------------------------------
  if (play.foul && !play.foulCaught) {
    return {
      bases: [...bases] as AdvanceResult['bases'],
      scored,
      outsMade,
      batterBase: -2, // 파울: 타석 계속
      doublePlay,
      fieldersChoice,
      fielders: [],
    };
  }

  const batterTime = homeToFirst(batter, bunt);

  // ---- 뜬공 포구 (태그업) ------------------------------------------------
  if (caught) {
    outsMade.push({ runner: null, base: -1, where: -1 });
    const outsAfter = outs + 1;

    if (play.foulCaught || outsAfter >= 3) {
      // 파울 플라이 또는 3아웃: 주자는 그대로
      for (let i = 0; i < 3; i++) newBases[i] = bases[i];
      return { bases: newBases, scored, outsMade, batterBase: -1, doublePlay, fieldersChoice, fielders };
    }

    // 3루 -> 홈 (희생플라이), 2루 -> 3루 순으로 검토
    for (let i = 2; i >= 0; i--) {
      const r = bases[i];
      if (!r) continue;
      const p = roster[r.playerId];
      if (!p) {
        newBases[i] = r;
        continue;
      }
      // 스타트를 끊었던 주자는 귀루해야 한다. 늦으면 더블 아웃.
      if (input.runningStart?.[i] && outs + outsMade.length < 3) {
        const backTime = throwArrivalTime(play, i);
        if (backTime < play.secureTime + 1.6 && rng.chance(0.55)) {
          outsMade.push({ runner: r, base: i, where: i });
          fielders.push(baseToPosition(i));
          continue;
        }
        newBases[i] = r;
        continue;
      }
      const targetBase = i + 1; // 0->1루에서 2루
      const canTry = play.secureTime > 1.6 && !play.infield; // 내야 플라이는 태그업 불가
      if (!canTry) {
        newBases[i] = r;
        continue;
      }
      const runTime = play.secureTime + tagUpTime(p);
      const throwTime = throwArrivalTime(play, targetBase === 3 ? 3 : targetBase);
      const aggressive = norm(p.batting.speed) * 0.25;
      if (runTime + SAFETY_MARGIN - aggressive < throwTime) {
        if (targetBase === 3) scored.push(r);
        else newBases[targetBase] = r;
      } else if (runTime < throwTime + 0.15 && rng.chance(0.22)) {
        // 무리한 시도 -> 종종 아웃
        outsMade.push({ runner: r, base: i, where: targetBase });
        fielders.push(baseToPosition(targetBase));
      } else {
        newBases[i] = r;
      }
    }
    return { bases: newBases, scored, outsMade, batterBase: -1, doublePlay, fieldersChoice, fielders };
  }

  // ---- 실책 -----------------------------------------------------------
  if (play.error) {
    // 실책이면 전원 최소 1개 베이스 진루
    for (let i = 2; i >= 0; i--) {
      const r = bases[i];
      if (!r) continue;
      const to = i + 1 + (play.infield ? 0 : 1);
      if (to >= 3) scored.push(r);
      else newBases[to] = r;
    }
    const bBase = play.infield ? 0 : rng.chance(0.35) ? 1 : 0;
    placeBatter(newBases, batter, input, bBase, scored);
    return { bases: newBases, scored, outsMade, batterBase: bBase, doublePlay, fieldersChoice, fielders };
  }

  // ---- 내야 땅볼 --------------------------------------------------------
  if (play.infield && !play.throughInfield) {
    return resolveInfieldGrounder(rng, input, newBases, scored, outsMade, fielders, batterTime);
  }

  // ---- 외야로 나간 타구 (안타) -------------------------------------------
  return resolveHit(rng, input, newBases, scored, outsMade, fielders, batterTime);
}

function baseToPosition(base: number): Position {
  return (['1B', '2B', '3B', 'C'] as Position[])[clamp(base, 0, 3)];
}

function placeBatter(
  bases: [Runner | null, Runner | null, Runner | null],
  batter: Player,
  input: AdvanceInput,
  base: number,
  scored: Runner[],
) {
  const runner: Runner = {
    playerId: batter.id,
    responsiblePitcherId: '',
    stealing: false,
  };
  if (base >= 3) scored.push(runner);
  else if (base >= 0) bases[base] = runner;
}

/** 내야 땅볼: 포스 아웃 / 병살 / 야수선택 */
function resolveInfieldGrounder(
  rng: Rng,
  input: AdvanceInput,
  newBases: [Runner | null, Runner | null, Runner | null],
  scored: Runner[],
  outsMade: AdvanceResult['outsMade'],
  fielders: Position[],
  batterTime: number,
): AdvanceResult {
  const { bases, batter, roster, play, outs } = input;
  let doublePlay = false;
  let fieldersChoice = false;

  // 포스 상황 계산: 1루 주자가 있으면 2루 포스, 1·2루면 3루 포스, 만루면 홈 포스
  const forceTo: number[] = [];
  if (bases[0]) {
    forceTo.push(1);
    if (bases[1]) {
      forceTo.push(2);
      if (bases[2]) forceTo.push(3);
    }
  }

  const remainingOuts = 3 - outs;
  let outsUsed = 0;

  // 선행 포스 주자를 먼저 잡는다 (가장 앞선 포스부터)
  const leadForce = forceTo.length ? forceTo[forceTo.length - 1] : -1;
  const handled = new Set<number>();

  if (leadForce >= 0 && outsUsed < remainingOuts) {
    const fromBase = leadForce - 1;
    const r = bases[fromBase];
    const p = r ? roster[r.playerId] : undefined;
    if (r && p) {
      const runTime =
        baseToBase(p) - (input.runningStart?.[fromBase] ? RUNNING_START_BONUS : 0);
      const throwT = throwArrivalTime(play, leadForce);
      // 포스 주자는 무조건 뛰어야 한다
      if (throwT < runTime + 0.05) {
        outsMade.push({ runner: r, base: fromBase, where: leadForce });
        fielders.push(baseToPosition(leadForce));
        handled.add(fromBase);
        outsUsed++;
        // 선행 주자를 잡고 타자가 살면 야수선택이다. 안타가 아니다.
        fieldersChoice = true;

        // 병살 시도: 1루로 이어 던진다
        if (outsUsed < remainingOuts && leadForce === 1) {
          const pivot = play.securePoint;
          const relay =
            throwT +
            lerp(0.95, 0.62, norm(roster[bases[0]!.playerId]?.batting.fielding ?? 50) ) +
            BASE_DISTANCE / 38;
          const dpChance = clamp(0.82 - Math.abs(pivot.x) / 90, 0.35, 0.9);
          if (relay < batterTime && rng.chance(dpChance)) {
            outsMade.push({ runner: null, base: -1, where: 0 });
            fielders.push('1B');
            doublePlay = true;
            outsUsed++;
          }
        }
      }
    }
  }

  // 병살이 성립하지 않았고 포스 아웃도 없었다면 1루 승부
  const batterOut =
    !doublePlay &&
    outsUsed < remainingOuts &&
    !handled.size &&
    throwArrivalTime(play, 0) < batterTime;

  if (batterOut) {
    outsMade.push({ runner: null, base: -1, where: 0 });
    if (!fielders.includes('1B')) fielders.push('1B');
    outsUsed++;
  }

  const batterSafe = !batterOut && !doublePlay;
  const totalOuts = outs + outsUsed;

  // 나머지 주자 진루
  for (let i = 2; i >= 0; i--) {
    if (handled.has(i)) continue;
    const r = bases[i];
    if (!r) continue;
    const p = roster[r.playerId];
    if (!p) {
      newBases[i] = r;
      continue;
    }
    const mustRun = forceTo.includes(i + 1) && !handled.has(i);
    const target = i + 1;
    if (totalOuts >= 3) {
      newBases[i] = r;
      continue;
    }
    if (mustRun) {
      if (target >= 3) scored.push(r);
      else newBases[target] = r;
      continue;
    }
    // 자유 주자: 안전하면 진루
    const runTime = baseToBase(p) - (input.runningStart?.[i] ? RUNNING_START_BONUS : 0);
    const throwT = throwArrivalTime(play, target);
    const wantsHome = target === 3;
    const margin = wantsHome ? SAFETY_MARGIN + 0.15 : SAFETY_MARGIN;
    if (runTime + margin < throwT) {
      if (target >= 3) scored.push(r);
      else newBases[target] = r;
    } else {
      newBases[i] = r;
    }
  }

  let batterBase = -1;
  if (batterSafe) {
    batterBase = 0;
    // 1루가 이미 찼다면(야수선택 등) 밀어낸다
    if (newBases[0]) {
      const pushed = newBases[0];
      newBases[0] = null;
      if (!newBases[1]) newBases[1] = pushed;
    }
    placeBatter(newBases, batter, input, 0, scored);
  }

  return { bases: newBases, scored, outsMade, batterBase, doublePlay, fieldersChoice, fielders };
}

/** 외야 안타: 타자와 주자가 몇 루까지 갈 수 있는지 계산 */
function resolveHit(
  rng: Rng,
  input: AdvanceInput,
  newBases: [Runner | null, Runner | null, Runner | null],
  scored: Runner[],
  outsMade: AdvanceResult['outsMade'],
  fielders: Position[],
  batterTime: number,
): AdvanceResult {
  const { bases, batter, roster, play, outs } = input;

  // ---- 타자 진루 --------------------------------------------------------
  let batterBase = 0;
  const bSpeed = baseToBase(batter);
  let cum = batterTime;
  for (let target = 1; target <= 3; target++) {
    cum += bSpeed;
    const throwT = throwArrivalTime(play, target);
    const aggressive = 0.15 + norm(batter.batting.speed) * 0.38;
    if (cum + SAFETY_MARGIN - aggressive < throwT) {
      batterBase = target;
    } else {
      break;
    }
  }
  // 펜스 직격 타구는 최소 2루타
  if (play.fenceHit && batterBase < 1) batterBase = 1;

  // ---- 주자 진루 --------------------------------------------------------
  const outsAfter = outs;
  for (let i = 2; i >= 0; i--) {
    const r = bases[i];
    if (!r) continue;
    const p = roster[r.playerId];
    if (!p) {
      newBases[i] = r;
      continue;
    }
    let pos = i;
    let time = input.runningStart?.[i] ? -RUNNING_START_BONUS : 0;
    const rSpeed = baseToBase(p);
    // 주자는 타자보다 최소 1베이스는 더 갈 수 있다 (이미 리드 중)
    for (let step = 1; step <= 3 - i; step++) {
      time += rSpeed;
      const target = i + step;
      const throwT = throwArrivalTime(play, target);
      const aggressive = 0.15 + norm(p.batting.speed) * 0.4 + (outsAfter === 2 ? 0.3 : 0);
      const margin = target === 3 ? SAFETY_MARGIN + 0.1 : SAFETY_MARGIN;
      if (time + margin - aggressive < throwT) {
        pos = target;
      } else {
        // 아슬아슬하면 도박을 걸기도 한다
        if (target === 3 && time < throwT + 0.35 && rng.chance(0.25 + norm(p.batting.speed) * 0.2)) {
          if (rng.chance(0.55)) {
            pos = target;
          } else {
            outsMade.push({ runner: r, base: i, where: 3 });
            fielders.push('C');
            pos = -1;
          }
        }
        break;
      }
    }
    if (pos === -1) continue; // 아웃
    if (pos >= 3) scored.push(r);
    else if (pos !== i || true) newBases[Math.min(pos, 2)] = r;
  }

  // 타자 배치 (앞 주자와 겹치면 한 칸 뒤로)
  let bb = batterBase;
  while (bb < 3 && newBases[bb]) bb++;
  if (bb >= 3) bb = 2;
  if (batterBase >= 3) {
    scored.push({ playerId: batter.id, responsiblePitcherId: '', stealing: false });
  } else {
    newBases[bb] = { playerId: batter.id, responsiblePitcherId: '', stealing: false };
    batterBase = bb;
  }

  return { bases: newBases, scored, outsMade, batterBase, doublePlay: false, fieldersChoice: false, fielders };
}

export { SAFETY_MARGIN };
