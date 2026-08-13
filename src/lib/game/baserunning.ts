import { Rng, clamp, lerp, norm } from './rng';
import { BASE_COORDS, BASE_DISTANCE } from './constants';
import { throwArrivalTime, type FieldPlay } from './fielding';
import type { Player, Position, Runner, StealResult, Vec3 } from './types';
import { effSpeed } from './batting';

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
  const t = lerp(5.2, 3.35, norm(effSpeed(p)));
  return bunt ? t - 0.18 : t;
}

/** 이미 달리고 있는 주자가 다음 베이스까지 (s) */
export function baseToBase(p: Player): number {
  return lerp(3.75, 2.95, norm(effSpeed(p)));
}

/**
 * 정지 상태(리드오프)에서 다음 베이스까지 — 도루 시 (s).
 *
 * **엔드포인트에 MLB 실측값을 그대로 꽂으면 안 된다.** lerp의 양 끝은 능력치 0과 99일 때의
 * 값인데, 실제 라인업에 서는 타자의 speed는 p10 28 · 중앙 45 · p90 68에 몰려 있어서 그
 * 구간만 통과한다. 4.1~3.1을 양 끝에 걸면 로스터 전원이 3.4~3.8초에 뭉쳐 수비 시간
 * 3.30초를 아무도 못 이기고, 도루가 통째로 사라진다 (바로 위 homeToFirst가 같은 이유로
 * MLB 범위보다 넓게 잡혀 있다).
 *
 * 그래서 **실측 분포가 통과했을 때 실측값이 나오도록** 역산했다:
 *
 *   중앙 45 -> 3.60초 · p90 68 -> 3.10초   (MLB 평균 3.6 · 엘리트 3.1)
 *
 * 느린 끝은 p10 28 -> 3.97초로 목표 4.1보다 0.13초 빠른데, 분포의 p10~중앙 간격(17포인트)이
 * 중앙~p90(23포인트)보다 좁아 세 점을 직선 하나로 동시에 맞출 수 없기 때문이다. 결정이
 * 실제로 갈리는 구간(speed 55~80)을 정확히 맞추는 쪽을 골랐다 — 3.97초짜리 주자는 어차피
 * 뛰지 않는다.
 *
 * 바닥값은 외삽 방지다. speed 93(관측 최대)이 직선으로는 2.56초가 되는데, 그건 어떤 배터리도
 * 못 잡는 시간이다. 실제 MLB 최속 기록이 2.9초 언저리라 거기서 끊는다.
 */
export function stealTime(p: Player, from: number): number {
  const t = Math.max(2.9, lerp(4.58, 2.43, norm(effSpeed(p))));
  // 2루->3루는 거리가 같지만 리드가 크다. 1루에는 1루수가 붙어서 견제를 받지만 2루에서는
  // 유격수/2루수가 베이스에서 떨어져 서 있어 리드를 1m쯤 더 잡을 수 있다.
  return from === 1 ? t - STEAL3_LEAD_GAIN : t;
}

/** 타구가 잡힌 뒤 태그업해서 진루하는 시간 */
export function tagUpTime(p: Player): number {
  return lerp(4.1, 3.25, norm(effSpeed(p)));
}

// ---------------------------------------------------------------------------
// 도루
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 도루를 이루는 값들은 하나의 비교식 `runTime < defTime`에 걸린 손잡이들이다.
// 하나만 돌리면 결과가 통째로 움직이므로, 아래 상수를 건드릴 때는 반드시 180경기 실측으로
// 재보정한다. 각 상수의 유도 근거는 개별 주석에 있고, 전체 그림은 resolveSteals에 있다.
//
// 예전에는 두 개의 큰 오차(딜리버리가 공 비행을 두 번 세던 것 + 그걸 상쇄하려 퀵모션을
// 55%로 올려 둔 것)가 서로 맞물려 **결과만 맞고 과정은 둘 다 틀린** 상태였다. 지금은 양쪽
// 모두 실측값에서 유도되어 있다. 아래 값들이 다시 "결과를 맞추려고 넣은 숫자"가 되지
// 않도록, 바꿀 때는 근거부터 바꾼다.
// ---------------------------------------------------------------------------

/**
 * 2루->3루 도루에서 주자가 리드로 버는 시간 (s).
 *
 * 1루 주자는 1루수가 붙어 견제를 받지만, 2루에서는 유격수/2루수가 베이스에서 떨어져 있어
 * 리드를 1m 남짓 더 잡는다. 8.5m/s면 0.12초다.
 */
const STEAL3_LEAD_GAIN = 0.12;
/**
 * 2루->3루 도루에서 수비가 송구 거리로 버는 시간 (s).
 *
 * 홈->2루 38.8m, 홈->3루 27.4m로 11.4m 짧다. 포수 송구 36m/s면 0.32초를 번다. 다만 3루
 * 송구는 우타자를 피해 던져야 하고 태그도 까다로워 0.10초쯤 돌려준다. 순 0.22초.
 *
 * **주자 리드(-0.12)와 이 값(-0.22)의 차이가 3루 도루의 난이도 전부다.** 순 0.10초 불리하고,
 * 그래서 성공률이 2루 도루보다 조금 낮다. 예전에는 리드 부호가 뒤집혀(+0.10) 있어서 순
 * 0.22초 불리했고, 실측 성공률이 53%로 손익분기(69%) 한참 아래였다 — CPU가 뛸수록 손해를
 * 보는 상태였다.
 */
const STEAL3_THROW_GAIN = 0.22;

/**
 * 홈 스틸에서 주자가 실제로 달려야 하는 구간의 비율.
 *
 * 3루 주자는 투수가 공을 놓기 전에 이미 뛰고 있고 리드도 크다. 3루~홈 27.4m 중 리드와
 * 스타트로 이미 벌어 놓은 몫을 빼면 남는 건 절반이 조금 안 된다.
 */
const HOME_STEAL_LEAD = 0.42;
/** 포수가 공을 잡고 홈에서 태그하기까지 (s). 송구가 없으니 팝타임 대신 이것만 붙는다. */
const HOME_TAG_TIME = 0.15;

/**
 * 주자의 '점프' — 속도 능력치로 설명되지 않는 모든 것의 표준편차 (s).
 *
 * 리드를 얼마나 벌렸는지, 투수의 첫 동작을 얼마나 빨리 읽었는지, 송구가 베이스에 정확히
 * 갔는지, 슬라이딩이 태그를 피했는지. 실제 도루의 성패는 대부분 여기서 갈린다.
 *
 * **이 항이 없으면 도루는 속도 능력치만의 함수가 된다.** 실제로 그런 상태였고, 산포가
 * σ0.13(딜리버리 0.06 + 팝타임 0.08 + 주파 0.08)밖에 없어서 속도별 성공률이
 * 50대 17% -> 60대 59% -> 70대 93%로 계단처럼 꺾였다. 속도 70이면 공짜 베이스, 55면
 * 자살이라는 뜻이라 실제 야구(엘리트도 20%는 잡힌다)와 다르고, 무엇보다 능력치 몇 포인트
 * 차이가 결과를 통째로 뒤집어 예측이 불가능해진다.
 *
 * 0.25초는 8.5m/s에서 리드 2m 남짓에 해당한다. 좋은 점프와 나쁜 점프의 차이로 그 정도는
 * 충분히 벌어지고, 여기에 송구 정확도까지 얹힌 몫이다. 이 값으로 곡선이 MLB 모양
 * (엘리트 ~80% · 경계 ~55%)에 맞는다.
 */
const STEAL_JUMP_SIGMA = 0.25;

/** 도루 저지에 걸리는 시간의 분해. 합이 주자의 주파 시간과 겨루는 값이다. */
export interface StealDefenseTime {
  /** 셋포지션 첫 동작 -> 공을 놓는 순간 */
  delivery: number;
  /** 릴리스 -> 포수 미트 */
  flight: number;
  /** 포구 -> 2루 송구 도달 */
  popTime: number;
  /** delivery + flight + popTime */
  total: number;
}

/**
 * 도루 저지 시간.
 *
 * `delivery`는 **릴리스까지**다. 야구에서 관례적으로 말하는 "딜리버리 타임"(1.3초 안팎)은
 * 미트에 꽂히는 순간까지를 뜻하는데, 여기서는 `flight`를 따로 더하므로 그 관례값을 그대로
 * 쓰면 공 비행을 두 번 세게 된다. 실제로 예전에 그렇게 되어 있었고, 수비 시간이 0.5초
 * 길어진 걸 퀵모션 빈도로 상쇄하고 있었다.
 *
 * 릴리스까지로 쪼갠 대가로 구속이 도루에 영향을 준다 — 느린 변화구를 던지면 주자가 그만큼
 * 벌고, 이건 실제 야구에 있는 효과다.
 *
 * 합계 목표(MLB 실측): 일반 3.30초 · 퀵모션 3.05초.
 */
export function stealDefenseTime(
  rng: Rng,
  catcher: Player | undefined,
  quickPitch: boolean,
  pitchVelocityKmh: number,
): StealDefenseTime {
  // 셋포지션 -> 릴리스. 퀵모션(슬라이드 스텝)이면 짧다.
  const delivery = (quickPitch ? 0.62 : 0.88) + rng.normal(0, 0.06);
  // 릴리스 -> 포수 미트. 18.44m를 평균 구속(감속 92%)으로 나눈 값이라 145km/h에서 0.50초.
  const flight = 18.44 / ((pitchVelocityKmh / 3.6) * 0.92);
  // 포수 팝타임 (포구 -> 2루 송구 도달). 실제 MLB 1.85~2.10초.
  const catcherArm = catcher ? norm(catcher.batting.arm) : 0.4;
  const catcherField = catcher ? norm(catcher.batting.fielding) : 0.4;
  const popTime = lerp(2.1, 1.82, catcherArm * 0.65 + catcherField * 0.35) + rng.normal(0, 0.08);

  return { delivery, flight, popTime, total: delivery + flight + popTime };
}

/**
 * 도루 판정 — 주자의 주파 시간 vs 수비의 저지 시간, 단순 경주다.
 *
 * 180경기 실측으로 유도한 양 끝 (모두 MLB 실측에 맞춤):
 *
 *   주파 (중앙 / p90)     3.60 / 3.10초   <- stealTime
 *   수비 (일반 / 퀵모션)  3.30 / 3.03초   <- stealDefenseTime
 *   산포                  σ0.27           <- 점프 0.25 + 딜리버리 0.06 + 팝타임 0.08
 *
 * 여기서 나오는 속도별 성공률: 40대 10% · 50대 28% · 60대 56% · 70대 84% · 80대 94%.
 * 그 위에서 ai.decideSteal이 손익분기(69%) 위 주자만 뛰게 걸러 팀·경기당 도루 0.51 ·
 * 도실 0.18 · 성공률 74%를 만든다 (MLB 0.5~0.6 · 0.2 · 75%).
 *
 * `pitcher`는 아직 쓰이지 않는다. 실제로는 딜리버리 타임이 투수마다 다르지만 지금은
 * 퀵모션 여부로만 갈린다.
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
  const def = stealDefenseTime(rng, catcher, quickPitch, pitchVelocityKmh);

  for (const from of stealFrom.slice().sort((a, b) => b - a)) {
    const runner = bases[from];
    if (!runner) continue;
    // 다음 베이스가 이미 차 있으면 뛰지 않는다 (더블 스틸은 앞 주자부터 처리되므로 갱신 확인)
    if (from < 2 && bases[from + 1] && !stealFrom.includes(from + 1)) continue;
    const p = roster[runner.playerId];
    if (!p) continue;

    if (from === 2) {
      // 홈 스틸.
      //
      // 3루 주자는 투수의 첫 동작에 맞춰 뛰기 때문에 3루~홈 전 구간을 새로 달리는 게 아니라
      // 리드로 이미 줄여 놓은 나머지만 남는다. 그래서 주파 시간에 HOME_STEAL_LEAD를 곱한다.
      // 수비는 포수 송구가 필요 없으므로 팝타임 대신 태그 시간만 붙는다.
      //
      // 예전에는 전 구간(×0.86 ≈ 3.0초)을 딜리버리 하나(1.32초)와 겨루게 해서 **성공률이
      // 구조적으로 정확히 0이었다.** CPU는 홈 스틸을 시도하지 않아 드러나지 않았지만,
      // 사람이 홈 스틸을 명령하면 주자가 누구든 무조건 아웃이었다.
      const runTime = stealTime(p, 2) * HOME_STEAL_LEAD + rng.normal(0, 0.08);
      const defTime = def.delivery + def.flight + HOME_TAG_TIME;
      // 순수 경주로만 보면 발 빠른 주자는 늘 성공하는데, 실제 홈 스틸의 성패는 기습이
      // 통했는지(투수가 와인드업에 들어갔는지, 주자를 봤는지)에 달려 있다.
      const safe = runTime < defTime && rng.chance(0.35 + norm(effSpeed(p)) * 0.25);
      results.push({
        fromBase: from,
        playerId: runner.playerId,
        safe,
        runTime,
        defTime,
        catchTime: def.delivery + def.flight,
      });
      continue;
    }

    const runTime = stealTime(p, from) + rng.normal(0, STEAL_JUMP_SIGMA);
    // 2루->3루는 포수 송구가 짧아 수비가 유리하다 -> 팝타임에서 깎는다
    const throwAdj = from === 1 ? -STEAL3_THROW_GAIN : 0;
    const defTime = def.total + throwAdj;
    const safe = runTime < defTime;
    results.push({
      fromBase: from,
      playerId: runner.playerId,
      safe,
      runTime,
      defTime,
      catchTime: def.delivery + def.flight,
    });
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

/**
 * 주자가 타구를 보고 스타트를 끊기까지 (s). 리드오프로 버는 이득은 이미 뺀 값.
 * 베이스를 돌 때는 원을 그리며 감속하므로 한 베이스를 지날 때마다 비용이 붙는다.
 *
 * 이 둘이 없으면 주자가 타격과 동시에 최고 속도로 출발해 직선으로 달리는 셈이라
 * 1루 주자가 단타에 3루까지 가는 비율이 79%가 된다 (MLB 29%). 실제로 단타에서
 * 1루→3루는 7.5초쯤 걸리고, 3루 송구는 6.6초쯤에 도착한다.
 */
const RUNNER_READ_DELAY = 0.45;
const BASE_TURN_COST = 0.25;

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
      const aggressive = norm(effSpeed(p)) * 0.25;
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
    const aggressive = 0.15 + norm(effSpeed(batter)) * 0.38;
    // 3루는 훨씬 보수적으로 판단한다. "3루에서 아웃되지 마라"는 실제 주루의
    // 원칙이고, 이 여유가 없으면 2루타가 될 타구가 3루타로 기록된다.
    const margin = SAFETY_MARGIN + (target >= 2 ? 0.55 : 0);
    if (cum + margin - aggressive < throwT) {
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
    let time =
      (input.runningStart?.[i] ? -RUNNING_START_BONUS : 0) + RUNNER_READ_DELAY;
    const rSpeed = baseToBase(p);
    // 주자는 타자보다 최소 1베이스는 더 갈 수 있다 (이미 리드 중)
    for (let step = 1; step <= 3 - i; step++) {
      time += rSpeed + (step > 1 ? BASE_TURN_COST : 0);
      const target = i + step;
      const throwT = throwArrivalTime(play, target);
      const aggressive = 0.15 + norm(effSpeed(p)) * 0.4 + (outsAfter === 2 ? 0.3 : 0);
      const margin = target === 3 ? SAFETY_MARGIN + 0.1 : SAFETY_MARGIN;
      if (time + margin - aggressive < throwT) {
        pos = target;
      } else {
        // 아슬아슬하면 도박을 걸기도 한다
        if (target === 3 && time < throwT + 0.35 && rng.chance(0.25 + norm(effSpeed(p)) * 0.2)) {
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

  // ---- 타자 배치 --------------------------------------------------------
  // 얻어낸 베이스가 차 있으면 **앞 주자가 포스로 밀려나고** 타자는 자기 자리에
  // 선다. 예전에는 타자를 한 칸 앞으로 보냈는데, 그러면 막힌 단타가 2루타로,
  // 2루타가 3루타로 둔갑한다 (베이스가 막혔다고 주자가 승격될 리 없다).
  if (batterBase >= 3) {
    scored.push({ playerId: batter.id, responsiblePitcherId: '', stealing: false });
  } else {
    const bb = Math.min(batterBase, 2);
    // 포스는 **연속으로 막힌 만큼만** 이어진다. 타자가 설 자리부터 위로 훑어
    // 첫 빈 베이스를 찾고, 거기까지만 한 칸씩 밀어낸다. 조건 없이 전부 밀면
    // 2루에 멈춘 주자가 3루로, 3루 주자가 홈으로 떠밀려 득점이 폭증한다.
    let firstFree = bb;
    while (firstFree <= 2 && newBases[firstFree]) firstFree++;
    for (let i = firstFree - 1; i >= bb; i--) {
      const r = newBases[i]!;
      newBases[i] = null;
      if (i + 1 > 2) scored.push(r);
      else newBases[i + 1] = r;
    }
    newBases[bb] = { playerId: batter.id, responsiblePitcherId: '', stealing: false };
    batterBase = bb;
  }

  return { bases: newBases, scored, outsMade, batterBase, doublePlay: false, fieldersChoice: false, fielders };
}

export { SAFETY_MARGIN };
