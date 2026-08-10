import { Rng, clamp } from './rng';
import { LEARNABLE_PITCHES, PITCH_DEFS } from './constants';
import { TIER_PITCH_SLOTS } from './progression';
import { TEAM_SCHEMA_VERSION } from './types';
import type {
  BatSide,
  BattingAttr,
  BattingStance,
  BodyType,
  Gear,
  Handedness,
  PitchAttr,
  PitchType,
  PitcherRole,
  PitchingAttr,
  PitchingForm,
  Player,
  Position,
  SeasonStat,
  Team,
  UniformType,
} from './types';

// ---------------------------------------------------------------------------
// 이름 생성
// ---------------------------------------------------------------------------

const SURNAMES = [
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
  '한', '오', '서', '신', '권', '황', '안', '송', '류', '전',
  '홍', '고', '문', '양', '손', '배', '백', '허', '유', '남',
];

const GIVEN_1 = [
  '민', '지', '현', '준', '서', '예', '도', '하', '주', '태',
  '성', '진', '동', '재', '승', '건', '우', '규', '찬', '용',
  '상', '기', '병', '정', '경', '수', '창', '광', '영', '호',
];

const GIVEN_2 = [
  '준', '호', '우', '수', '민', '진', '석', '현', '훈', '철',
  '환', '식', '범', '혁', '길', '완', '기', '용', '섭', '빈',
];

export function randomKoreanName(rng: Rng): string {
  return `${rng.pick(SURNAMES)}${rng.pick(GIVEN_1)}${rng.pick(GIVEN_2)}`;
}

const TEAM_NOUNS = [
  '드래곤즈', '타이거즈', '베어스', '이글스', '자이언츠', '위즈', '히어로즈',
  '라이온즈', '트윈스', '랜더스', '팰컨스', '샤크스', '코메츠', '레이븐스',
  '스톰', '파이럿츠', '블레이즈', '썬더스', '나이츠', '유니콘스',
];
const TEAM_CITIES = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '수원', '창원', '전주',
  '청주', '포항', '제주', '강릉', '여수', '춘천',
];

export function randomTeamName(rng: Rng): string {
  return `${rng.pick(TEAM_CITIES)} ${rng.pick(TEAM_NOUNS)}`;
}

export function abbrFromName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const src = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  return src.slice(0, 3);
}

// ---------------------------------------------------------------------------
// 밸런스 규칙
//
//   선수 1명의 총 능력치 합(budget)은 좁은 정규분포에서 뽑는다.
//   -> 특정 선수가 압도적으로 강하거나 쓸모없어지는 일이 없다.
//   포지션별 가중치로 배분한 뒤, 랜덤 노이즈를 얹고 다시 정규화해서
//   합계를 budget에 정확히 맞춘다.
// ---------------------------------------------------------------------------

/** 야수 6개 능력치 합계의 평균/표준편차 */
const HITTER_BUDGET_MEAN = 300; // 평균 50 * 6
const HITTER_BUDGET_SD = 26;
const HITTER_BUDGET_MIN = 246;
const HITTER_BUDGET_MAX = 366;

/** 투수 구종 능력치 총합(구종 수 무관 정규화 대상) */
const PITCHER_BUDGET_MEAN = 168; // 평균 56 * 3 (직구 기준)
const PITCHER_BUDGET_SD = 16;

type HitterWeights = Record<keyof BattingAttr, number>;

const POSITION_WEIGHTS: Record<Position, HitterWeights> = {
  //           contact power eye  speed field arm
  P:   { contact: 0.5, power: 0.4, eye: 0.5, speed: 0.7, fielding: 1.0, arm: 1.3 },
  C:   { contact: 1.0, power: 1.05, eye: 1.0, speed: 0.6, fielding: 1.25, arm: 1.35 },
  '1B': { contact: 1.05, power: 1.35, eye: 1.05, speed: 0.7, fielding: 0.85, arm: 0.8 },
  '2B': { contact: 1.15, power: 0.8, eye: 1.05, speed: 1.2, fielding: 1.2, arm: 1.0 },
  '3B': { contact: 1.0, power: 1.2, eye: 1.0, speed: 0.85, fielding: 1.1, arm: 1.25 },
  SS:  { contact: 1.05, power: 0.85, eye: 1.0, speed: 1.2, fielding: 1.3, arm: 1.25 },
  LF:  { contact: 1.1, power: 1.15, eye: 1.05, speed: 1.05, fielding: 0.95, arm: 0.9 },
  CF:  { contact: 1.1, power: 0.95, eye: 1.05, speed: 1.35, fielding: 1.15, arm: 1.0 },
  RF:  { contact: 1.05, power: 1.25, eye: 1.05, speed: 1.0, fielding: 0.95, arm: 1.25 },
  DH:  { contact: 1.2, power: 1.4, eye: 1.15, speed: 0.7, fielding: 0.6, arm: 0.6 },
};

const BATTING_KEYS: (keyof BattingAttr)[] = ['contact', 'power', 'eye', 'speed', 'fielding', 'arm'];

export function emptySeason(): SeasonStat {
  return {
    g: 0, pa: 0, ab: 0, h: 0, double: 0, triple: 0, hr: 0, rbi: 0, r: 0,
    bb: 0, hbp: 0, so: 0, sb: 0, cs: 0, ip3: 0, er: 0, pk: 0, pbb: 0, ph: 0, np: 0, w: 0, l: 0,
  };
}

/**
 * 가중치 + 노이즈로 능력치를 배분하고 합계를 budget에 정확히 맞춘다.
 * 개별 값은 [20, 95] 범위로 자르며, 자르고 남은 잔여분은 여유 있는 항목에 재분배한다.
 */
function distribute(
  rng: Rng,
  keys: string[],
  weights: number[],
  budget: number,
  lo: number,
  hi: number,
): number[] {
  // 1) 가중치에 노이즈를 곱해 배분 비율 결정
  const raw = weights.map((w) => Math.max(0.15, w * rng.range(0.62, 1.42)));
  const sum = raw.reduce((a, b) => a + b, 0);
  let vals = raw.map((r) => (r / sum) * budget);

  // 2) 상하한 clamp 후 잔여분 재분배 (최대 8회 반복)
  for (let iter = 0; iter < 8; iter++) {
    let overflow = 0;
    const flexible: number[] = [];
    vals = vals.map((v, i) => {
      if (v > hi) {
        overflow += v - hi;
        return hi;
      }
      if (v < lo) {
        overflow -= lo - v;
        return lo;
      }
      flexible.push(i);
      return v;
    });
    if (Math.abs(overflow) < 0.5 || flexible.length === 0) break;
    const share = overflow / flexible.length;
    for (const i of flexible) vals[i] += share;
  }

  return vals.map((v) => Math.round(clamp(v, lo, hi)));
}

function makeGear(rng: Rng, pos: Position, teamColor: string, accent: string): Gear {
  const glove =
    pos === 'P' ? 'PITCHER' : pos === 'C' ? 'CATCHER' : pos === '1B' ? 'FIRSTBASE'
      : ['LF', 'CF', 'RF'].includes(pos) ? 'OUTFIELD' : 'INFIELD';
  const gloveColors = ['#7c2d12', '#1c1917', '#78350f', '#0f172a', '#7f1d1d', accent];
  const batColors = ['#a16207', '#1c1917', '#7c2d12', '#f5f5f4', teamColor];
  return {
    bat: rng.pick(['CLASSIC', 'FLARE', 'TAPERED', 'AXE', 'THICK'] as const),
    batColor: rng.pick(batColors),
    glove,
    gloveColor: rng.pick(gloveColors),
    accessory: rng.pick(['NONE', 'NONE', 'WRISTBAND', 'ARM_SLEEVE', 'NECKLACE', 'EYE_BLACK'] as const),
  };
}

/**
 * 투수 아스널 생성. 직구는 반드시 포함한다.
 *
 * 신규 선수는 전원 C등급이고 C등급 구종 슬롯은 3개이므로, 직구를 뺀 변화구는 최대 2개다.
 * 선발이 상한을 채우고 불펜은 하나 적게 시작한다.
 */
function makeArsenal(rng: Rng, budget: number, isStarter: boolean): PitchingAttr {
  const arsenal: Partial<Record<PitchType, PitchAttr>> = {};

  // 직구 능력치
  const fourseam = distribute(rng, ['v', 'c', 'm'], [1.15, 1.0, 0.85], budget, 25, 95);
  arsenal.FOURSEAM = { velocity: fourseam[0], control: fourseam[1], movement: fourseam[2] };

  // 직구를 뺀 나머지 슬롯. C등급 상한(3개)을 절대 넘지 않는다.
  const breakingSlots = TIER_PITCH_SLOTS.C - 1;
  const count = Math.min(breakingSlots, isStarter ? breakingSlots : rng.int(1, breakingSlots));
  const pool = rng.shuffle(LEARNABLE_PITCHES.slice());
  for (let i = 0; i < count; i++) {
    const t = pool[i];
    if (!t) break;
    const def = PITCH_DEFS[t];
    // 난이도가 높은 구종일수록 초기 숙련도가 낮다
    const b = budget * clamp(rng.range(0.72, 0.98) - (def.difficulty - 1) * 0.06, 0.42, 1.0);
    const v = distribute(rng, ['v', 'c', 'm'], [0.9, 1.0, 1.15], b, 20, 92);
    arsenal[t] = { velocity: v[0], control: v[1], movement: v[2] };
  }

  return {
    stamina: Math.round(isStarter ? rng.normal(72, 10, 2) : rng.normal(46, 9, 2)),
    arsenal,
  };
}

export interface GeneratePlayerOptions {
  position: Position;
  number: number;
  /** 투수 역할. position === 'P'일 때만 의미 있다. 기본값은 중간계투. */
  role?: PitcherRole;
  teamColor?: string;
  accentColor?: string;
  name?: string;
  /** 팀 전체 전력 보정. 1.0이 기본. */
  strength?: number;
}

/** 체형 추첨. 기본형이 절반이고 슬림/거구가 나머지를 반씩 나눈다. */
function rollBody(rng: Rng): BodyType {
  const r = rng.next();
  if (r < 0.5) return 'NORMAL';
  return r < 0.75 ? 'SLIM' : 'BIG';
}

export function generatePlayer(rng: Rng, opt: GeneratePlayerOptions): Player {
  const pos = opt.position;
  const strength = opt.strength ?? 1.0;
  const isPitcher = pos === 'P';
  const role: PitcherRole | undefined = isPitcher ? (opt.role ?? 'RP') : undefined;
  const isStarter = role === 'SP';

  const budget = clamp(
    rng.normal(HITTER_BUDGET_MEAN, HITTER_BUDGET_SD) * strength,
    HITTER_BUDGET_MIN,
    HITTER_BUDGET_MAX,
  );

  const w = POSITION_WEIGHTS[pos];
  const weights = BATTING_KEYS.map((k) => w[k]);
  // 투수는 타격 예산 자체를 크게 깎는다.
  const hitterBudget = isPitcher ? budget * 0.52 : budget;
  const vals = distribute(rng, BATTING_KEYS as string[], weights, hitterBudget, 15, 95);

  const batting = BATTING_KEYS.reduce((acc, k, i) => {
    acc[k] = vals[i];
    return acc;
  }, {} as BattingAttr);

  const player: Player = {
    id: `p_${rng.int(0, 0xffffff).toString(36)}${rng.int(0, 0xffffff).toString(36)}`,
    name: opt.name ?? randomKoreanName(rng),
    number: opt.number,
    kind: isPitcher ? 'PITCHER' : 'BATTER',
    position: pos,
    role,
    body: isPitcher ? 'NORMAL' : rollBody(rng),
    bats: rng.chance(0.06) ? 'S' : (rng.chance(0.32) ? 'L' : 'R') as BatSide,
    throws: (isPitcher ? (rng.chance(0.27) ? 'L' : 'R') : rng.chance(0.1) ? 'L' : 'R') as Handedness,
    stance: rng.int(0, 5) as BattingStance,
    form: (isPitcher ? rng.int(0, 4) : rng.int(0, 1)) as PitchingForm,
    gear: makeGear(rng, pos, opt.teamColor ?? '#2563eb', opt.accentColor ?? '#f59e0b'),
    batting,
    // 기본 지급 선수는 전원 C등급 1레벨에서 시작한다.
    tier: 'C',
    level: 1,
    exp: 0,
    potential: Math.round(clamp(rng.normal(82, 7, 2), 62, 99)),
    // 훈련 포인트는 레벨업으로만 들어온다. 창단 직후엔 비어 있다.
    trainingPoints: 0,
    spentPoints: 0,
    base: { batting, stamina: 0, arsenal: {} },
    fatigue: 0,
    season: emptySeason(),
  };

  if (isPitcher) {
    const pbudget = clamp(rng.normal(PITCHER_BUDGET_MEAN, PITCHER_BUDGET_SD) * strength, 120, 240);
    player.pitching = makeArsenal(rng, pbudget, isStarter);
  } else {
    // 야수도 비상시 등판할 수 있도록 아주 낮은 직구 하나만 부여
    player.pitching = {
      stamina: 22,
      arsenal: {
        FOURSEAM: {
          velocity: Math.round(clamp(batting.arm * 0.72, 15, 60)),
          control: Math.round(clamp(batting.arm * 0.45, 10, 45)),
          movement: 15,
        },
      },
    };
  }

  // 능력치초기화권이 되돌릴 지점. 훈련으로 바뀔 값만 복사해 둔다.
  player.base = {
    batting: { ...batting },
    stamina: player.pitching.stamina,
    arsenal: structuredClone(player.pitching.arsenal),
  };

  return player;
}

// ---------------------------------------------------------------------------
// 팀 로스터 생성
// ---------------------------------------------------------------------------

/**
 * 로스터 구성: 투수 10 (선발 4 · 중간계투 5 · 마무리 1) + 타자 13 = 23명.
 *
 * 선발은 항상 정확히 4명이다(ROTATION_SIZE). 불펜에서 선발로 올리려면 기존 선발 하나를
 * 내려야 하며, 그 검증은 roster.ts가 한다.
 */
const ROSTER_PLAN: { position: Position; role?: PitcherRole }[] = [
  { position: 'P', role: 'SP' },
  { position: 'P', role: 'SP' },
  { position: 'P', role: 'SP' },
  { position: 'P', role: 'SP' },
  { position: 'P', role: 'RP' },
  { position: 'P', role: 'RP' },
  { position: 'P', role: 'RP' },
  { position: 'P', role: 'RP' },
  { position: 'P', role: 'RP' },
  { position: 'P', role: 'CP' },
  { position: 'C' },
  { position: 'C' },
  { position: '1B' },
  { position: '2B' },
  { position: '3B' },
  { position: 'SS' },
  { position: 'SS' },
  { position: 'LF' },
  { position: 'CF' },
  { position: 'CF' },
  { position: 'RF' },
  { position: 'DH' },
  { position: '1B' },
];

/** 선발 로테이션에 반드시 등록해야 하는 인원 */
export const ROTATION_SIZE = 4;

export const TEAM_COLOR_PRESETS: { primary: string; secondary: string; accent: string }[] = [
  { primary: '#1d4ed8', secondary: '#f8fafc', accent: '#fbbf24' },
  { primary: '#b91c1c', secondary: '#111827', accent: '#f8fafc' },
  { primary: '#047857', secondary: '#fef3c7', accent: '#111827' },
  { primary: '#6d28d9', secondary: '#f5f3ff', accent: '#facc15' },
  { primary: '#ea580c', secondary: '#1c1917', accent: '#f8fafc' },
  { primary: '#0e7490', secondary: '#ecfeff', accent: '#f97316' },
  { primary: '#be123c', secondary: '#fff1f2', accent: '#fde047' },
  { primary: '#111827', secondary: '#f59e0b', accent: '#f8fafc' },
  { primary: '#15803d', secondary: '#f0fdf4', accent: '#1e3a8a' },
  { primary: '#7c2d12', secondary: '#fef2f2', accent: '#facc15' },
];

export const LOGO_IDS = [
  'star', 'flame', 'bolt', 'crown', 'shield', 'anchor', 'diamond',
  'claw', 'wing', 'gear', 'wave', 'peak',
];

export interface GenerateTeamOptions {
  ownerUid: string;
  name?: string;
  abbr?: string;
  logoId?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  uniformType?: UniformType;
  /** 전력 배율. CPU 난이도 조절에 사용. */
  strength?: number;
  id?: string;
}

export function generateTeam(rng: Rng, opt: GenerateTeamOptions): Team {
  const preset = rng.pick(TEAM_COLOR_PRESETS);
  const name = opt.name ?? randomTeamName(rng);
  const primaryColor = opt.primaryColor ?? preset.primary;
  const secondaryColor = opt.secondaryColor ?? preset.secondary;
  const accentColor = opt.accentColor ?? preset.accent;

  const numbers = rng.shuffle(Array.from({ length: 70 }, (_, i) => i + 1));
  const players = ROSTER_PLAN.map((slot, i) =>
    generatePlayer(rng, {
      position: slot.position,
      role: slot.role,
      number: numbers[i],
      teamColor: primaryColor,
      accentColor,
      strength: opt.strength,
    }),
  );

  const now = Date.now();
  const team: Team = {
    id: opt.id ?? `t_${rng.int(0, 0xffffffff).toString(36)}`,
    schemaVersion: TEAM_SCHEMA_VERSION,
    ownerUid: opt.ownerUid,
    name,
    abbr: opt.abbr ?? abbrFromName(name),
    logoId: opt.logoId ?? rng.pick(LOGO_IDS),
    primaryColor,
    secondaryColor,
    accentColor,
    uniformType: opt.uniformType ?? rng.pick(['CLASSIC', 'PINSTRIPE', 'RAGLAN', 'VEST', 'GRADIENT', 'SASH'] as const),
    players,
    lineup: [],
    rotation: [],
    rotationIndex: 0,
    gold: 0,
    inventory: {},
    createdAt: now,
    updatedAt: now,
  };

  team.lineup = autoLineup(team);
  team.rotation = autoRotation(team);
  return team;
}

/**
 * 선발(SP)들을 실력 순으로 로테이션에 배치한다.
 * 부상자는 빼되, 로테이션 자체는 SP 전원을 담는다 (SP는 정확히 ROTATION_SIZE명이다).
 */
export function autoRotation(team: Team): string[] {
  return team.players
    .filter((p) => p.kind === 'PITCHER' && p.role === 'SP')
    .sort((a, b) => pitcherScore(b) - pitcherScore(a))
    .slice(0, ROTATION_SIZE)
    .map((p) => p.id);
}

/**
 * 자동 타순 편성.
 * 포지션별로 가장 좋은 선수를 1명씩 뽑아 수비 라인업을 만든 뒤
 * 세이버메트릭스식 정렬(출루형 -> 중심타선 -> 하위)로 타순을 정한다.
 */
export function autoLineup(team: Team, useDH = true): string[] {
  const available = team.players.filter((p) => p.kind === 'BATTER' && !p.injury);
  const byPos = (pos: Position) =>
    available.filter((p) => p.position === pos).sort((a, b) => hitterScore(b) - hitterScore(a));

  const chosen: Player[] = [];
  const taken = new Set<string>();

  const need: Position[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
  for (const pos of need) {
    const c = byPos(pos).find((p) => !taken.has(p.id));
    if (c) {
      chosen.push(c);
      taken.add(c.id);
    }
  }

  // 9번째 타자: DH 사용 시 최고 타자, 아니면 로테이션 선두 투수
  if (useDH) {
    const dh = available
      .filter((p) => !taken.has(p.id))
      .sort((a, b) => hitterScore(b) - hitterScore(a))[0];
    if (dh) {
      chosen.push(dh);
      taken.add(dh.id);
    }
  } else {
    const starterId = team.rotation[team.rotationIndex % Math.max(1, team.rotation.length)];
    const p = team.players.find((x) => x.id === starterId)
      ?? team.players.find((x) => x.kind === 'PITCHER');
    if (p) chosen.push(p);
  }

  // 자리가 빈다면 남은 야수로 채운다
  while (chosen.length < 9) {
    const f = available.find((p) => !taken.has(p.id));
    if (!f) break;
    chosen.push(f);
    taken.add(f.id);
  }

  const sorted = chosen.slice().sort((a, b) => hitterScore(b) - hitterScore(a));
  // 1번 발 빠르고 눈 좋은 선수, 3~4번 장타자, 2번 정확도
  const leadoff = sorted
    .slice()
    .sort((a, b) => b.batting.speed + b.batting.eye - (a.batting.speed + a.batting.eye))[0];
  const rest = sorted.filter((p) => p.id !== leadoff.id);
  const sluggers = rest.slice().sort((a, b) => b.batting.power - a.batting.power).slice(0, 2);
  const contactMan = rest
    .filter((p) => !sluggers.includes(p))
    .sort((a, b) => b.batting.contact - a.batting.contact)[0];
  const tail = rest.filter((p) => !sluggers.includes(p) && p.id !== contactMan?.id);

  const order = [leadoff, contactMan, sluggers[0], sluggers[1], ...tail].filter(Boolean) as Player[];
  return order.slice(0, 9).map((p) => p.id);
}

export function hitterScore(p: Player): number {
  const b = p.batting;
  return b.contact * 1.3 + b.power * 1.2 + b.eye * 1.0 + b.speed * 0.6 + b.fielding * 0.5 + b.arm * 0.3;
}

export function pitcherScore(p: Player): number {
  if (!p.pitching) return 0;
  const arr = Object.values(p.pitching.arsenal) as PitchAttr[];
  if (!arr.length) return 0;
  const best = arr.reduce(
    (acc, a) => acc + a.velocity * 1.1 + a.control * 1.3 + a.movement * 1.1,
    0,
  );
  return best / arr.length + arr.length * 12 + p.pitching.stamina * 0.4;
}

/** 팀 전체 전력 지표 (0~100). 매치메이킹/CPU 난이도 표시에 쓴다. */
export function teamRating(team: Team): number {
  const hitters = team.players.filter((p) => p.kind === 'BATTER');
  const pitchers = team.players.filter((p) => p.kind === 'PITCHER');
  const h = hitters.reduce((a, p) => a + hitterScore(p), 0) / Math.max(1, hitters.length);
  const pi = pitchers.reduce((a, p) => a + pitcherScore(p), 0) / Math.max(1, pitchers.length);
  return Math.round(clamp((h / 4.9) * 0.55 + (pi / 2.9) * 0.45, 0, 100));
}
