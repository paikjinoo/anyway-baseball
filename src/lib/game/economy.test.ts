import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { emptySeason, generateTeam } from './generator';
import { LEAGUE_PLACE_GOLD, POSTSEASON_GOLD, simulateGame } from './league';
import {
  BASE_GAME_GOLD,
  OUTCOME_MULT,
  applyMatchResult,
  outcomeOf,
  playerMatchExp,
} from './matchReward';
import {
  TIER_MAX_LEVEL,
  TIER_UP_GOLD,
  TP_PER_LEVEL,
  canTierUp,
  expToNext,
  isMaxLevel,
  naturalTierGold,
  tierUpCost,
  upgradeTier,
} from './progression';
import { autoInvest } from './training';
import { closeSeason } from './season';
import { DEFAULT_SETTINGS } from './types';
import type { Player, Team, Tier } from './types';

/**
 * 경제 회귀 — 시즌 단위 곡선.
 *
 * 다른 테스트들은 **점**을 잰다: progression은 공식 하나, shop은 거래 하나,
 * matchReward는 경기 하나, balance는 산출물의 빈도. 이 파일이 재는 것은 그 넷의
 * 합성이 여러 시즌에 걸쳐 **어디에 도달하는가**라는 선이다.
 *
 * **규칙: 어떤 상수의 값도 다시 단정하지 않는다.** 상수에서 파생된 "몇 경기 만에 /
 * 몇 배만큼"만 단정한다. 이게 없으면 shop·progression 테스트와 그냥 중복이 된다.
 *
 * 아이템은 넣지 않는다 — 경험치보충제를 넣는 순간 "언제 누구에게 쓰느냐"는 정책이
 * 지표에 섞여 측정이 흐려진다. 그 축은 items/progression 테스트가 본다.
 */

/** 한 시즌에 치르는 경기 수. 티어를 최소 한 번 넘어가는 길이여야 곡선이 보인다. */
const GAMES_PER_SEASON = 24;
const SEASONS = 3;
const TOTAL_GAMES = GAMES_PER_SEASON * SEASONS;

// ---------------------------------------------------------------------------
// 플레이 방식의 모델
// ---------------------------------------------------------------------------

/** 주전(타순 + 로테이션)만 키운다. 로스터 전원에게 고루 뿌리는 건 아무도 못 키우는 플레이다. */
function coreIds(team: Team): Set<string> {
  return new Set([...team.lineup, ...team.rotation]);
}

/**
 * 훈련 포인트는 생기는 대로 쓰고, 최대 레벨에 닿은 선수는 싼 것부터 강화한다.
 *
 * autoInvest는 **trainingPoints를 깎지 않는다**(호출부가 회계를 정하도록 일부러 그렇게 돼
 * 있다). 여기서 깎지 않으면 무한 포인트가 되어 3시즌 만에 전원이 잠재력 상한에 닿고
 * 측정이 통째로 무의미해진다. 실제 훈련(training.trainBatting)이 하는 회계와 같게 맞춘다.
 */
function spendEverything(team: Team): Team {
  const core = coreIds(team);

  let next: Team = {
    ...team,
    players: team.players.map((p) => {
      if (!core.has(p.id) || p.trainingPoints <= 0) return p;
      const r = autoInvest(p, p.trainingPoints);
      if (r.spent <= 0) return p;
      return {
        ...r.player,
        trainingPoints: p.trainingPoints - r.spent,
        spentPoints: p.spentPoints + r.spent,
      };
    }),
  };

  // 강화는 싼 순서대로. 비싼 쪽을 먼저 지르면 골드가 묶여 아무도 못 올라간다.
  for (;;) {
    const ready = next.players
      .filter((p) => core.has(p.id) && canTierUp(p))
      .map((p) => ({ p, cost: tierUpCost(p) ?? Infinity }))
      .filter((x) => x.cost <= next.gold)
      .sort((a, b) => a.cost - b.cost);
    if (!ready.length) break;
    const res = upgradeTier(next, ready[0].p.id);
    if (!res.ok) break;
    next = res.team;
  }
  return next;
}

/** 그 시즌 승률로 정한 리그 순위 보상. 시뮬레이션 대신 승률로 등수를 가른다. */
function leagueBonus(wins: number, games: number): number {
  const pct = wins / games;
  if (pct >= 0.6) return LEAGUE_PLACE_GOLD[0] + POSTSEASON_GOLD.champion;
  if (pct >= 0.5) return LEAGUE_PLACE_GOLD[1];
  if (pct >= 0.45) return LEAGUE_PLACE_GOLD[2];
  return 0;
}

// ---------------------------------------------------------------------------
// 커리어 시뮬레이션
// ---------------------------------------------------------------------------

interface SeasonSnapshot {
  seasonNo: number;
  wins: number;
  gold: number;
  tiers: Record<Tier, number>;
  /** 주전 타자의 능력치 총합 평균 */
  coreBattingSum: number;
}

interface Run {
  team: Team;
  matchGoldTotal: number;
  leagueGoldTotal: number;
  grantedExp: number;
  /**
   * 최대 레벨에 막혀 버려진 경험치.
   * grantedExp는 산정된 raw 값이라 이 몫을 **이미 포함하고 있다.**
   */
  wastedExp: number;
  wins: number;
  /** 주전 타자 한 명이 커리어 전체에서 받은 경험치 (표본: 1번 타자) */
  leadoffExp: number;
  seasons: SeasonSnapshot[];
  startBattingSum: number;
}

function battingSum(p: Player): number {
  const b = p.batting;
  return b.contact + b.power + b.eye + b.speed + b.fielding + b.arm;
}

function coreBattingAvg(team: Team): number {
  const core = team.lineup.map((id) => team.players.find((p) => p.id === id)).filter(Boolean);
  return core.reduce((a, p) => a + battingSum(p!), 0) / Math.max(1, core.length);
}

function tierCounts(team: Team): Record<Tier, number> {
  const out: Record<Tier, number> = { C: 0, B: 0, A: 0, S: 0 };
  for (const id of coreIds(team)) {
    const p = team.players.find((x) => x.id === id);
    if (p) out[p.tier] += 1;
  }
  return out;
}

function simulateCareer(): Run {
  const rng = new Rng(seedFromString('economy'));
  // 창단 로스터(17명, 골드 0)에서 출발한다. 기본값인 23명 FULL로 재면 로스터 비용이 부풀려진다.
  let team = generateTeam(rng, { ownerUid: 'me', plan: 'FOUNDING' });

  const run: Run = {
    team,
    matchGoldTotal: 0,
    leagueGoldTotal: 0,
    grantedExp: 0,
    wastedExp: 0,
    wins: 0,
    leadoffExp: 0,
    seasons: [],
    startBattingSum: coreBattingAvg(team),
  };
  const leadoffId = team.lineup[0];

  for (let season = 1; season <= SEASONS; season++) {
    // 상대는 시즌 동안 고정한다. 매 경기 새로 만들면 "내 팀이 세져서 승률이 오른다"는 신호가 깨진다.
    //
    // **같은 창단 로스터로 맞춘다.** 리그의 CPU는 23명짜리 완성 로스터라 창단 직후의
    // 17명으로 붙으면 승률이 26%까지 떨어지고, 그러면 순위 보상이 한 번도 안 나와
    // "리그 보상까지 포함한 경제"를 잰다는 말이 거짓이 된다. 여기서 재려는 것은
    // 난이도가 아니라 곡선이므로 대등한 상대가 옳은 대조군이다.
    // 시즌마다 상대를 세게 만들면 트레드밀이 되어 팀이 커도 승률이 그대로다.
    // 고정해 두면 성장이 승률로 드러나고, 순위 보상이 실제로 발생하는 지점도 볼 수 있다.
    const foe = generateTeam(new Rng(seedFromString('economy-foe')), {
      ownerUid: 'cpu',
      plan: 'FOUNDING',
    });
    let seasonWins = 0;

    for (let g = 1; g <= GAMES_PER_SEASON; g++) {
      // 홈/원정을 번갈아 둔다. 한쪽에 고정하면 홈 이점이 골드에 그대로 실린다.
      const mineIsAway = g % 2 === 1;
      const [away, home] = mineIsAway ? [team, foe] : [foe, team];
      const res = simulateGame(away, home, DEFAULT_SETTINGS, `eco-s${season}-g${g}`);
      const mySide = mineIsAway ? 'away' : 'home';
      const mine = res.state[mySide];
      const theirs = res.state[mineIsAway ? 'home' : 'away'];
      const outcome = outcomeOf(res.state.winner, mySide);
      if (outcome === 'WIN') {
        seasonWins++;
        run.wins++;
      }

      const ctx = {
        kind: 'LEAGUE' as const,
        difficulty: 'NORMAL' as const,
        outcome,
        runsScored: mine.runs,
        runsAllowed: theirs.runs,
        seed: res.state.rngState,
        recordSeason: true,
        decisionPitcherId: mine.pitcherId,
      };

      // 버려지는 경험치는 applyMatchResult **전에** 재야 한다 — grantExp의 wasted가
      // MatchRewardResult로 나오지 않으므로 최대 레벨인 선수를 미리 스냅샷해 다시 계산한다.
      for (const p of team.players) {
        if (!isMaxLevel(p)) continue;
        run.wastedExp += playerMatchExp(p, mine.roster[p.id]?.season ?? emptySeason(), ctx);
      }

      const reward = applyMatchResult(team, mine, ctx);
      run.matchGoldTotal += reward.gold;
      for (const line of reward.lines) {
        run.grantedExp += line.exp;
        if (line.playerId === leadoffId) run.leadoffExp += line.exp;
      }
      team = spendEverything(reward.team);
    }

    const bonus = leagueBonus(seasonWins, GAMES_PER_SEASON);
    run.leagueGoldTotal += bonus;
    team = spendEverything({ ...team, gold: team.gold + bonus });

    // 측정은 반드시 closeSeason 전에 — 마감이 season을 비운다.
    run.seasons.push({
      seasonNo: season,
      wins: seasonWins,
      gold: team.gold,
      tiers: tierCounts(team),
      coreBattingSum: coreBattingAvg(team),
    });
    team = closeSeason(team);
  }

  run.team = team;
  return run;
}

/** 커리어 시뮬레이션은 비싸다. 첫 it이 값을 치르고 나머지는 그 결과를 읽는다. */
let cached: Run | null = null;
function run(): Run {
  return (cached ??= simulateCareer());
}

/** C1 -> S40까지 필요한 총 경험치. 곡선에서 직접 센다. */
function totalCareerExp(): number {
  let sum = 0;
  for (const tier of ['C', 'B', 'A', 'S'] as Tier[]) {
    for (let lv = 1; lv < TIER_MAX_LEVEL[tier]; lv++) sum += expToNext(lv);
  }
  return sum;
}

// ---------------------------------------------------------------------------

describe('경제 곡선 (3시즌 72경기)', () => {
  it('경기당 골드가 구조적 상·하한 안에 머문다', () => {
    const r = run();
    const perGame = r.matchGoldTotal / TOTAL_GAMES;

    // 어떤 평균도 반드시 이 안이다. 벗어나면 계산 자체가 어긋난 것이다.
    expect(perGame).toBeGreaterThan(BASE_GAME_GOLD * OUTCOME_MULT.LOSS);
    expect(perGame).toBeLessThan(BASE_GAME_GOLD * OUTCOME_MULT.WIN + 200 + 100);
    // 실측 회귀 감시선
    expect(perGame).toBeGreaterThan(300);
    expect(perGame).toBeLessThan(500);
  }, 180_000);

  it('한 시즌 수입이 티어 강화 비용으로 읽을 만한 크기다', () => {
    const r = run();
    const perSeason = (r.matchGoldTotal + r.leagueGoldTotal) / SEASONS;

    // 한 시즌이면 C->B 세 번은 된다
    expect(perSeason).toBeGreaterThan(TIER_UP_GOLD.C * 3);
    // 한 시즌을 잘 치러도 A->S 강화 한 번 값을 넘지는 못한다 (실측 약 10,100)
    expect(perSeason).toBeLessThan(TIER_UP_GOLD.A);
  }, 180_000);

  it('★ 병목은 골드가 아니라 경험치다', () => {
    const r = run();
    const expPerGame = r.leadoffExp / TOTAL_GAMES;
    const goldPerGame = (r.matchGoldTotal + r.leagueGoldTotal) / TOTAL_GAMES;

    // 주전 한 명을 C1 -> S40으로 만드는 데 걸리는 경기 수. 300경기를 실제로 돌리지 않고
    // 72경기의 실측 속도에서 파생시킨다.
    const gamesForExp = totalCareerExp() / expPerGame;
    const gamesForGold = naturalTierGold('S') / goldPerGame;

    expect(gamesForExp).toBeGreaterThan(150); // 너무 빠르면 티어가 장식이 된다
    expect(gamesForExp).toBeLessThan(600); // 너무 느리면 S를 평생 못 본다
    // 골드가 병목이 되면 이 게임은 야구가 아니라 골드 파밍이 된다.
    expect(gamesForGold).toBeLessThan(gamesForExp);
  }, 180_000);

  it('★ 로스터 전원을 S로 만들 수는 없다', () => {
    const r = run();
    const goldPerGame = (r.matchGoldTotal + r.leagueGoldTotal) / TOTAL_GAMES;
    const expPerGame = r.leadoffExp / TOTAL_GAMES;
    const careerGames = totalCareerExp() / expPerGame;

    const careerGold = goldPerGame * careerGames;
    const rosterCost = r.team.players.length * naturalTierGold('S');
    const ratio = careerGold / rosterCost;

    // 실측 약 0.20 — 커리어 하나를 꼬박 돌면 로스터의 5분의 1을 S로 올릴 만큼 번다.
    expect(ratio).toBeGreaterThan(0.08); // 아무도 못 키우는 것도 아니고
    // 1을 넘으면 "누구를 키울지 고른다"는 육성 게임 자체가 사라진다. 거기까지 가기 전에
    // 잡으려고 상한을 실측의 2.5배에 둔다.
    expect(ratio).toBeLessThan(0.5);
  }, 180_000);

  it('3시즌 뒤 성장이 눈에 보이되 끝나 있지는 않다', () => {
    const r = run();
    const last = r.seasons[SEASONS - 1].tiers;
    const core = last.C + last.B + last.A + last.S;

    // 절반 이상은 C를 벗어난다
    expect(last.B + last.A + last.S).toBeGreaterThan(core / 2);
    // 72경기 만에 S가 나오면 페이싱이 무너진 것이다
    expect(last.S).toBe(0);
  }, 180_000);

  it('최대 레벨 브레이크가 실제로 작동한다', () => {
    const r = run();
    const wasteRatio = r.wastedExp / r.grantedExp;

    // 실측 약 0.58. 하한이 진짜 목적이다 — 0이면 티어 게이트가 아무도 못 막고 있다는 뜻이고,
    // 그러면 "강화할 때가 됐다"는 신호 자체가 사라진다.
    expect(wasteRatio).toBeGreaterThan(0.05);
    // 반대로 너무 크면 골드 수입이 성장을 통째로 틀어막고 있다는 뜻이다.
    expect(wasteRatio).toBeLessThan(0.85);
  }, 180_000);

  it('훈련 포인트가 실제로 능력치로 바뀐다', () => {
    const r = run();
    const grew = r.seasons[SEASONS - 1].coreBattingSum / r.startBattingSum;

    // "포인트는 쌓이는데 autoInvest가 상한에 막혀 아무것도 못 산다"는 회귀를 잡는다.
    // 실측 약 1.28 (3시즌 72경기)
    expect(grew).toBeGreaterThan(1.1);
    expect(grew).toBeLessThan(2.0);
    // 시즌마다 단조 증가한다
    for (let i = 1; i < SEASONS; i++) {
      expect(r.seasons[i].coreBattingSum).toBeGreaterThanOrEqual(r.seasons[i - 1].coreBattingSum);
    }
  }, 180_000);

  it('팀이 자라면 승률이 오른다', () => {
    // 상대를 고정해 두었으므로 승수 증가는 오직 내 팀의 성장에서 온다.
    // 실측 8 -> 11 -> 13승. 여기가 무너지면 훈련·강화가 경기력에 닿지 않는다는 뜻이다.
    const r = run();
    const wins = r.seasons.map((s) => s.wins);
    expect(wins[SEASONS - 1]).toBeGreaterThan(wins[0]);
    expect(wins[SEASONS - 1] / GAMES_PER_SEASON).toBeGreaterThan(0.45);
  }, 180_000);

  it('루프가 실제 게임 루프와 같은 부수효과를 남긴다', () => {
    const r = run();

    // 로테이션이 경기 수만큼 돌았다
    expect(r.team.rotationIndex).toBe(TOTAL_GAMES % r.team.rotation.length);
    // 피로는 항상 [0, 1]
    for (const p of r.team.players) {
      expect(p.fatigue).toBeGreaterThanOrEqual(0);
      expect(p.fatigue).toBeLessThanOrEqual(1);
    }
    // 승률이 극단으로 쏠리지 않았다 (쏠리면 골드 측정이 승패 배수에 끌려간다)
    const pct = r.wins / TOTAL_GAMES;
    expect(pct).toBeGreaterThan(0.15);
    expect(pct).toBeLessThan(0.85);
    // 마지막 시즌은 마감돼 시즌 기록이 비어 있다
    expect(r.team.players.every((p) => p.season.g === 0)).toBe(true);
  }, 180_000);

  it('레벨업 포인트가 티어별 표와 어긋나지 않는다', () => {
    // 커리어 전체에서 쓴 포인트가 그 선수가 지나온 티어들의 지급량 안에 들어온다.
    const r = run();
    for (const id of r.team.lineup) {
      const p = r.team.players.find((x) => x.id === id)!;
      const maxPossible = (TIER_MAX_LEVEL[p.tier] - 1) * TP_PER_LEVEL[p.tier] + 2000;
      expect(p.spentPoints).toBeLessThan(maxPossible);
      expect(p.spentPoints).toBeGreaterThan(0);
    }
  }, 180_000);
});
