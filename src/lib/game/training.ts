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

/** 습득 굴림의 중심값. 그 투수의 직구가 좋을수록 새 구종도 조금 높게 시작한다. */
function newPitchBaseline(p: Player): number {
  const fastball = p.pitching?.arsenal.FOURSEAM;
  const avg = fastball ? (fastball.velocity + fastball.control + fastball.movement) / 3 : 40;
  return clamp(avg * 0.45, 15, 45);
}

/**
 * 막 익힌 구종의 시작 능력치. 그 투수의 직구를 기준으로 낮게 잡는다.
 *
 * 습득이든 교체든 같은 함수를 쓴다 — 교체가 조금이라도 후하면 "일단 싼 구종을 배운 뒤
 * 비싼 구종으로 갈아탄다"가 최적해가 되어 습득 비용 곡선이 통째로 무의미해진다.
 */
function rollNewPitch(p: Player, rng: Rng): PitchAttr {
  const start = newPitchBaseline(p);
  return {
    velocity: Math.round(clamp(start + rng.range(-5, 8), 12, 60)),
    control: Math.round(clamp(start + rng.range(-8, 5), 10, 55)),
    movement: Math.round(clamp(start + rng.range(-3, 12), 15, 62)),
  };
}

/**
 * 그 구종의 출발점 — 훈련으로 올린 분량만 환급하기 위한 기준선이다.
 *
 * 창단 때 받은 구종은 base.arsenal에, 골드로 익힌 구종은 base.learned에 출발점이 남는다.
 * 둘 다 없는 구 데이터는 습득 굴림의 **최댓값**으로 잡는다 — 모르는 쪽으로 후하게 주면
 * 훈련한 적 없는 구종을 버리는 것만으로 훈련 포인트가 생긴다.
 */
function pitchOrigin(p: Player, type: PitchType): PitchAttr {
  const generated = p.base.arsenal[type];
  if (generated) return generated;
  const learned = p.base.learned?.[type];
  if (learned) return learned;
  const start = newPitchBaseline(p);
  return {
    velocity: Math.round(clamp(start + 8, 12, 60)),
    control: Math.round(clamp(start + 5, 10, 55)),
    movement: Math.round(clamp(start + 12, 15, 62)),
  };
}

/**
 * 그 구종에 부은 훈련 포인트. 구종을 교체할 때 이만큼을 돌려준다.
 *
 * 출발점부터 지금 값까지 훈련 비용 곡선을 그대로 되짚어 더한다 — 비용이 현재 값만의
 * 함수라서(@see pitchUpgradeCost) 실제로 낸 값과 정확히 일치한다. **생성 시점에 이미
 * 갖고 있던 만큼은 빼고 센다.** 안 그러면 손대지 않은 구종을 버리는 것만으로 포인트가 나온다.
 */
export function pitchTrainingRefund(player: Player, type: PitchType): number {
  const attr = player.pitching?.arsenal[type];
  if (!attr) return 0;
  const origin = pitchOrigin(player, type);
  const cap = statCap(player);
  let sum = 0;
  for (const key of ['velocity', 'control', 'movement'] as (keyof PitchAttr)[]) {
    // 상한을 넘는 값은 훈련으로 만든 것이 아니다 (생성 시점에 이미 그랬다)
    for (let v = origin[key]; v < attr[key]; v++) {
      const cost = pitchUpgradeCost(v, cap, type);
      if (!Number.isFinite(cost)) break;
      sum += cost;
    }
  }
  return sum;
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

  // 훈련 포인트는 건드리지 않는다. 습득은 골드로만 한다.
  p.spentGold = (p.spentGold ?? 0) + cost;
  const fresh = rollNewPitch(p, new Rng(seed));
  p.pitching.arsenal[type] = fresh;
  // 나중에 이 구종을 교체할 때 "훈련으로 올린 분량"을 가려내려면 출발점이 필요하다
  p.base.learned = { ...p.base.learned, [type]: { ...fresh } };

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

/**
 * 이미 가진 구종을 버리고 그 자리에 다른 구종을 익힌다. 비용은 습득과 똑같다.
 *
 * 슬롯을 늘리지 않으므로 슬롯이 가득 찬 투수도 쓸 수 있다 — 이 기능이 있는 이유가
 * 그것이다. 버리는 구종에 부은 훈련 포인트는 전액 돌려준다
 * (@see pitchTrainingRefund). 새 구종은 습득과 똑같이 낮게 시작하므로, 돌려받은
 * 포인트를 그대로 부으면 버린 구종과 같은 수준까지 되돌릴 수 있다.
 */
export function replacePitch(
  team: Team,
  playerId: string,
  from: PitchType,
  to: PitchType,
  seed: number,
): LearnPitchResult {
  const target = team.players.find((x) => x.id === playerId);
  if (!target) return { ok: false, team, message: '선수를 찾을 수 없습니다.' };

  const p = structuredClone(target);
  if (!p.pitching) {
    return { ok: false, team, message: '투수가 아닙니다.' };
  }
  if (from === to) {
    return { ok: false, team, message: '같은 구종으로는 바꿀 수 없습니다.' };
  }
  if (!p.pitching.arsenal[from]) {
    return { ok: false, team, message: '보유하지 않은 구종입니다.' };
  }
  // 직구는 모든 투수의 기본 구종이다. 없는 구종을 던지려 할 때 엔진이 대신 쓰는 것도 직구다.
  if (PITCH_DEFS[from].innate) {
    return { ok: false, team, message: `${PITCH_DEFS[from].ko}는 바꿀 수 없습니다.` };
  }
  if (!LEARNABLE_PITCHES.includes(to)) {
    return { ok: false, team, message: '습득할 수 없는 구종입니다.' };
  }
  if (p.pitching.arsenal[to]) {
    return { ok: false, team, message: '이미 보유한 구종입니다.' };
  }

  const cost = learnPitchGold(to, p);
  if (team.gold < cost) {
    return { ok: false, team, message: `골드가 부족합니다. (필요: ${cost.toLocaleString()}G)` };
  }

  const refund = pitchTrainingRefund(p, from);
  const fresh = rollNewPitch(p, new Rng(seed));

  // 지운 자리에 그대로 끼워 넣는다. delete 후 추가하면 새 구종이 맨 뒤로 밀려
  // 투구 패널의 구종 버튼 순서와 overflowPitches가 함께 흔들린다.
  const arsenal: Partial<Record<PitchType, PitchAttr>> = {};
  for (const key of Object.keys(p.pitching.arsenal) as PitchType[]) {
    if (key === from) arsenal[to] = fresh;
    else arsenal[key] = p.pitching.arsenal[key];
  }
  p.pitching.arsenal = arsenal;
  p.spentGold = (p.spentGold ?? 0) + cost;

  // 버린 구종의 출발점은 이제 의미가 없고, 새 구종의 출발점이 그 자리를 대신한다
  const learned = { ...p.base.learned, [to]: { ...fresh } };
  delete learned[from];
  p.base.learned = learned;

  // 돌려준 만큼 spentPoints에서 뺀다. 안 그러면 능력치초기화권이 같은 포인트를 또 준다.
  p.trainingPoints += refund;
  p.spentPoints = Math.max(0, p.spentPoints - refund);

  const back = refund > 0 ? ` · 훈련 P ${refund.toLocaleString()} 환급` : '';
  return {
    ok: true,
    team: {
      ...team,
      gold: team.gold - cost,
      players: team.players.map((x) => (x.id === playerId ? p : x)),
    },
    message: `${PITCH_DEFS[from].ko} → ${PITCH_DEFS[to].ko} 변경! (${cost.toLocaleString()}G 사용${back})`,
  };
}

/** 습득 가능한 구종 목록 (아직 없는 것) */
export function learnablePitchesFor(player: Player): PitchType[] {
  const owned = new Set(Object.keys(player.pitching?.arsenal ?? {}) as PitchType[]);
  return LEARNABLE_PITCHES.filter((t) => !owned.has(t));
}

/** 다른 구종으로 바꿀 수 있는 보유 구종 (직구 제외) */
export function replaceablePitchesOf(player: Player): PitchType[] {
  const owned = Object.keys(player.pitching?.arsenal ?? {}) as PitchType[];
  return owned.filter((t) => !PITCH_DEFS[t].innate);
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
