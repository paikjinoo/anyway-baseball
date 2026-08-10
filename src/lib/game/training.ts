import { Rng, clamp } from './rng';
import { LEARNABLE_PITCHES, PITCH_DEFS } from './constants';
import { TIER_KO, canLearnMorePitches, pitchSlots, pitchSlotsUsed, statCap } from './progression';
import type { BattingAttr, PitchAttr, PitchType, Player } from './types';

/**
 * 훈련 시스템.
 *
 * 능력치 상한은 **티어 상한과 선수 고유 잠재력 중 낮은 쪽**(progression.statCap)이며,
 * 현재 값이 높을수록 1포인트를 올리는 비용이 급격히 증가한다. 덕분에 한 선수에게 몰빵해도
 * 만능이 되지 않고, 상한에 막히면 티어를 올려야 다시 자란다.
 *
 * 훈련 포인트는 이제 경기 보상이 아니라 **레벨업으로만** 들어온다 (progression.grantExp).
 */

/**
 * 능력치를 현재 값에서 1 올리는 데 드는 훈련 포인트.
 * `cap`에는 progression.statCap(player)를 넘긴다 (티어 상한 ∧ 잠재력).
 */
export function statUpgradeCost(current: number, cap: number): number {
  if (current >= cap) return Infinity;
  // 40 이하 저렴, 70부터 급증, 90 이상은 매우 비쌈
  const base = 2;
  const curve = Math.pow(Math.max(0, current - 35) / 12, 2.15);
  return Math.max(base, Math.round(base + curve));
}

/** 구종 능력치 1 올리는 비용. 난이도가 높은 구종일수록 비싸다. */
export function pitchUpgradeCost(current: number, cap: number, type: PitchType): number {
  const c = statUpgradeCost(current, cap);
  if (!Number.isFinite(c)) return c;
  return Math.max(2, Math.round(c * (0.85 + PITCH_DEFS[type].difficulty * 0.28)));
}

/** 새 구종 습득 비용 */
export function learnPitchCost(type: PitchType, pitcher: Player): number {
  const owned = pitchSlotsUsed(pitcher);
  const base = 90 * PITCH_DEFS[type].difficulty;
  // 이미 많은 구종을 가진 투수는 추가 습득이 비싸다
  return Math.round(base * (1 + (owned - 1) * 0.35));
}

export type TrainableBattingKey = keyof BattingAttr;
export const BATTING_KEYS: TrainableBattingKey[] = [
  'contact', 'power', 'eye', 'speed', 'fielding', 'arm',
];
export const BATTING_KEY_KO: Record<TrainableBattingKey, string> = {
  contact: '컨택',
  power: '파워',
  eye: '선구안',
  speed: '스피드',
  fielding: '수비',
  arm: '송구',
};
export const PITCH_ATTR_KO: Record<keyof PitchAttr, string> = {
  velocity: '구속',
  control: '제구',
  movement: '무브먼트',
};

/**
 * 능력치가 높으면 경기에서 무엇이 좋아지는지 (훈련 화면에서 항목을 눌렀을 때 표시).
 * 실제 엔진이 그 값을 어디에 쓰는지에 맞춰 적는다.
 */
export const BATTING_KEY_DESC: Record<TrainableBattingKey, string> = {
  contact:
    '배트에 맞는 판정 반경과 타이밍 허용 폭이 함께 넓어집니다. 헛스윙이 줄고 조금 어긋나게 맞혀도 타구가 살아나 타율이 오릅니다.',
  power:
    '같은 품질로 맞혀도 타구 속도가 더 빠르게 나갑니다. 외야수 키를 넘기는 장타와 홈런이 늘어납니다.',
  eye:
    '변화구 궤적에 덜 속고, 존을 벗어난 공에 방망이가 나가는 일이 줄어듭니다. 볼넷이 늘고 유리한 카운트를 만들기 쉬워집니다.',
  speed:
    '1루까지 도달 시간과 베이스 간 주루가 빨라집니다. 내야 안타·도루 성공률이 오르고 한 베이스 더 노릴 수 있으며, 수비 때 타구를 쫓는 속도도 함께 빨라집니다.',
  fielding:
    '타구에 반응하는 시간이 짧아지고 처리 범위가 넓어집니다. 포구 후 송구 동작도 빨라지고 실책 확률이 줄어듭니다.',
  arm:
    '송구가 빨라져 병살 완성과 주자 저지가 쉬워집니다. 포수라면 도루 저지율이 크게 올라갑니다.',
};

export const PITCH_ATTR_DESC: Record<keyof PitchAttr, string> = {
  velocity:
    '공이 빠를수록 타자의 타이밍 창이 좁아집니다. 헛스윙이 늘고, 맞아도 정확히 맞히기 어려워집니다.',
  control:
    '노린 지점에서 공이 흩어지는 폭이 줄어듭니다. 원하는 코스에 넣을 수 있어 볼넷이 줄고 유인구가 살아납니다.',
  movement:
    '궤적 변화량이 커져 타자의 조준을 어긋나게 만듭니다. 선구안이 낮은 타자는 특히 잘 속습니다.',
};

/** 스태미나 설명 */
export const STAMINA_DESC =
  '한 경기에서 던질 수 있는 투구 수가 늘어납니다. 지치면 구속이 떨어지고 제구가 흔들리므로, 선발로 길게 끌고 가려면 꼭 필요합니다.';

export interface TrainResult {
  ok: boolean;
  message: string;
  player: Player;
}

/** 타자 능력치 훈련 */
export function trainBatting(player: Player, key: TrainableBattingKey, points = 1): TrainResult {
  const p = structuredClone(player);
  const cap = statCap(p);
  let spent = 0;
  let gained = 0;
  for (let i = 0; i < points; i++) {
    const cur = p.batting[key];
    const cost = statUpgradeCost(cur, cap);
    if (!Number.isFinite(cost)) {
      p.spentPoints += spent;
      return gained > 0
        ? { ok: true, message: `${BATTING_KEY_KO[key]} +${gained} (상한 ${cap} 도달)`, player: p }
        : { ok: false, message: capMessage(player, cap), player };
    }
    if (p.trainingPoints < cost) {
      p.spentPoints += spent;
      return gained > 0
        ? { ok: true, message: `${BATTING_KEY_KO[key]} +${gained}`, player: p }
        : { ok: false, message: `훈련 포인트가 부족합니다. (필요: ${cost})`, player };
    }
    p.trainingPoints -= cost;
    p.batting[key] = cur + 1;
    spent += cost;
    gained += 1;
  }
  p.spentPoints += spent;
  return { ok: true, message: `${BATTING_KEY_KO[key]} +${gained} (${spent}P 사용)`, player: p };
}

/** 상한에 막혔을 때, 티어 때문인지 잠재력 때문인지 구분해 알려 준다. */
function capMessage(p: Player, cap: number): string {
  return p.potential <= cap
    ? `잠재력 한계(${p.potential})에 도달했습니다.`
    : `${TIER_KO[p.tier]} 능력치 상한(${cap})입니다. 티어를 강화하면 더 올릴 수 있습니다.`;
}

/** 투수 구종 능력치 훈련 */
export function trainPitch(
  player: Player,
  type: PitchType,
  key: keyof PitchAttr,
  points = 1,
): TrainResult {
  const p = structuredClone(player);
  if (!p.pitching?.arsenal[type]) {
    return { ok: false, message: '보유하지 않은 구종입니다.', player };
  }
  const cap = statCap(p);
  let spent = 0;
  let gained = 0;
  for (let i = 0; i < points; i++) {
    const attr = p.pitching.arsenal[type]!;
    const cur = attr[key];
    const cost = pitchUpgradeCost(cur, cap, type);
    if (!Number.isFinite(cost)) break;
    if (p.trainingPoints < cost) break;
    p.trainingPoints -= cost;
    attr[key] = cur + 1;
    spent += cost;
    gained += 1;
  }
  if (gained === 0) {
    const cur = p.pitching.arsenal[type]![key];
    return {
      ok: false,
      message: cur >= cap ? capMessage(p, cap) : '훈련 포인트가 부족합니다.',
      player,
    };
  }
  p.spentPoints += spent;
  return {
    ok: true,
    message: `${PITCH_DEFS[type].ko} ${PITCH_ATTR_KO[key]} +${gained} (${spent}P 사용)`,
    player: p,
  };
}

/** 스태미나 훈련 */
export function trainStamina(player: Player, points = 1): TrainResult {
  const p = structuredClone(player);
  if (!p.pitching) return { ok: false, message: '투수가 아닙니다.', player };
  const cap = statCap(p);
  let spent = 0;
  let gained = 0;
  for (let i = 0; i < points; i++) {
    const cost = statUpgradeCost(p.pitching.stamina, cap);
    if (!Number.isFinite(cost) || p.trainingPoints < cost) break;
    p.trainingPoints -= cost;
    p.pitching.stamina += 1;
    spent += cost;
    gained += 1;
  }
  if (gained === 0) {
    return {
      ok: false,
      message: p.pitching.stamina >= cap ? capMessage(p, cap) : '훈련 포인트가 부족합니다.',
      player,
    };
  }
  p.spentPoints += spent;
  return { ok: true, message: `스태미나 +${gained} (${spent}P 사용)`, player: p };
}

/**
 * 새 구종 습득.
 * 습득 직후 능력치는 낮게 시작하며, 이후 훈련으로 끌어올린다.
 */
export function learnPitch(player: Player, type: PitchType, seed: number): TrainResult {
  const p = structuredClone(player);
  if (!p.pitching) {
    return { ok: false, message: '투수가 아닙니다.', player };
  }
  if (p.pitching.arsenal[type]) {
    return { ok: false, message: '이미 보유한 구종입니다.', player };
  }
  if (!LEARNABLE_PITCHES.includes(type)) {
    return { ok: false, message: '습득할 수 없는 구종입니다.', player };
  }
  if (!canLearnMorePitches(p)) {
    return {
      ok: false,
      message: `${TIER_KO[p.tier]} 구종 슬롯을 모두 썼습니다 (${pitchSlots(p)}개). 티어를 강화하세요.`,
      player,
    };
  }
  const cost = learnPitchCost(type, p);
  if (p.trainingPoints < cost) {
    return { ok: false, message: `훈련 포인트가 부족합니다. (필요: ${cost}P)`, player };
  }

  const rng = new Rng(seed);
  const fastball = p.pitching.arsenal.FOURSEAM;
  // 직구 능력치를 기준으로 낮게 시작
  const baseline = fastball ? (fastball.velocity + fastball.control + fastball.movement) / 3 : 40;
  const start = clamp(baseline * 0.45, 15, 45);

  p.trainingPoints -= cost;
  p.spentPoints += cost;
  p.pitching.arsenal[type] = {
    velocity: Math.round(clamp(start + rng.range(-5, 8), 12, 60)),
    control: Math.round(clamp(start + rng.range(-8, 5), 10, 55)),
    movement: Math.round(clamp(start + rng.range(-3, 12), 15, 62)),
  };

  return { ok: true, message: `${PITCH_DEFS[type].ko} 습득! (${cost}P 사용)`, player: p };
}

/** 습득 가능한 구종 목록 (아직 없는 것) */
export function learnablePitchesFor(player: Player): PitchType[] {
  const owned = new Set(Object.keys(player.pitching?.arsenal ?? {}) as PitchType[]);
  return LEARNABLE_PITCHES.filter((t) => !owned.has(t));
}
