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
  position: Position;
  bats: BatSide;
  throws: Handedness;
  stance: BattingStance;
  form: PitchingForm;
  gear: Gear;
  batting: BattingAttr;
  /** 투수만 보유. position이 'P'가 아니어도 존재할 수 있다(야수 투입 대비). */
  pitching?: PitchingAttr;
  /** 훈련 성장 한계. 각 능력치가 이 값을 넘을 수 없다. */
  potential: number;
  /** 훈련에 사용하는 포인트. 경기 결과로 획득한다. */
  trainingPoints: number;
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
  so: number;
  sb: number;
  cs: number;
  // 투수
  ip3: number; // 아웃 카운트 단위 이닝 (3 = 1이닝)
  er: number;
  pk: number; // 탈삼진
  pbb: number;
  ph: number;
  w: number;
  l: number;
}

// ---------------------------------------------------------------------------
// 팀
// ---------------------------------------------------------------------------

export type UniformType = 'CLASSIC' | 'PINSTRIPE' | 'RAGLAN' | 'VEST' | 'GRADIENT' | 'SASH';

export interface Team {
  id: string;
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
  /** 선발 로테이션. player id. */
  rotation: string[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 경기 설정
// ---------------------------------------------------------------------------

export interface GameSettings {
  soundEnabled: boolean;
  sfxVolume: number;
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
  soundEnabled: true,
  sfxVolume: 0.7,
  bgmVolume: 0.3,
  regulationInnings: 9,
  mercyRule: true,
  mercyRunDiff: 10,
  mercyFromInning: 7,
  useDH: true,
  pitchSpeedScale: 0.55,
  cameraShake: true,
};

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

/** 한 투구의 완전한 해석 결과. 이 객체 하나가 네트워크로 오간다. */
export interface PitchResult {
  pitchNumber: number;
  trajectory: PitchTrajectory;
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
  schedule: LeagueGame[];
  settings: GameSettings;
  /** 팀 간 맞대결 횟수 */
  roundsPerOpponent: number;
  createdAt: number;
  status: 'DRAFT' | 'ACTIVE' | 'FINISHED';
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
