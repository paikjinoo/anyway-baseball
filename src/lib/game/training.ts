import { Rng, clamp } from './rng';
import { ALL_PITCH_TYPES, LEARNABLE_PITCHES, PITCH_DEFS } from './constants';
import { TIER_KO, canLearnMorePitches, pitchSlots, pitchSlotsUsed, statCap } from './progression';
import type { BattingAttr, PitchAttr, PitchType, Player, Team } from './types';

/**
 * 훈련 시스템.
 *
 * 능력치 상한은 **티어 상한과 선수 고유 잠재력 중 낮은 쪽**(progression.statCap)이며,
 * 현재 값이 높을수록 1포인트를 올리는 비용이 급격히 증가한다. 덕분에 한 선수에게 몰빵해도
 * 만능이 되지 않고, 상한에 막히면 티어를 올려야 다시 자란다.
 *
 * 훈련 포인트는 이제 경기 보상이 아니라 **레벨업으로만** 들어온다 (progression.grantExp).
 * 그리고 훈련 포인트는 **능력치 전용**이다 — 새 구종 습득은 골드로 산다 (learnPitch).
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

/**
 * 새 구종 습득 비용의 기준값. 실제 비용은 난이도와 보유 구종 수로 배율이 붙는다.
 * 4번째 구종이 2,550~6,630G, 6번째가 3,600~9,360G 선이다.
 */
export const LEARN_PITCH_GOLD_BASE = 1500;

/**
 * 새 구종 습득 비용 — **훈련 포인트가 아니라 골드다.**
 *
 * 훈련 포인트는 레벨업으로만 들어오는 희소 자원이라, 구종 습득까지 거기서 빼면
 * "능력치를 올릴지 구종을 배울지"가 아니라 "구종은 못 배운다"가 된다. 골드로 옮기면
 * 경기를 뛰어 모은 돈으로 아스널을 넓힐 수 있고, 훈련 포인트는 능력치 전용이 된다.
 */
export function learnPitchGold(type: PitchType, pitcher: Player): number {
  const owned = pitchSlotsUsed(pitcher);
  const base = LEARN_PITCH_GOLD_BASE * PITCH_DEFS[type].difficulty;
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

export interface LearnPitchResult {
  ok: boolean;
  team: Team;
  message: string;
}

/**
 * 새 구종 습득. 비용은 팀 골드에서 나간다.
 * 습득 직후 능력치는 낮게 시작하며, 이후 훈련 포인트로 끌어올린다.
 *
 * 다른 훈련 함수와 달리 Team을 받고 돌려주는 이유는 골드가 팀에 있기 때문이다.
 */
export function learnPitch(
  team: Team,
  playerId: string,
  type: PitchType,
  seed: number,
): LearnPitchResult {
  const target = team.players.find((x) => x.id === playerId);
  if (!target) return { ok: false, team, message: '선수를 찾을 수 없습니다.' };

  const p = structuredClone(target);
  if (!p.pitching) {
    return { ok: false, team, message: '투수가 아닙니다.' };
  }
  if (p.pitching.arsenal[type]) {
    return { ok: false, team, message: '이미 보유한 구종입니다.' };
  }
  if (!LEARNABLE_PITCHES.includes(type)) {
    return { ok: false, team, message: '습득할 수 없는 구종입니다.' };
  }
  if (!canLearnMorePitches(p)) {
    return {
      ok: false,
      team,
      message: `${TIER_KO[p.tier]} 구종 슬롯을 모두 썼습니다 (${pitchSlots(p)}개). 티어를 강화하세요.`,
    };
  }
  const cost = learnPitchGold(type, p);
  if (team.gold < cost) {
    return { ok: false, team, message: `골드가 부족합니다. (필요: ${cost.toLocaleString()}G)` };
  }

  const rng = new Rng(seed);
  const fastball = p.pitching.arsenal.FOURSEAM;
  // 직구 능력치를 기준으로 낮게 시작
  const baseline = fastball ? (fastball.velocity + fastball.control + fastball.movement) / 3 : 40;
  const start = clamp(baseline * 0.45, 15, 45);

  // 훈련 포인트는 건드리지 않는다. 습득은 골드로만 한다.
  p.spentGold = (p.spentGold ?? 0) + cost;
  p.pitching.arsenal[type] = {
    velocity: Math.round(clamp(start + rng.range(-5, 8), 12, 60)),
    control: Math.round(clamp(start + rng.range(-8, 5), 10, 55)),
    movement: Math.round(clamp(start + rng.range(-3, 12), 15, 62)),
  };

  return {
    ok: true,
    team: {
      ...team,
      gold: team.gold - cost,
      players: team.players.map((x) => (x.id === playerId ? p : x)),
    },
    message: `${PITCH_DEFS[type].ko} 습득! (${cost.toLocaleString()}G 사용)`,
  };
}

/** 습득 가능한 구종 목록 (아직 없는 것) */
export function learnablePitchesFor(player: Player): PitchType[] {
  const owned = new Set(Object.keys(player.pitching?.arsenal ?? {}) as PitchType[]);
  return LEARNABLE_PITCHES.filter((t) => !owned.has(t));
}

// ---------------------------------------------------------------------------
// 자동 훈련
// ---------------------------------------------------------------------------

/** 자동 투자가 손댈 수 있는 항목 하나 */
type InvestSlot =
  | { kind: 'BATTING'; key: TrainableBattingKey }
  | { kind: 'STAMINA' }
  | { kind: 'PITCH'; type: PitchType; attr: keyof PitchAttr };

/**
 * 이 선수에게 훈련 포인트를 부을 항목 목록.
 *
 * 투수의 타격 능력치는 넣지 않는다 — 실제로 아무도 거기 훈련하지 않으므로,
 * 자동 투자가 거기 쓰면 "직접 키운 선수와 같은 수준"이 아니라 그냥 손해다.
 *
 * 구종 순회는 arsenal의 키 순서가 아니라 ALL_PITCH_TYPES 순서로 한다.
 * 삽입 순서에 기대는 순간 같은 시드가 다른 결과를 내기 시작한다.
 */
function investSlotsOf(p: Player): InvestSlot[] {
  if (p.kind === 'BATTER') {
    return BATTING_KEYS.map((key) => ({ kind: 'BATTING', key }) as InvestSlot);
  }
  const slots: InvestSlot[] = [{ kind: 'STAMINA' }];
  for (const type of ALL_PITCH_TYPES) {
    if (!p.pitching?.arsenal[type]) continue;
    for (const attr of ['velocity', 'control', 'movement'] as (keyof PitchAttr)[]) {
      slots.push({ kind: 'PITCH', type, attr });
    }
  }
  return slots;
}

function readSlot(p: Player, s: InvestSlot): number {
  if (s.kind === 'BATTING') return p.batting[s.key];
  if (s.kind === 'STAMINA') return p.pitching?.stamina ?? 0;
  return p.pitching?.arsenal[s.type]?.[s.attr] ?? 0;
}

function writeSlot(p: Player, s: InvestSlot, v: number): void {
  if (s.kind === 'BATTING') {
    p.batting[s.key] = v;
  } else if (s.kind === 'STAMINA') {
    if (p.pitching) p.pitching.stamina = v;
  } else {
    const a = p.pitching?.arsenal[s.type];
    if (a) a[s.attr] = v;
  }
}

/** 그 항목을 현재 값에서 1 올리는 비용. 구종은 난이도 배율이 붙는다. */
function slotStepCost(p: Player, s: InvestSlot, cap: number): number {
  const cur = readSlot(p, s);
  return s.kind === 'PITCH'
    ? pitchUpgradeCost(cur, cap, s.type)
    : statUpgradeCost(cur, cap);
}

export interface AutoInvestResult {
  player: Player;
  /** 실제로 쓴 훈련 포인트 */
  spent: number;
}

/**
 * 훈련 포인트 예산을 능력치에 자동으로 배분한다.
 *
 * 상점에서 상위 티어 선수를 만들 때 "그 티어까지 직접 키웠다면 받았을 포인트"를 대신 써 주는
 * 용도다. 그래서 비용은 반드시 실제 훈련과 같은 곡선(statUpgradeCost / pitchUpgradeCost)을 쓴다.
 *
 * **모든 항목을 같은 폭으로 올린 뒤 남은 예산으로 약점을 다듬는다.** 싼 항목부터 채우면
 * 물채우기가 되어 중견수의 발도 1루수의 파워도 지워지고 똑같은 숫자만 남는다. 균등 상승은
 * 원래의 강약 순서를 지키면서 총량만 끌어올린다.
 *
 * trainingPoints / spentPoints는 건드리지 않고 쓴 양만 돌려준다 — 그 포인트가 어디서 왔는지에
 * 따라 회계가 달라지므로 호출부가 정할 일이다.
 */
export function autoInvest(player: Player, budget: number): AutoInvestResult {
  const p = structuredClone(player);
  if (budget <= 0) return { player: p, spent: 0 };

  const cap = statCap(p);
  const slots = investSlotsOf(p);
  if (!slots.length) return { player: p, spent: 0 };

  let spent = 0;

  // 1) 전 항목을 한 칸씩 올리는 것을 더 이상 감당할 수 없을 때까지 반복
  for (;;) {
    let round = 0;
    for (const s of slots) {
      const c = slotStepCost(p, s, cap);
      if (Number.isFinite(c)) round += c;
    }
    if (round === 0 || spent + round > budget) break;
    for (const s of slots) {
      const c = slotStepCost(p, s, cap);
      if (!Number.isFinite(c)) continue;
      writeSlot(p, s, readSlot(p, s) + 1);
      spent += c;
    }
  }

  // 2) 자투리로 가장 싼 항목을 하나씩. 동점이면 앞선 항목이 이겨 결과가 결정적이다.
  for (;;) {
    let best: InvestSlot | null = null;
    let bestCost = Infinity;
    for (const s of slots) {
      const c = slotStepCost(p, s, cap);
      if (c < bestCost) {
        bestCost = c;
        best = s;
      }
    }
    if (!best || !Number.isFinite(bestCost) || spent + bestCost > budget) break;
    writeSlot(p, best, readSlot(p, best) + 1);
    spent += bestCost;
  }

  return { player: p, spent };
}
