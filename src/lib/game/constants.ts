import type {
  AccessoryType,
  BatType,
  BodyType,
  GloveType,
  PitchType,
  Position,
  UniformType,
  Vec3,
} from './types';

// ---------------------------------------------------------------------------
// 필드 규격 (미터). 홈플레이트가 원점, +Z가 중견수 방향, +X가 3루(좌익) 방향.
//
// +X를 3루로 두는 이유: three.js는 오른손 좌표계라 홈 뒤에서 +Z(중견수)를
// 바라보는 카메라의 화면 오른쪽은 월드 -X가 된다. 1루를 +X로 두면 화면이
// 통째로 좌우 반전되어 타자가 1루로 뛰는데 화면상 3루 쪽으로 달리게 된다.
// ---------------------------------------------------------------------------

export const BASE_DISTANCE = 27.432; // 90 ft
export const MOUND_DISTANCE = 18.44; // 60 ft 6 in
export const MOUND_HEIGHT = 0.254; // 10 in
export const PLATE_WIDTH = 0.4318; // 17 in

/** 베이스 좌표. 다이아몬드는 홈에서 45도씩 벌어진다. */
const D = BASE_DISTANCE / Math.SQRT2;
export const BASE_COORDS: Vec3[] = [
  { x: -D, y: 0, z: D }, // 1루
  { x: 0, y: 0, z: BASE_DISTANCE * Math.SQRT2 }, // 2루
  { x: D, y: 0, z: D }, // 3루
  { x: 0, y: 0, z: 0 }, // 홈
];

/** 외야 펜스까지 거리. theta는 중견수 방향 기준 라디안(-45도 ~ +45도). */
export function fenceDistance(thetaRad: number): number {
  const t = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, thetaRad));
  // 라인 100m, 중앙 122m 로 부드럽게 보간
  return 100 + 22 * Math.cos(2 * t);
}

export const FENCE_HEIGHT = 2.9;

/** 수비 기본 위치 */
export const DEFENSE_SPOTS: Record<Position, Vec3> = {
  P: { x: 0, y: 0, z: MOUND_DISTANCE },
  C: { x: 0, y: 0, z: -1.6 },
  '1B': { x: -17.5, y: 0, z: 26 },
  '2B': { x: -10.5, y: 0, z: 41 },
  '3B': { x: 17.5, y: 0, z: 26 },
  SS: { x: 10.5, y: 0, z: 41 },
  LF: { x: 42, y: 0, z: 76 },
  CF: { x: 0, y: 0, z: 88 },
  RF: { x: -42, y: 0, z: 76 },
  DH: { x: 0, y: 0, z: 0 },
};

// ---------------------------------------------------------------------------
// 스트라이크존
// ---------------------------------------------------------------------------

/** 존 반폭 (m). 공 반지름을 감안해 실제 판정은 살짝 넓다. */
export const ZONE_HALF_WIDTH = 0.2159; // 홈플레이트 폭의 절반
export const ZONE_BOTTOM = 0.45;
export const ZONE_TOP = 1.06;
export const ZONE_HALF_HEIGHT = (ZONE_TOP - ZONE_BOTTOM) / 2;
export const ZONE_CENTER_Y = (ZONE_TOP + ZONE_BOTTOM) / 2;
export const BALL_RADIUS = 0.0366;

/**
 * 스트라이크 판정 경계 (존 좌표). 공 반지름 때문에 1보다 조금 넓다.
 * ZONE_TOP과 값이 같지만 단위가 다르다 — 이쪽은 존 좌표(-1~1), 저쪽은 미터다.
 */
export const ZONE_STRIKE_LIMIT = 1.06;

/**
 * 3×3 코스 분할 경계 (존 좌표). 판정 범위를 삼등분한 값(1.06/3 ≈ 0.353)을 어림한 것이다.
 * 실황 텍스트(describeLocation)와 코스별 기록(zoneCell)이 같은 칸을 가리키려면
 * 두 곳이 반드시 이 상수를 함께 써야 한다.
 */
export const ZONE_THIRD = 0.35;

/**
 * 조준할 수 있는 가장 바깥 (존 좌표). 존 밖으로 빠지는 공까지는 따라갈 수 있되,
 * 그보다 먼 곳으로 방망이를 내밀 수는 없다.
 *
 * 사람(setAim)·CPU(decideSwing)·선구 표시(readPitchLocation)가 **같은 범위 안에서**
 * 움직여야 한다. 한 곳만 넓으면 화면에는 보이는데 조준할 수 없는 지점이 생긴다.
 */
export const AIM_LIMIT = 1.9;

/**
 * 존 좌표(-1~1)를 실제 미터 좌표로 변환.
 * 존 x는 포수/타자 시점의 화면 좌우(+1 = 오른쪽 = 1루 쪽 = 우타자 바깥쪽)이고,
 * 월드 +X는 3루 방향이므로 부호가 뒤집힌다.
 */
export function zoneToWorld(zx: number, zy: number): { x: number; y: number } {
  return {
    x: -zx * ZONE_HALF_WIDTH,
    y: ZONE_CENTER_Y + zy * ZONE_HALF_HEIGHT,
  };
}

export function worldToZone(x: number, y: number): { zx: number; zy: number } {
  return {
    zx: -x / ZONE_HALF_WIDTH,
    zy: (y - ZONE_CENTER_Y) / ZONE_HALF_HEIGHT,
  };
}

// ---------------------------------------------------------------------------
// 피치 클락
// ---------------------------------------------------------------------------

/**
 * 투구 제한 시간 (초). SETUP 단계에서 이 시간을 넘기면 위반이다.
 * - 수비(투수)가 넘기면 자동 볼
 * - 공격(타자)이 넘기면 자동 스트라이크
 */
export const PITCH_CLOCK_SEC = 20;
export const PITCH_CLOCK_MS = PITCH_CLOCK_SEC * 1000;
/** 남은 시간이 이 값 이하면 경고 표시 (초) */
export const PITCH_CLOCK_WARN_SEC = 5;
/**
 * 온라인에서 호스트가 위반을 선언하기 전에 더 기다려 주는 시간 (ms).
 * 게스트의 시계는 자기 화면이 SETUP이 된 시각부터 흐르므로 호스트보다 조금 늦다.
 * 이 여유가 없으면 "내 화면엔 아직 시간이 남았는데 볼을 먹었다"가 나온다.
 */
export const PITCH_CLOCK_NET_GRACE_MS = 600;

// ---------------------------------------------------------------------------
// 구종 정의
// ---------------------------------------------------------------------------

export interface PitchDef {
  type: PitchType;
  ko: string;
  short: string;
  /** 기본 구속 (km/h). 능력치 velocity가 여기에 가산된다. */
  baseVelo: number;
  /** velocity 100일 때 추가 구속 */
  veloRange: number;
  /**
   * 수평 무브먼트 (m). 투수 손 기준, 양수 = 던지는 팔 쪽.
   * 무회전 공 대비 홈플레이트에서의 좌우 편차 = 실측 horizontal break.
   */
  hBreak: number;
  /**
   * 수직 무브먼트 (m). 무회전 공(중력만 받는 공) 대비 홈플레이트에서 덜 떨어지는 양
   * = 실측 induced vertical break. 백스핀이 있는 공은 전부 양수이고, 직구가 가장 크다.
   * "가라앉는 공"은 음수가 아니라 **직구보다 값이 작은** 공이다. 여기에 음수를 넣으면
   * 중력보다 더 떨어져 공이 손에서 위로 솟았다가 처박히는 로브 궤적이 된다.
   */
  vBreak: number;
  /** 유인구로 낮게 떨어뜨려 쓰는 구종인지 (AI 배합용) */
  chaseLow: boolean;
  /** 습득 난이도. 훈련 비용 배수. */
  difficulty: number;
  /** 기본 제공 여부 */
  innate: boolean;
  color: string;
  desc: string;
}

export const PITCH_DEFS: Record<PitchType, PitchDef> = {
  FOURSEAM: {
    type: 'FOURSEAM',
    ko: '직구',
    short: '직',
    baseVelo: 132,
    veloRange: 28,
    hBreak: 0.2,
    vBreak: 0.42,
    chaseLow: false,
    difficulty: 0,
    innate: true,
    color: '#ef4444',
    desc: '기본 구종. 가장 빠르고 제구가 쉽다.',
  },
  TWOSEAM: {
    type: 'TWOSEAM',
    ko: '투심',
    short: '투',
    baseVelo: 129,
    veloRange: 26,
    hBreak: 0.38,
    vBreak: 0.28,
    chaseLow: false,
    difficulty: 1,
    innate: false,
    color: '#f97316',
    desc: '직구와 비슷하나 던지는 팔 쪽으로 가라앉는다.',
  },
  SINKER: {
    type: 'SINKER',
    ko: '싱커',
    short: '싱',
    baseVelo: 127,
    veloRange: 24,
    hBreak: 0.42,
    vBreak: 0.17,
    chaseLow: false,
    difficulty: 1.3,
    innate: false,
    color: '#eab308',
    desc: '강하게 가라앉는다. 땅볼 유도에 최적.',
  },
  CUTTER: {
    type: 'CUTTER',
    ko: '커터',
    short: '커',
    baseVelo: 128,
    veloRange: 25,
    hBreak: -0.06,
    vBreak: 0.2,
    chaseLow: false,
    difficulty: 1.4,
    innate: false,
    color: '#84cc16',
    desc: '직구 궤적에서 반대 방향으로 살짝 꺾인다.',
  },
  SLIDER: {
    type: 'SLIDER',
    ko: '슬라이더',
    short: '슬',
    baseVelo: 120,
    veloRange: 22,
    hBreak: -0.28,
    vBreak: 0.05,
    // 슬라이더는 낮게가 아니라 바깥쪽으로 뺀다
    chaseLow: false,
    difficulty: 1.6,
    innate: false,
    color: '#22c55e',
    desc: '옆으로 크게 휘며 떨어진다.',
  },
  CURVE: {
    type: 'CURVE',
    ko: '커브',
    short: '커',
    baseVelo: 108,
    veloRange: 20,
    hBreak: -0.22,
    vBreak: -0.2,
    chaseLow: true,
    difficulty: 1.8,
    innate: false,
    color: '#06b6d4',
    desc: '느리고 낙차가 크다. 타이밍을 뺏는다.',
  },
  CHANGEUP: {
    type: 'CHANGEUP',
    ko: '체인지업',
    short: '체',
    baseVelo: 116,
    veloRange: 22,
    hBreak: 0.36,
    vBreak: 0.2,
    chaseLow: true,
    difficulty: 1.5,
    innate: false,
    color: '#3b82f6',
    desc: '직구와 같은 폼에서 느리게. 타이밍 교란.',
  },
  FORKBALL: {
    type: 'FORKBALL',
    ko: '포크볼',
    short: '포',
    baseVelo: 118,
    veloRange: 21,
    hBreak: 0.14,
    vBreak: 0.06,
    chaseLow: true,
    difficulty: 2.0,
    innate: false,
    color: '#8b5cf6',
    desc: '홈플레이트 앞에서 뚝 떨어진다.',
  },
  KNUCKLE: {
    type: 'KNUCKLE',
    ko: '너클볼',
    short: '너',
    baseVelo: 100,
    veloRange: 14,
    hBreak: 0.0,
    vBreak: 0.05,
    chaseLow: true,
    difficulty: 2.6,
    innate: false,
    color: '#ec4899',
    desc: '궤적이 무작위로 흔들린다. 제구가 매우 어렵다.',
  },
};

export const ALL_PITCH_TYPES = Object.keys(PITCH_DEFS) as PitchType[];
/** 훈련으로 습득 가능한 변화구 */
export const LEARNABLE_PITCHES = ALL_PITCH_TYPES.filter((t) => !PITCH_DEFS[t].innate);

// ---------------------------------------------------------------------------
// 타격
// ---------------------------------------------------------------------------

export interface SwingDef {
  ko: string;
  /** 컨택 판정 반경 배수 (존 좌표계 단위) */
  contactRadius: number;
  /** 타이밍 허용 오차 (ms) */
  timingWindow: number;
  /** 타구 속도 배수 */
  powerMult: number;
  /** 헛스윙 페널티 */
  whiffBias: number;
}

export const SWING_DEFS: Record<'NORMAL' | 'POWER' | 'BUNT', SwingDef> = {
  // contactRadius는 스윙 대비 컨택률을 결정한다 (MLB 76%). 0.8/0.48이면
  // 컨택 60%, 강한타격은 절반이 헛스윙이라 삼진이 폭증한다.
  NORMAL: { ko: '일반타격', contactRadius: 1.0, timingWindow: 100, powerMult: 1.0, whiffBias: 0 },
  POWER: { ko: '강한타격', contactRadius: 0.66, timingWindow: 68, powerMult: 1.14, whiffBias: 0.1 },
  BUNT: { ko: '번트', contactRadius: 1.3, timingWindow: 185, powerMult: 0.18, whiffBias: -0.2 },
};

/** 조준 UI에 표시할 컨택 반경 (존 좌표계 단위). */
export function swingDisplayRadius(type: keyof typeof SWING_DEFS, contact: number): number {
  return SWING_DEFS[type].contactRadius * (0.62 + (0.72 * contact) / 99);
}

// ---------------------------------------------------------------------------
// 커스터마이징 카탈로그
// ---------------------------------------------------------------------------

export const UNIFORM_DEFS: { id: UniformType; ko: string; desc: string }[] = [
  { id: 'CLASSIC', ko: '클래식', desc: '단색 기본형' },
  { id: 'PINSTRIPE', ko: '핀스트라이프', desc: '세로 줄무늬' },
  { id: 'RAGLAN', ko: '라글란', desc: '소매 배색' },
  { id: 'VEST', ko: '베스트', desc: '민소매 + 언더셔츠' },
  { id: 'GRADIENT', ko: '그라데이션', desc: '상하 색상 변화' },
  { id: 'SASH', ko: '새시', desc: '대각선 띠' },
];

export const BAT_DEFS: { id: BatType; ko: string; contactMod: number; powerMod: number }[] = [
  { id: 'CLASSIC', ko: '클래식', contactMod: 0, powerMod: 0 },
  { id: 'FLARE', ko: '플레어', contactMod: 2, powerMod: -1 },
  { id: 'TAPERED', ko: '테이퍼드', contactMod: -1, powerMod: 2 },
  { id: 'AXE', ko: '액스', contactMod: 1, powerMod: 1 },
  { id: 'THICK', ko: '두꺼운 배럴', contactMod: -2, powerMod: 3 },
];

export const GLOVE_DEFS: { id: GloveType; ko: string; fieldMod: number }[] = [
  { id: 'INFIELD', ko: '내야용', fieldMod: 1 },
  { id: 'OUTFIELD', ko: '외야용', fieldMod: 1 },
  { id: 'PITCHER', ko: '투수용', fieldMod: 0 },
  { id: 'CATCHER', ko: '포수 미트', fieldMod: 1 },
  { id: 'FIRSTBASE', ko: '1루 미트', fieldMod: 1 },
];

export const ACCESSORY_DEFS: { id: AccessoryType; ko: string; desc: string }[] = [
  { id: 'NONE', ko: '없음', desc: '기본' },
  { id: 'WRISTBAND', ko: '손목 밴드', desc: '양 손목에 포인트 컬러' },
  { id: 'ARM_SLEEVE', ko: '암슬리브', desc: '전완을 덮는 검은 슬리브' },
  { id: 'NECKLACE', ko: '목걸이', desc: '가슴에 걸리는 체인' },
  { id: 'EYE_BLACK', ko: '아이블랙', desc: '눈 밑 검은 띠' },
];

/**
 * 타자 체형. 파워와 스피드를 맞바꾼다.
 *
 * girth는 3D 실루엣의 몸통·팔다리 두께 배율이다. **키와 머리 비율은 건드리지 않는다** —
 * 골격 치수는 포즈·IK와 한 세트로 튜닝돼 있고, 키를 바꾸면 스트라이크존 정렬과 카메라가
 * 함께 깨진다 (PlayerModel.tsx 헤더 참고).
 */
export const BODY_DEFS: {
  id: BodyType;
  ko: string;
  powerMod: number;
  speedMod: number;
  girth: number;
  desc: string;
}[] = [
  { id: 'NORMAL', ko: '기본', powerMod: 0, speedMod: 0, girth: 1.0, desc: '균형 잡힌 체형' },
  {
    id: 'SLIM',
    ko: '슬림',
    powerMod: -5,
    speedMod: 5,
    girth: 0.9,
    desc: '가벼워 발이 빠르지만 타구가 덜 뻗는다',
  },
  {
    id: 'BIG',
    ko: '거구',
    powerMod: 5,
    speedMod: -5,
    girth: 1.14,
    desc: '타구는 멀리 가지만 발이 느려진다',
  },
];

export const BODY_BY_ID: Record<BodyType, (typeof BODY_DEFS)[number]> = Object.fromEntries(
  BODY_DEFS.map((b) => [b.id, b]),
) as Record<BodyType, (typeof BODY_DEFS)[number]>;

export const STANCE_NAMES = ['스탠다드', '오픈', '클로즈드', '크라우칭', '레그킥', '노스텝'];
export const FORM_NAMES = ['오버스로', '스리쿼터', '사이드암', '언더핸드', '토네이도'];

/** 타격 자세별 특징 설명 (커스터마이징 화면용) */
export const STANCE_DESCS = [
  '균형 잡힌 기본 자세',
  '앞발을 열어 시야가 넓다',
  '앞발을 닫아 몸통 회전이 크다',
  '무릎을 낮춰 존이 작아진다',
  '앞다리를 크게 들어 체중을 싣는다',
  '스트라이드 없이 간결하게',
];

/** 피칭 자세별 릴리스 특징 */
export const FORM_DESCS = [
  '팔을 머리 위로. 가장 높은 릴리스',
  '어깨 높이에서 비스듬히',
  '옆구리에서 던져 횡 무브먼트가 크다',
  '가장 낮은 릴리스. 타자가 보기 어렵다',
  '등을 크게 보였다가 던진다',
];

export const POSITION_KO: Record<Position, string> = {
  P: '투수',
  C: '포수',
  '1B': '1루수',
  '2B': '2루수',
  '3B': '3루수',
  SS: '유격수',
  LF: '좌익수',
  CF: '중견수',
  RF: '우익수',
  DH: '지명타자',
};

// ---------------------------------------------------------------------------
// 물리
// ---------------------------------------------------------------------------

export const GRAVITY = 9.80665;

/**
 * 달리기 한 주기(양발 1회)에 나아가는 거리 (m).
 *
 * **PlayerModel의 RUN_REACH와 한 세트다.** 모델은 접지한 발을 IK로 그 자리에 붙들어
 * 두므로, 연출(playback)이 이 값과 다른 보폭으로 걸음 위상을 만들면 그 차이만큼 발이
 * 미끄러진다. 예전 값(2.2)은 이 골격(다리 길이 0.82)이 낼 수 있는 보폭이 아니었고,
 * 그래서 발이 늘 지면 위를 쓸고 다녔다. 1.74까지 늘려 봤더니 런지 자세가 됐다.
 *
 * 연출과 모델이 함께 읽어야 해서 상수 모듈에 둔다 — 한쪽에 두고 import하면
 * 컴포넌트와 게임 로직 사이에 모듈 순환이 생긴다.
 */
export const RUN_STRIDE = 1.3;
/**
 * 야구공 항력 계수. 가속도 = DRAG_K * v^2 (m/s^2).
 *   0.5 * rho(1.225) * Cd(0.33) * A(0.00426) / m(0.145) = 0.00594
 * 이 값이 작으면 타구가 비현실적으로 멀리 날아가 홈런이 폭증한다.
 */
export const DRAG_K = 0.0064;
/**
 * 매그너스 계수. 가속도 = MAGNUS_K * |v| * (spin_axis x v).
 *
 * 예전에는 크기만 같은 힘을 **항상 +Y로** 걸었다. 그래서 타구가 스핀 축과 무관하게
 * 늘 똑바로 날아갔다 — 당겨친 뜬공이 파울라인 쪽으로 휘는, 야구에서 가장 자주 보는
 * 거동이 아예 없었다. 지금은 축을 세우고 외적으로 계산하므로
 *   - 백스핀(축이 진행 방향에 수직·수평) -> 위로 뜨는 양력
 *   - 축이 기울면 -> 그만큼 옆으로 휘는 힘 (훅/슬라이스)
 * 이 한 식에서 같이 나온다.
 *
 * 이 값이 홈런 수를 정한다. **바꾸면 180경기 x 3시드셋으로 재측정할 것**
 * (@see 메모리 anyway-baseball-engine-calibration).
 */
export const MAGNUS_K = 0.0026;
/**
 * 타구 스핀 축이 수직으로 기우는 정도 (사이드스핀).
 *
 * 배트는 공을 비껴 때리므로 당길수록 사이드스핀이 커지고, 그 방향은 **가까운 파울라인
 * 쪽**이다(우타자가 당긴 좌익수 뜬공은 3루선 쪽으로 더 휜다). 좌우 어느 쪽으로 친
 * 타구든 부호가 저절로 맞으므로 좌·우타 분기가 필요 없다.
 *
 * 0이면 예전과 같은 순수 백스핀이다. 크게 하면 파울이 늘고 장타가 줄어든다.
 */
export const SIDESPIN_K = 0.3;
