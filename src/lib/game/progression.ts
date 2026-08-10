import { clamp } from './rng';
import type { PitchType, Player, Team, Tier } from './types';

/**
 * 선수 진행(티어 · 레벨 · 경험치) 시스템.
 *
 * 성장의 축은 둘이다.
 *   - **레벨**: 경기 경험치로 오른다. 오를 때마다 그 선수 전용 훈련 포인트를 준다.
 *   - **티어**: 최대 레벨에 도달한 선수에게 골드를 써서 올린다.
 *
 * 티어 강화는 능력치를 **전혀 건드리지 않는다.** 레벨만 1로 되돌리고 상한(최대 레벨,
 * 능력치 상한, 구종 슬롯)을 넓혀 줄 뿐이다. 그래서 "C 10레벨의 능력치 그대로 B 1레벨이 된다"가
 * 자동으로 성립하고, 능력치는 오직 훈련 포인트를 써야만 오른다.
 */

export const TIER_ORDER: Tier[] = ['C', 'B', 'A', 'S'];

export const TIER_KO: Record<Tier, string> = { C: 'C등급', B: 'B등급', A: 'A등급', S: 'S등급' };

/** 티어 색상 (UI 배지) */
export const TIER_COLOR: Record<Tier, string> = {
  C: '#94a3b8',
  B: '#38bdf8',
  A: '#a78bfa',
  S: '#fbbf24',
};

/** 티어별 최대 레벨. 여기 도달해야 티어 강화를 할 수 있다. */
export const TIER_MAX_LEVEL: Record<Tier, number> = { C: 10, B: 20, A: 30, S: 40 };

/**
 * 티어별 능력치 상한. 선수 고유 potential과 min으로 결합된다.
 * 티어를 올리지 않으면 아무리 훈련해도 이 값에서 막힌다.
 */
export const TIER_STAT_CAP: Record<Tier, number> = { C: 65, B: 78, A: 89, S: 99 };

/** 티어별 보유 가능한 구종 수 (직구 포함) */
export const TIER_PITCH_SLOTS: Record<Tier, number> = { C: 3, B: 4, A: 5, S: 6 };

/** 티어 강화 비용. 위로 갈수록 가파르게 오른다. */
export const TIER_UP_GOLD: Record<Exclude<Tier, 'S'>, number> = {
  C: 2000,
  B: 8000,
  A: 25000,
};

/** 레벨업 1회당 지급되는 훈련 포인트. 높은 티어일수록 한 레벨의 값어치가 크다. */
export const TP_PER_LEVEL: Record<Tier, number> = { C: 4, B: 6, A: 8, S: 10 };

/**
 * 레벨업 경험치 곡선.
 *
 * C1 -> S40까지 총 96회 레벨업에 약 2만 경험치가 든다. 주전 타자가 한 경기에서 60~130,
 * 선발 투수가 한 등판에서 200 안팎을 받으므로 대략 300경기 규모의 장기 목표가 된다.
 * 밸런스를 만질 때는 이 세 상수만 건드리면 된다.
 */
const EXP_BASE = 20;
const EXP_SCALE = 6;
const EXP_POW = 1.25;

/** 현재 티어에서 다음 레벨까지 필요한 경험치 */
export function expToNext(level: number): number {
  return Math.round(EXP_BASE + EXP_SCALE * Math.pow(Math.max(1, level), EXP_POW));
}

export function maxLevel(p: Player): number {
  return TIER_MAX_LEVEL[p.tier];
}

export function isMaxLevel(p: Player): boolean {
  return p.level >= TIER_MAX_LEVEL[p.tier];
}

/**
 * 이 선수의 유효 능력치 상한.
 * 티어가 천장을 정하고, 선수 고유 potential이 그보다 낮으면 그쪽이 먼저 막는다.
 */
export function statCap(p: Player): number {
  return Math.min(p.potential, TIER_STAT_CAP[p.tier]);
}

/** 지금 보유한 구종 수 */
export function pitchSlotsUsed(p: Player): number {
  return Object.keys(p.pitching?.arsenal ?? {}).length as number;
}

/** 이 티어에서 보유할 수 있는 구종 수 */
export function pitchSlots(p: Player): number {
  return TIER_PITCH_SLOTS[p.tier];
}

export function canLearnMorePitches(p: Player): boolean {
  return pitchSlotsUsed(p) < pitchSlots(p);
}

/** 티어 상한을 넘겨 보유한 구종이 있으면 그 목록 (구 데이터/치트 방지용 표시) */
export function overflowPitches(p: Player): PitchType[] {
  const owned = Object.keys(p.pitching?.arsenal ?? {}) as PitchType[];
  return owned.slice(pitchSlots(p));
}

export interface ExpGain {
  player: Player;
  /** 이번에 오른 레벨 수 */
  levelUps: number;
  /** 레벨업으로 받은 훈련 포인트 */
  pointsGained: number;
  /** 최대 레벨에 막혀 버려진 경험치 */
  wasted: number;
}

/**
 * 경험치를 넣고 레벨업을 정산한다.
 *
 * 최대 레벨에 도달하면 경험치를 더 받지 않는다 — 티어를 강화해야 다시 쌓인다.
 * 그래야 "레벨이 꽉 찼는데도 경험치만 계속 사라진다"가 아니라 "강화할 때가 됐다"로 읽힌다.
 */
export function grantExp(player: Player, amount: number): ExpGain {
  const p = structuredClone(player);
  let levelUps = 0;
  let pointsGained = 0;

  if (amount <= 0) return { player: p, levelUps, pointsGained, wasted: 0 };
  if (isMaxLevel(p)) return { player: p, levelUps, pointsGained, wasted: Math.round(amount) };

  let pool = Math.round(amount);
  p.exp += pool;
  pool = 0;

  while (!isMaxLevel(p) && p.exp >= expToNext(p.level)) {
    p.exp -= expToNext(p.level);
    p.level += 1;
    levelUps += 1;
    pointsGained += TP_PER_LEVEL[p.tier];
  }

  p.trainingPoints += pointsGained;

  // 최대 레벨에서는 경험치를 쌓아 두지 않는다
  let wasted = 0;
  if (isMaxLevel(p)) {
    wasted = p.exp;
    p.exp = 0;
  }

  return { player: p, levelUps, pointsGained, wasted };
}

export function nextTier(tier: Tier): Tier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** 티어 강화 비용. 최고 티어면 null. */
export function tierUpCost(p: Player): number | null {
  if (p.tier === 'S') return null;
  return TIER_UP_GOLD[p.tier];
}

export function canTierUp(p: Player): boolean {
  return p.tier !== 'S' && isMaxLevel(p);
}

export interface TierUpResult {
  ok: boolean;
  team: Team;
  message: string;
}

/**
 * 골드를 써서 티어를 한 칸 올린다.
 *
 * 능력치(batting / stamina / arsenal)는 손대지 않는다. 레벨만 1로 되돌아간다.
 */
export function upgradeTier(team: Team, playerId: string): TierUpResult {
  const player = team.players.find((x) => x.id === playerId);
  if (!player) return { ok: false, team, message: '선수를 찾을 수 없습니다.' };
  if (player.tier === 'S') return { ok: false, team, message: '이미 최고 티어입니다.' };
  if (!isMaxLevel(player)) {
    return {
      ok: false,
      team,
      message: `${TIER_KO[player.tier]} 최대 레벨(${TIER_MAX_LEVEL[player.tier]})에 도달해야 강화할 수 있습니다.`,
    };
  }

  const cost = TIER_UP_GOLD[player.tier];
  if (team.gold < cost) {
    return { ok: false, team, message: `골드가 부족합니다. (필요: ${cost.toLocaleString()}G)` };
  }

  const up = nextTier(player.tier)!;
  const next: Player = { ...structuredClone(player), tier: up, level: 1, exp: 0 };

  return {
    ok: true,
    team: {
      ...team,
      gold: team.gold - cost,
      players: team.players.map((x) => (x.id === playerId ? next : x)),
    },
    message: `${player.name} ${TIER_KO[up]} 강화 완료! 능력치는 그대로 유지됩니다.`,
  };
}

// ---------------------------------------------------------------------------
// 표시용 파생값
// ---------------------------------------------------------------------------

/** 현재 레벨의 진행률 (0~1). 최대 레벨이면 1. */
export function levelProgress(p: Player): number {
  if (isMaxLevel(p)) return 1;
  return clamp(p.exp / expToNext(p.level), 0, 1);
}

/** 로스터 목록에 쓸 한 줄 요약 */
export function describeGrade(p: Player): string {
  return `${p.tier} · Lv.${p.level}${isMaxLevel(p) ? ' (MAX)' : ''}`;
}
