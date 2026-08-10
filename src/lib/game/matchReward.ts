import { Rng, clamp } from './rng';
import { pitchCapacity } from './pitching';
import { grantExp } from './progression';
import { emptySeason } from './generator';
import type { Difficulty } from './ai';
import type { Player, SeasonStat, Team, TeamInGame } from './types';

/**
 * 경기 결과 -> 보상.
 *
 * 예전에는 팀 단위 훈련 포인트를 로스터 전원에게 뿌렸고, 그 코드가 CPU 페이지 · 리그 페이지 ·
 * 온라인 훅 세 곳에 따로 있었다. 지금은 여기 하나로 모은다.
 *
 * 경기가 주는 것은 **선수별 경험치와 팀 골드뿐이다.** 훈련 포인트는 레벨업으로만 들어오고
 * (progression.grantExp), 아이템은 리그를 끝까지 마쳤을 때 1~3위에게만 나온다
 * (league.leagueFinishReward).
 */

export type MatchOutcome = 'WIN' | 'DRAW' | 'LOSS';

/** 난이도 보상 배수. 강한 상대를 이길수록 많이 받는다. */
export const DIFFICULTY_REWARD_MULT: Record<Difficulty, number> = {
  EASY: 0.8,
  NORMAL: 1.0,
  HARD: 1.25,
  PRO: 1.6,
};

/**
 * 승패 배수. 져도 0은 아니다 —
 * 0으로 두면 질 것 같을 때 나가 버리는 편이 이득이 되기 때문이다.
 */
export const OUTCOME_MULT: Record<MatchOutcome, number> = {
  WIN: 1.3,
  DRAW: 1.0,
  LOSS: 0.8,
};

/** 한 경기 기본 골드 (배수 적용 전) */
export const BASE_GAME_GOLD = 300;

/**
 * 쉬는 경기 하나마다 회복되는 피로량.
 * 1/3이므로 완전히 지친 선발도 3경기를 쉬면 스태미나가 가득 찬다.
 */
export const REST_RECOVERY = 1 / 3;

/** 이 배수를 넘겨 던지면 부상 위험이 생긴다 (capacity 대비 투구 수) */
const INJURY_OVERUSE_RATIO = 1.35;
const INJURY_MAX_CHANCE = 0.35;

export interface MatchRewardContext {
  kind: 'CPU' | 'LEAGUE' | 'ONLINE' | 'RELAY';
  /** CPU/리그 난이도. 없으면 NORMAL로 본다. */
  difficulty?: Difficulty;
  outcome: MatchOutcome;
  runsScored: number;
  runsAllowed: number;
  /** 부상 판정용 시드. 경기의 최종 rngState를 넘기면 재현 가능하다. */
  seed: number;
  /** 이 경기를 시즌 기록으로 남길지. 온라인·릴레이는 남기지 않는다. */
  recordSeason: boolean;
  /** 승리 투수로 기록할 선수 (경기 종료 시 마운드에 있던 투수) */
  decisionPitcherId?: string;
  /**
   * 경험치 배율 (0~1). 온라인 하루 한도에 걸렸을 때 남은 한도만큼만 지급하려고 쓴다.
   * 지정하지 않으면 1.
   */
  expScale?: number;
}

export interface PlayerExpLine {
  playerId: string;
  name: string;
  exp: number;
  levelUps: number;
  /** 레벨업으로 받은 훈련 포인트 */
  tp: number;
  /** 이번 경기에서 새로 생긴 부상 */
  injured?: string;
}

export interface MatchRewardResult {
  team: Team;
  gold: number;
  lines: PlayerExpLine[];
}

// ---------------------------------------------------------------------------
// 시즌 기록 병합
// ---------------------------------------------------------------------------

const SEASON_KEYS = Object.keys(emptySeason()) as (keyof SeasonStat)[];

/**
 * 시즌 스탯 두 개를 더한다.
 *
 * 필드를 하나하나 적던 코드가 두 페이지에 복붙돼 있어서 SeasonStat에 필드를 추가하면
 * 한쪽이 조용히 누락됐다. 키 목록에서 도는 지금 방식은 그 회귀가 구조적으로 불가능하다.
 */
export function mergeSeason(a: SeasonStat, b: SeasonStat): SeasonStat {
  const out = {} as SeasonStat;
  for (const k of SEASON_KEYS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

// ---------------------------------------------------------------------------
// 경험치 · 골드
// ---------------------------------------------------------------------------

/**
 * 이 경기에서 선수 한 명이 받는 경험치.
 *
 * 출전하지 않은 선수는 0이다 (요구사항: "경기에 참가시킨 선수들은 경기 종료 후 경험치 획득").
 * 타자는 안타·홈런이, 투수는 이닝과 탈삼진이 추가분의 대부분을 차지한다.
 */
export function playerMatchExp(
  player: Player,
  line: SeasonStat,
  ctx: MatchRewardContext,
): number {
  const mult =
    DIFFICULTY_REWARD_MULT[ctx.difficulty ?? 'NORMAL'] *
    OUTCOME_MULT[ctx.outcome] *
    clamp(ctx.expScale ?? 1, 0, 1);

  if (player.kind === 'PITCHER') {
    if (line.np <= 0) return 0;
    // ip3는 아웃 카운트 단위라 1이닝(3아웃) = 24. 좋은 공을 던졌는지는 탈삼진으로 본다.
    const raw = 40 + line.ip3 * 8 + line.pk * 10 - line.er * 2;
    return Math.max(0, Math.round(Math.max(10, raw) * mult));
  }

  if (line.pa <= 0) return 0;
  const raw =
    40 +
    line.h * 16 +
    line.hr * 28 +
    line.double * 6 +
    line.triple * 12 +
    line.rbi * 4 +
    line.bb * 3 +
    line.sb * 5;
  return Math.max(0, Math.round(raw * mult));
}

/**
 * 팀이 받는 골드.
 *
 * 온라인·릴레이는 득점과 완봉에 값을 매기지 않는다. 상대와 짜고 치면 점수는 얼마든지 만들 수
 * 있어서, 득점에 값을 걸면 그게 곧 승부조작의 대가가 되기 때문이다. 승패라는 결과 하나만 본다.
 */
export function matchGold(ctx: MatchRewardContext): number {
  const mult =
    DIFFICULTY_REWARD_MULT[ctx.difficulty ?? 'NORMAL'] * OUTCOME_MULT[ctx.outcome];
  let gold = BASE_GAME_GOLD * mult;
  if (ctx.kind === 'CPU' || ctx.kind === 'LEAGUE') {
    gold += Math.min(200, ctx.runsScored * 10);
    if (ctx.runsAllowed === 0) gold += 100;
  }
  return Math.round(gold);
}

// ---------------------------------------------------------------------------
// 피로 · 부상
// ---------------------------------------------------------------------------

/**
 * 경기 하나가 끝난 뒤의 피로도.
 *
 * 던진 만큼 쌓이고, 등판하지 않았으면 REST_RECOVERY만큼 회복된다.
 * 완전히 지친(1.0) 선발이 3경기 연속으로 쉬면 정확히 0이 된다.
 */
export function nextFatigue(player: Player, pitchesThrown: number): number {
  const capacity = pitchCapacity(player);
  const raw =
    pitchesThrown > 0
      ? (player.fatigue ?? 0) + pitchesThrown / capacity
      : (player.fatigue ?? 0) - REST_RECOVERY;
  // 1/3을 세 번 빼면 0이 아니라 1.1e-16이 남는다. 그대로 두면 완전히 쉰 투수가
  // 영원히 "회복 중"으로 남아 스테미나회복제를 헛되이 쓸 수 있다.
  const next = clamp(raw, 0, 1);
  return next < 1e-9 ? 0 : next;
}

/** 혹사·사구로 부상이 생겼는지. 없으면 null. */
function rollInjury(player: Player, line: SeasonStat, rng: Rng): { gamesLeft: number; reason: string } | null {
  if (player.injury) return null;

  if (player.kind === 'PITCHER' && line.np > 0) {
    const ratio = line.np / pitchCapacity(player);
    if (ratio > INJURY_OVERUSE_RATIO) {
      const chance = Math.min(INJURY_MAX_CHANCE, (ratio - INJURY_OVERUSE_RATIO) * 0.5);
      if (rng.chance(chance)) return { gamesLeft: rng.int(2, 5), reason: '투구 과부하' };
    }
    return null;
  }

  if (line.hbp > 0 && rng.chance(0.04 * line.hbp)) {
    return { gamesLeft: rng.int(1, 3), reason: '사구 타박' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 적용
// ---------------------------------------------------------------------------

/**
 * 경기 결과를 팀에 반영한다.
 *
 * @param mine 내 팀의 경기 내 상태. 온라인·릴레이처럼 델타를 쓰지 않는 모드는 null을 넘긴다
 *             (그래도 골드는 나가고, 피로 회복과 부상 카운트다운은 돈다).
 */
export function applyMatchResult(
  team: Team,
  mine: TeamInGame | null,
  ctx: MatchRewardContext,
): MatchRewardResult {
  const rng = new Rng(ctx.seed >>> 0);
  const gold = matchGold(ctx);
  const lines: PlayerExpLine[] = [];
  const empty = emptySeason();

  const players = team.players.map((p) => {
    const inGame = mine?.roster[p.id];
    const line = inGame?.season ?? empty;

    let next: Player = structuredClone(p);

    // 1) 시즌 기록. 온라인·릴레이는 상대 전력이 제각각이라 통산 기록에 섞지 않는다.
    if (ctx.recordSeason && inGame) {
      const decision =
        ctx.decisionPitcherId === p.id
          ? {
              ...line,
              w: line.w + (ctx.outcome === 'WIN' ? 1 : 0),
              l: line.l + (ctx.outcome === 'LOSS' ? 1 : 0),
            }
          : line;
      next.season = mergeSeason(p.season, decision);
    }

    // 2) 경험치 -> 레벨업 -> 훈련 포인트
    const exp = mine ? playerMatchExp(p, line, ctx) : 0;
    let levelUps = 0;
    let tp = 0;
    if (exp > 0) {
      const gain = grantExp(next, exp);
      next = gain.player;
      levelUps = gain.levelUps;
      tp = gain.pointsGained;
    }

    // 3) 투수 피로 이월
    if (next.kind === 'PITCHER') next.fatigue = nextFatigue(p, line.np);

    // 4) 부상 카운트다운 -> 신규 부상
    if (next.injury) {
      const left = next.injury.gamesLeft - 1;
      if (left <= 0) delete next.injury;
      else next.injury = { ...next.injury, gamesLeft: left };
    }
    let injured: string | undefined;
    if (mine) {
      const hurt = rollInjury(next, line, rng);
      if (hurt) {
        next.injury = hurt;
        injured = hurt.reason;
      }
    }

    if (exp > 0 || injured) {
      lines.push({ playerId: p.id, name: p.name, exp, levelUps, tp, injured });
    }
    return next;
  });

  lines.sort((a, b) => b.exp - a.exp);

  const rotationLen = Math.max(1, team.rotation.length);
  return {
    gold,
    lines,
    team: {
      ...team,
      players,
      gold: team.gold + gold,
      // 다음 경기는 로테이션의 다음 선발이 나간다.
      rotationIndex: (team.rotationIndex + 1) % rotationLen,
    },
  };
}

/** 승/패/무 판정 헬퍼 */
export function outcomeOf(winner: 'away' | 'home' | 'TIE' | undefined, mySide: 'away' | 'home'): MatchOutcome {
  if (!winner || winner === 'TIE') return 'DRAW';
  return winner === mySide ? 'WIN' : 'LOSS';
}

/**
 * 릴레이(개인전) 순위를 승패로 환산한다.
 * 1위는 승리, 최하위는 패배, 그 사이는 무승부로 본다.
 */
export function relayOutcome(rank: number, participants: number): MatchOutcome {
  if (participants <= 1) return 'DRAW';
  if (rank === 1) return 'WIN';
  if (rank >= participants) return 'LOSS';
  return 'DRAW';
}
