/**
 * 게임 도메인 전역 타입.
 * 이 파일의 타입은 그대로 Firestore 문서 스키마이자 WebRTC 전송 페이로드가 된다.
 * 따라서 전부 직렬화 가능한 순수 데이터여야 한다 (클래스/함수/Date 금지).
 */

// ---------------------------------------------------------------------------
// 선수
// ---------------------------------------------------------------------------

export type Position = 'P' | 'C' | '1B' | '2B' | '3B' | 'SS' | 'LF' | 'CF' | 'RF' | 'DH';

export const FIELD_POSITIONS: Position[] = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

/**
 * 선수 구분. 생성 시 정해지고 이후 바뀌지 않는다.
 * 투수는 마운드 역할(PitcherRole) 안에서만, 타자는 야수 포지션 안에서만 이동할 수 있다.
 */
export type PlayerKind = 'PITCHER' | 'BATTER';

/** 타자가 맡을 수 있는 포지션. 투수(P)는 제외한다. */
export type BatterPosition = Exclude<Position, 'P'>;

export const BATTER_POSITIONS: BatterPosition[] = [
  'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH',
];

/** 투수 역할. 선발 / 중간계투 / 마무리. */
export type PitcherRole = 'SP' | 'RP' | 'CP';

export const PITCHER_ROLES: PitcherRole[] = ['SP', 'RP', 'CP'];

/** 선수 티어. 위로 갈수록 최대 레벨·능력치 상한·구종 슬롯이 함께 오른다. */
export type Tier = 'C' | 'B' | 'A' | 'S';

/** 타자 체형. 파워/스피드를 맞바꾸고 3D 실루엣의 두께를 바꾼다. */
export type BodyType = 'NORMAL' | 'SLIM' | 'BIG';

/** 부상 상태. 경기를 한 판 끝낼 때마다 gamesLeft가 1씩 줄고 0이 되면 해제된다. */
export interface Injury {
  gamesLeft: number;
  reason: string;
}

/**
 * 훈련 포인트를 쓰기 전의 원본 능력치.
 * 능력치초기화권이 여기로 되돌리고, 그동안 쓴 포인트(spentPoints)를 전액 환급한다.
 */
export interface PlayerBase {
  batting: BattingAttr;
  stamina: number;
  arsenal: Partial<Record<PitchType, PitchAttr>>;
}

export type Handedness = 'L' | 'R';
/** 타석 좌우. S는 스위치 히터. */
export type BatSide = 'L' | 'R' | 'S';

/** 구종. FOURSEAM(직구)은 모든 투수가 반드시 보유한다. */
export type PitchType =
  | 'FOURSEAM'
  | 'TWOSEAM'
  | 'CUTTER'
  | 'SLIDER'
  | 'CURVE'
  | 'CHANGEUP'
  | 'FORKBALL'
  | 'SINKER'
  | 'KNUCKLE';

/** 구종별 능력치. 각 0~99. */
export interface PitchAttr {
  /** 구속. 구종 기본 구속에 가산된다. */
  velocity: number;
  /** 제구. 목표 지점 대비 실제 도착 지점의 산포를 결정한다. */
  control: number;
  /** 무브먼트. 궤적 변화량과 헛스윙 유도력을 결정한다. */
  movement: number;
}

/** 타자 능력치. 포수를 포함한 모든 야수가 보유한다. 투수도 (낮은 값으로) 보유한다. */
export interface BattingAttr {
  contact: number;
  power: number;
  /** 선구안. 볼/스트라이크 판단과 헛스윙 회피. */
  eye: number;
  speed: number;
  fielding: number;
  arm: number;
}

export interface PitchingAttr {
  /** 스태미나. 투구 수에 따라 소모되며 0에 가까울수록 구위가 떨어진다. */
  stamina: number;
  /** 보유 구종별 능력치. FOURSEAM 키는 항상 존재한다. */
  arsenal: Partial<Record<PitchType, PitchAttr>>;
}

export type BatType = 'CLASSIC' | 'FLARE' | 'TAPERED' | 'AXE' | 'THICK';
export type GloveType = 'INFIELD' | 'OUTFIELD' | 'PITCHER' | 'CATCHER' | 'FIRSTBASE';
export type AccessoryType = 'NONE' | 'WRISTBAND' | 'ARM_SLEEVE' | 'NECKLACE' | 'EYE_BLACK';

export interface Gear {
  bat: BatType;
  batColor: string;
  glove: GloveType;
  gloveColor: string;
  accessory: AccessoryType;
}

/** 타격 자세 프리셋 인덱스 (0~5). 3D 포즈와 미세한 컨택/파워 보정에 쓰인다. */
export type BattingStance = 0 | 1 | 2 | 3 | 4 | 5;
/** 피칭 자세 프리셋 인덱스 (0~4). */
export type PitchingForm = 0 | 1 | 2 | 3 | 4;

export interface Player {
  id: string;
  name: string;
  /** 등번호 */
  number: number;
  /** 투수/타자 구분. 생성 시 고정되며 플레이어가 바꿀 수 없다. */
  kind: PlayerKind;
  /** 투수는 항상 'P'. 타자는 9개 야수 포지션 중 하나이며 플레이어가 바꾼다. */
  position: Position;
  /** 투수 전용. 선발/중간계투/마무리. */
  role?: PitcherRole;
  /** 타자 전용 체형. 파워/스피드 보정이 붙는다. */
  body: BodyType;
  bats: BatSide;
  throws: Handedness;
  stance: BattingStance;
  form: PitchingForm;
  gear: Gear;
  batting: BattingAttr;
  /** 투수만 보유. position이 'P'가 아니어도 존재할 수 있다(야수 투입 대비). */
  pitching?: PitchingAttr;
  /** 티어. 최대 레벨·능력치 상한·구종 슬롯을 결정한다. */
  tier: Tier;
  /** 현재 티어 안에서의 레벨. 티어가 오르면 1로 돌아간다(능력치는 유지). */
  level: number;
  /** 다음 레벨까지 쌓인 경험치 */
  exp: number;
  /**
   * 선수 고유의 성장 한계. 실제 상한은 티어 상한과의 min이다.
   * @see progression.statCap
   */
  potential: number;
  /** 훈련에 사용하는 포인트. 레벨업으로만 획득한다. */
  trainingPoints: number;
  /** 지금까지 훈련에 쓴 누적 포인트. 능력치초기화권의 환급액이다. */
  spentPoints: number;
  /**
   * 구종 습득에 쓴 누적 골드. 능력치초기화권이 함께 환급한다.
   *
   * 선택 필드다 — 이 필드가 생기기 전에 저장된 팀도 그대로 읽혀야 하므로
   * TEAM_SCHEMA_VERSION을 올리지 않는다. 없으면 0으로 읽는다.
   */
  spentGold?: number;
  /** 생성 시점의 능력치 스냅샷. 능력치초기화권이 복원하는 지점. */
  base: PlayerBase;
  /** 경기 사이에 이월되는 투수 피로도 (0~1). 1이면 완전히 지친 상태. */
  fatigue: number;
  /** 부상 중이면 라인업/로테이션에 넣을 수 없다. */
  injury?: Injury;
  /** 시즌 누적 스탯 */
  season: SeasonStat;
}

export interface SeasonStat {
  g: number;
  pa: number;
  ab: number;
  h: number;
  double: number;
  triple: number;
  hr: number;
  rbi: number;
  r: number;
  bb: number;
  /** 몸에 맞는 공. 타자 부상 판정의 근거이기도 하다. */
  hbp: number;
  so: number;
  sb: number;
  cs: number;
  // 투수
  ip3: number; // 아웃 카운트 단위 이닝 (3 = 1이닝)
  er: number;
  pk: number; // 탈삼진
  pbb: number;
  ph: number;
  /**
   * 던진 공의 수. TeamInGame.pitcherPitches는 투수를 바꾸면 0으로 리셋되므로
   * "이 투수가 이 경기에서 몇 개 던졌나"는 여기에만 남는다. 경기 간 피로 이월의 입력값.
   */
  np: number;
  w: number;
  l: number;
}

// ---------------------------------------------------------------------------
// 팀
// ---------------------------------------------------------------------------

export type UniformType = 'CLASSIC' | 'PINSTRIPE' | 'RAGLAN' | 'VEST' | 'GRADIENT' | 'SASH';

/**
 * 아이템 종류. 경기 보상으로는 나오지 않고 리그 1~3위 보상으로만 지급된다.
 * @see items.ts
 */
export type ItemId =
  | 'EXP_S'
  | 'EXP_M'
  | 'EXP_L'
  | 'EXP_XL'
  | 'RESET_STATS'
  | 'CURE_INJURY'
  | 'STAMINA_TONIC';

export type Inventory = Partial<Record<ItemId, number>>;

/**
 * 팀 문서 스키마 버전. 한 유저는 팀을 하나만 가지며, 이 값이 맞지 않는 문서는
 * 불러오지 않고 재창단을 유도한다 (티어/레벨 도입으로 구 스키마와 호환되지 않는다).
 */
export const TEAM_SCHEMA_VERSION = 2;

export interface Team {
  id: string;
  /** 스키마 버전. TEAM_SCHEMA_VERSION과 다르면 로드하지 않는다. */
  schemaVersion: number;
  ownerUid: string;
  name: string;
  /** 3글자 약칭. 스코어보드에 표시. */
  abbr: string;
  logoId: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  uniformType: UniformType;
  players: Player[];
  /** 타순. player id 9개. */
  lineup: string[];
  /** 선발 로테이션. 정확히 SP 4명의 player id. */
  rotation: string[];
  /** 다음 경기에 등판할 선발의 rotation 인덱스. 경기가 끝날 때마다 1씩 돈다. */
  rotationIndex: number;
  /** 재화. 티어 강화에 쓴다. */
  gold: number;
  inventory: Inventory;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 경기 설정
// ---------------------------------------------------------------------------

export interface GameSettings {
  /** 투구/포구/타격/UI/심판 선언 효과음 */
  sfxEnabled: boolean;
  /** 경기 중 평상 응원과 안타/홈런 환호 */
  crowdEnabled: boolean;
  /** 경기 외 화면의 메뉴 배경음 */
  bgmEnabled: boolean;
  sfxVolume: number;
  crowdVolume: number;
  bgmVolume: number;
  /** 정규 이닝 수. 7 또는 9. */
  regulationInnings: 7 | 9;
  /** 콜드게임 적용 여부 */
  mercyRule: boolean;
  /** 콜드게임 발동 점수차 */
  mercyRunDiff: number;
  /** 콜드게임 발동 최소 이닝 */
  mercyFromInning: number;
  /** 지명타자 사용 여부 */
  useDH: boolean;
  /** 투구/타구 연출 속도 배율. 1.0이 기본. 낮을수록 느리다(= 쉬움). */
  pitchSpeedScale: number;
  cameraShake: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  sfxEnabled: true,
  crowdEnabled: true,
  bgmEnabled: true,
  sfxVolume: 0.7,
  crowdVolume: 0.45,
  bgmVolume: 0.3,
  regulationInnings: 9,
  mercyRule: true,
  mercyRunDiff: 10,
  mercyFromInning: 7,
  useDH: true,
  pitchSpeedScale: 0.55,
  cameraShake: true,
};

/**
 * 한 경기의 규칙. GameSettings 중 **양쪽에 똑같이 적용돼야 하는** 값만 모은 것이다.
 *
 * 사운드나 카메라 흔들림은 각자 자기 브라우저 설정을 쓰지만, 이닝 수·콜드게임·DH·
 * 투구 체감 속도는 승부 조건이라 한쪽만 다르면 경기가 성립하지 않는다.
 * 온라인 방을 만들 때 방장이 정하고, 그 값이 그대로 GameState.settings에 들어간다.
 */
export type MatchRules = Pick<
  GameSettings,
  'regulationInnings' | 'mercyRule' | 'mercyRunDiff' | 'mercyFromInning' | 'useDH' | 'pitchSpeedScale'
>;

export const RULE_KEYS = [
  'regulationInnings',
  'mercyRule',
  'mercyRunDiff',
  'mercyFromInning',
  'useDH',
  'pitchSpeedScale',
] as const;

/** 설정 뭉치에서 경기 규칙만 뽑아낸다 */
export function pickRules(s: GameSettings | MatchRules): MatchRules {
  return {
    regulationInnings: s.regulationInnings,
    mercyRule: s.mercyRule,
    mercyRunDiff: s.mercyRunDiff,
    mercyFromInning: s.mercyFromInning,
    useDH: s.useDH,
    pitchSpeedScale: s.pitchSpeedScale,
  };
}

/** 방 목록·대기실에 한 줄로 보여줄 규칙 요약 */
export function describeRules(r: MatchRules | undefined): string {
  if (!r) return '기본 규칙';
  return [
    `${r.regulationInnings}이닝`,
    r.mercyRule ? `콜드 ${r.mercyRunDiff}점(${r.mercyFromInning}회~)` : '콜드 없음',
    r.useDH ? 'DH' : '투수 타석',
    `구속 ${Math.round(r.pitchSpeedScale * 100)}%`,
  ].join(' · ');
}

// ---------------------------------------------------------------------------
// 경기 상태
// ---------------------------------------------------------------------------

export type HalfInning = 'TOP' | 'BOTTOM';
export type Side = 'away' | 'home';

/** 누상의 주자. */
export interface Runner {
  playerId: string;
  /** 이 주자의 득점 책임 투수 */
  responsiblePitcherId: string;
  /** 이번 투구에서 도루를 시도할지 */
  stealing: boolean;
}

export type GamePhase =
  /** 투구 전. 도루 명령 / 구종·코스 선택 대기 */
  | 'SETUP'
  /** 공이 날아가는 중. 타자 입력 대기 */
  | 'PITCH_FLIGHT'
  /** 결과 연출 중 */
  | 'RESOLVING'
  | 'INNING_BREAK'
  | 'GAME_OVER';

export interface GameState {
  id: string;
  settings: GameSettings;
  away: TeamInGame;
  home: TeamInGame;

  inning: number;
  half: HalfInning;
  outs: number;
  balls: number;
  strikes: number;
  /** [1루, 2루, 3루] */
  bases: [Runner | null, Runner | null, Runner | null];

  /** 이닝별 득점. index 0 = 1회. */
  lineScore: { away: number[]; home: number[] };

  phase: GamePhase;
  /** 결정론적 재현을 위한 RNG 시드 상태 */
  rngState: number;
  /** 투구 통산 카운터. RNG 시퀀스 동기화 검증용. */
  pitchCount: number;
  /** 승리팀. GAME_OVER일 때만 설정. */
  winner?: Side | 'TIE';
  /** 콜드게임으로 끝났는지 */
  endedByMercy?: boolean;
}

export interface TeamInGame {
  teamId: string;
  name: string;
  abbr: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  uniformType: UniformType;
  logoId: string;
  /** id -> Player */
  roster: Record<string, Player>;
  lineup: string[];
  /** 현재 타순 인덱스 (0~8) */
  atBatIndex: number;
  pitcherId: string;
  /** 현재 투수의 투구 수 */
  pitcherPitches: number;
  /** 이 경기에서 이미 등판한 투수. 강판된 투수의 재등판을 막는다. */
  usedPitcherIds: string[];
  /** 대타/대주자/대수비로 교체돼 나간 야수. 재출전을 막는다. */
  usedBatterIds: string[];
  /** 수비 위치 배치. position -> playerId */
  defense: Partial<Record<Position, string>>;
  runs: number;
  hits: number;
  errors: number;
  lob: number;
}

// ---------------------------------------------------------------------------
// 입력 커맨드
// ---------------------------------------------------------------------------

export type SwingType = 'NORMAL' | 'POWER' | 'BUNT';

export interface PitchCommand {
  type: PitchType;
  /** 스트라이크존 기준 좌표. x: -1(좌) ~ 1(우), y: -1(하) ~ 1(상). |값|>1 이면 존 바깥. */
  targetX: number;
  targetY: number;
  /** 퀵모션 여부. 도루 저지에 유리하지만 제구가 나빠진다. */
  quickPitch: boolean;
}

export interface SwingCommand {
  swing: boolean;
  type: SwingType;
  /** 배트 조준 지점. 투구 좌표계와 동일. */
  aimX: number;
  aimY: number;
  /** 공이 홈플레이트에 도달하는 시점 대비 스윙 시점 오차(ms). 음수 = 이른 스윙. */
  timingMs: number;
}

/** 투구 직전 공격팀이 내리는 명령 */
export interface OffenseCommand {
  /** 도루를 시도할 주자의 베이스 인덱스 (0=1루, 1=2루, 2=3루) */
  steal: number[];
  swing: SwingCommand;
}

// ---------------------------------------------------------------------------
// 투구 / 타구 물리 데이터
// ---------------------------------------------------------------------------

/** 계산된 투구 1구의 궤적 정보. 클라이언트는 이 값만으로 동일한 애니메이션을 그린다. */
export interface PitchTrajectory {
  type: PitchType;
  /** km/h */
  velocity: number;
  /** 릴리스 포인트 (m). 홈플레이트 원점 좌표계. */
  release: Vec3;
  /** 홈플레이트 통과 지점 (m) */
  plate: Vec3;
  /** 무브먼트 벡터 (m). 중력 외 추가 편차. */
  breakX: number;
  breakY: number;
  /** 릴리스 -> 플레이트 소요 시간 (s). 연출 배율 적용 전 실제 값. */
  flightTime: number;
  /** 존 좌표계로 환산한 실제 도착 지점 */
  zoneX: number;
  zoneY: number;
  isStrikeZone: boolean;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 타구 정보 */
export interface BattedBall {
  /** 타구 속도 km/h */
  exitVelocity: number;
  /** 발사각 (도). 음수는 땅볼. */
  launchAngle: number;
  /** 좌우 방향 (도). 0 = 중견수 정면, 음수 = 좌익, 양수 = 우익. ±45가 파울라인. */
  sprayAngle: number;
  /** 체공 시간 (s) */
  hangTime: number;
  /** 착지 지점 (m) */
  landing: Vec3;
  /**
   * 착지(담장을 맞았으면 충돌) 순간의 속도 (m/s).
   * 판정에는 쓰지 않고, 낙구 후 바운드/구르기 연출의 초기 조건으로만 쓴다.
   * 구버전 저장 데이터에는 없을 수 있다.
   */
  landingVel?: Vec3;
  /** 비거리 (m) */
  distance: number;
  kind: 'GROUNDER' | 'LINE_DRIVE' | 'FLY' | 'POPUP' | 'BUNT';
  /** 궤적 샘플. 연출용. */
  path: Vec3[];
  /** 담장을 넘어갔는가 (홈런) */
  overFence: boolean;
  /** 담장을 직접 맞혔는가 (인플레이) */
  hitFence: boolean;
}

/**
 * 타구를 누가 언제 어디서 처리했는가.
 * 판정에 쓰인 값을 그대로 연출(야수 이동/송구)에 재사용한다.
 */
export interface FieldPlay {
  /** 타구를 처리한 야수 */
  primary: Position;
  /** 노바운드로 잡았는가 (뜬공 아웃) */
  caught: boolean;
  /** 실책 발생 */
  error: boolean;
  homeRun: boolean;
  /** 펜스 직격 (인정 2루타 아님, 인플레이) */
  fenceHit: boolean;
  /** 파울 지역 타구 */
  foul: boolean;
  /** 파울 플라이를 잡았는가 */
  foulCaught: boolean;
  /** 야수가 공을 확보한 시각 (타격 순간 = 0) */
  secureTime: number;
  securePoint: Vec3;
  /** 이 야수의 송구 속도 (m/s) */
  throwSpeed: number;
  transferTime: number;
  infield: boolean;
  /** 내야를 뚫고 나갔는가 */
  throughInfield: boolean;
  /** 인필드 플라이 상황이었는가 */
  infieldFly: boolean;
}

// ---------------------------------------------------------------------------
// 플레이 결과
// ---------------------------------------------------------------------------

export type PlayResultKind =
  | 'BALL'
  | 'STRIKE_LOOKING'
  | 'STRIKE_SWINGING'
  | 'FOUL'
  | 'HIT_BY_PITCH'
  | 'WALK'
  | 'STRIKEOUT'
  | 'SINGLE'
  | 'DOUBLE'
  | 'TRIPLE'
  | 'HOME_RUN'
  | 'GROUND_OUT'
  | 'FLY_OUT'
  | 'LINE_OUT'
  | 'POP_OUT'
  | 'FOUL_OUT'
  | 'SAC_FLY'
  | 'SAC_BUNT'
  | 'DOUBLE_PLAY'
  | 'FIELDERS_CHOICE'
  | 'ERROR'
  | 'INFIELD_FLY'
  | 'STOLEN_BASE'
  | 'CAUGHT_STEALING'
  | 'WILD_PITCH'
  | 'PASSED_BALL';

/**
 * 이 플레이에서 주자 한 명이 어디서 어디로 움직였는가.
 * 연출(주루 애니메이션) 전용이며 판정에는 쓰이지 않는다.
 */
export interface RunnerMove {
  playerId: string;
  /** 출발 베이스. 0=1루, 1=2루, 2=3루, -1=타자(홈플레이트) */
  from: number;
  /** 도착 베이스. 0=1루 … 2=3루, 3=득점, -1=아웃 */
  to: number;
  /** 아웃된 경우 어느 베이스에서 잡혔는지 (0=1루 … 3=홈) */
  outAt?: number;
  /** 투구와 동시에 스타트를 끊었는가 (도루/히트앤런) */
  running?: boolean;
  /** 태그업(뜬공 포구 후 출발)인가 */
  tagUp?: boolean;
}

/** 피치 클락을 넘긴 쪽. 수비=자동 볼, 공격=자동 스트라이크. */
export type PitchClockViolation = 'DEFENSE' | 'OFFENSE';

/** 한 투구의 완전한 해석 결과. 이 객체 하나가 네트워크로 오간다. */
export interface PitchResult {
  pitchNumber: number;
  /** 실제로 던진 공의 궤적. 피치 클락 위반처럼 공을 던지지 않은 플레이에는 없다. */
  trajectory?: PitchTrajectory;
  /** 피치 클락 위반으로 만들어진 결과인가 */
  pitchClockViolation?: PitchClockViolation;
  swing: SwingCommand;
  /** 배트에 맞았는지 */
  contact: boolean;
  battedBall?: BattedBall;
  kind: PlayResultKind;
  /** 도루 판정 결과 */
  stealResults: StealResult[];
  /** 주자별 이동 (연출용) */
  runnerMoves: RunnerMove[];
  /** 처리한 수비수 순서 (예: ['SS','2B','1B']) */
  fielders: Position[];
  /** 수비 처리 상세. 인플레이 타구에서만 채워진다 (연출용) */
  fieldPlay?: FieldPlay;
  /** 이 플레이로 발생한 아웃 수 */
  outsRecorded: number;
  /** 이 플레이로 들어온 점수 */
  runsScored: number;
  /** 득점한 주자 id */
  scoringPlayerIds: string[];
  /** 타점 */
  rbi: number;
  /** 한글 실황 텍스트 */
  description: string;
  /** 해석 후 상태 스냅샷 */
  state: GameState;
  /** 이 투구로 타석이 끝났는지 */
  atBatEnded: boolean;
}

export interface StealResult {
  fromBase: number;
  playerId: string;
  safe: boolean;
}

// ---------------------------------------------------------------------------
// 리그
// ---------------------------------------------------------------------------

export interface LeagueTeamRef {
  teamId: string;
  ownerUid: string;
  name: string;
  abbr: string;
  primaryColor: string;
  secondaryColor: string;
  logoId: string;
  isCPU: boolean;
}

export interface LeagueGame {
  id: string;
  round: number;
  awayTeamId: string;
  homeTeamId: string;
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'FINAL';
  awayScore?: number;
  homeScore?: number;
  playedAt?: number;
}

export interface League {
  id: string;
  name: string;
  ownerUid: string;
  teams: LeagueTeamRef[];
  /** 다른 기기에서도 경기를 재현할 수 있도록 함께 동기화하는 CPU 팀 원본. */
  cpuTeams?: Team[];
  schedule: LeagueGame[];
  settings: GameSettings;
  /** 팀 간 맞대결 횟수 */
  roundsPerOpponent: number;
  createdAt: number;
  status: 'DRAFT' | 'ACTIVE' | 'FINISHED';
  /** 종료 보상(골드·아이템)을 지급한 시각. 두 번 주지 않기 위한 표식. */
  rewardedAt?: number;
}

export interface StandingRow {
  teamId: string;
  name: string;
  abbr: string;
  primaryColor: string;
  w: number;
  l: number;
  t: number;
  rf: number;
  ra: number;
  pct: number;
  gb: number;
  streak: string;
}
