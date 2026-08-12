import type { Difficulty } from './ai';
import type { MatchRewardContext } from './matchReward';
import type { GameState, Side } from './types';
import type { LogEntry } from '../store/matchStore';

/**
 * 중단된 경기 이어서 하기.
 *
 * 한 경기는 30분이 넘게 걸리는데 지금까지는 화면을 벗어나는 순간 통째로 사라졌다.
 * 리그 경기라면 더 나쁘다 — 일정은 SCHEDULED로 남아 처음부터 다시 쳐야 했다.
 *
 * 저장 대상은 **혼자 치르는 경기(CPU · 리그)뿐이다.** 온라인·2대2·릴레이는 상대가 있어
 * 나 혼자 되살릴 수 있는 상태가 아니고(호스트의 판정 권한·P2P 연결·상대의 남은 시간),
 * 연습 타석은 이어서 할 상태 자체가 없다.
 *
 * **순수 함수만 둔다.** localStorage는 firebase/store가 다룬다 — 그래야 저장소를 흉내
 * 내지 않고 단위 테스트할 수 있다 (@see migrate.ts의 같은 규칙).
 */

/** 저장 형식 버전. 올리면 이전 저장은 이어서 할 수 없고 조용히 버려진다. */
export const RESUME_SCHEMA_VERSION = 1;

/**
 * 이만큼 지난 저장은 이어서 하지 않는다.
 *
 * 저장된 상태에는 경기 시작 시점의 로스터가 박제돼 있다. 그 사이 훈련·영입·방출로
 * 팀이 달라졌다면 "지금 내 팀"과 너무 멀어진 경기를 되살리는 셈이라, 어느 시점부터는
 * 새로 시작하는 편이 덜 혼란스럽다.
 */
export const RESUME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 한 계정이 동시에 들고 있을 수 있는 중단 경기 수 */
export const SUSPENDED_LIMIT = 3;

/** CPU 대전의 슬롯 키. CPU 경기는 한 번에 하나만 들고 있는다. */
export const CPU_RESUME_KEY = 'cpu';

/** 리그 일정 참조. matchStore.leagueRef와 같은 모양이다. */
export interface LeagueRef {
  leagueId: string;
  gameId: string;
}

/**
 * 슬롯 키. 리그 경기는 일정마다 따로 들고 있고, CPU 대전은 하나로 덮어쓴다.
 * (CPU 대전은 "다음 경기"가 정해져 있지 않아 여러 개를 쌓아 둘 이유가 없다)
 */
export function matchResumeKey(leagueRef: LeagueRef | null): string {
  return leagueRef ? `league:${leagueRef.leagueId}:${leagueRef.gameId}` : CPU_RESUME_KEY;
}

/** 이 경기를 어느 슬롯에 누구 것으로 저장하는가. 경기 내내 바뀌지 않는다. */
export interface ResumeContext {
  key: string;
  /** 저장한 계정. 한 기기를 여러 계정이 쓰므로 슬롯을 계정별로 나눈다. */
  uid: string;
  /** 내 팀 id. 이어서 할 때 보상이 엉뚱한 팀으로 가지 않도록 확인한다. */
  teamId: string;
}

export interface SuspendedMatch extends ResumeContext {
  version: number;
  savedAt: number;
  /** 보상 산정 구분. 'CPU' 또는 'LEAGUE'만 온다. */
  rewardKind: MatchRewardContext['kind'];
  difficulty: Difficulty;
  playerSide: Side;
  leagueRef: LeagueRef | null;
  /**
   * AI 전용 난수의 상태. 이걸 저장하지 않으면 이어서 한 뒤 CPU가 매번 같은 자리에서
   * 같은 판단을 반복한다 (시드를 처음부터 다시 감게 되므로).
   */
  aiRngState: number;
  /** 엔진 상태. 경기 RNG는 여기 rngState에 실려 있다. */
  state: GameState;
  log: LogEntry[];
}

export interface SuspendedInput extends Omit<SuspendedMatch, 'version'> {}

/**
 * 저장할 문서를 만든다.
 *
 * **다시 보기 클립은 담지 않는다.** 클립 하나가 GameState를 통째로 품고 있어(로스터 46명)
 * 수십 KB인데, 이 문서는 매 투구마다 다시 쓰인다 — 담는 순간 한 번의 쓰기가 다섯 배로
 * 불어나 팀·리그 저장까지 5MB 한계 밖으로 밀어낸다. 중단된 경기의 다시 보기를 잃는 것과
 * 팀 데이터를 잃는 것 중에서는 전자가 낫다.
 */
export function buildSuspendedMatch(input: SuspendedInput): SuspendedMatch {
  return {
    version: RESUME_SCHEMA_VERSION,
    key: input.key,
    uid: input.uid,
    teamId: input.teamId,
    savedAt: input.savedAt,
    rewardKind: input.rewardKind,
    difficulty: input.difficulty,
    playerSide: input.playerSide,
    leagueRef: input.leagueRef,
    aiRngState: input.aiRngState,
    state: input.state,
    log: input.log,
  };
}

/** 이 상태를 저장할 값어치가 있는가. 끝난 경기는 저장하지 않고 슬롯을 비운다. */
export function isSuspendable(state: GameState): boolean {
  return state.phase !== 'GAME_OVER' && !state.winner;
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

/** 엔진에 넣어도 즉시 터지지 않을 최소 형태인지. 깊은 검증은 하지 않는다 (비용). */
function isStateShaped(doc: unknown): doc is GameState {
  if (!doc || typeof doc !== 'object') return false;
  const s = doc as Partial<GameState>;
  return (
    typeof s.id === 'string' &&
    typeof s.inning === 'number' &&
    typeof s.rngState === 'number' &&
    !!s.settings &&
    !!s.away &&
    !!s.home &&
    Array.isArray(s.bases) &&
    Array.isArray(s.away.lineup) &&
    Array.isArray(s.home.lineup) &&
    !!s.away.roster &&
    !!s.home.roster
  );
}

/**
 * 저장돼 있던 문서를 읽는다. 형태가 아니면 null이다.
 *
 * 버전이 다르면 여기서 걸러 낸다 — 이어서 하기는 잃어도 되는 데이터라 마이그레이션
 * 체인을 두지 않는다 (@see migrate.ts는 팀처럼 잃으면 안 되는 문서만 다룬다).
 */
export function readSuspendedMatch(raw: unknown): SuspendedMatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<SuspendedMatch>;
  if (d.version !== RESUME_SCHEMA_VERSION) return null;
  if (typeof d.key !== 'string' || typeof d.uid !== 'string' || typeof d.teamId !== 'string') {
    return null;
  }
  if (typeof d.savedAt !== 'number' || typeof d.aiRngState !== 'number') return null;
  if (d.playerSide !== 'away' && d.playerSide !== 'home') return null;
  if (!isStateShaped(d.state)) return null;
  return {
    version: RESUME_SCHEMA_VERSION,
    key: d.key,
    uid: d.uid,
    teamId: d.teamId,
    savedAt: d.savedAt,
    rewardKind: d.rewardKind ?? 'CPU',
    difficulty: d.difficulty ?? 'NORMAL',
    playerSide: d.playerSide,
    leagueRef: d.leagueRef ?? null,
    aiRngState: d.aiRngState,
    state: d.state,
    log: Array.isArray(d.log) ? d.log : [],
  };
}

/** 슬롯이 넘치면 오래된 것부터 버린다. */
export function trimSuspendedMatches<T extends { savedAt: number }>(
  slots: Record<string, T>,
  limit = SUSPENDED_LIMIT,
): Record<string, T> {
  const entries = Object.entries(slots).sort((a, b) => b[1].savedAt - a[1].savedAt);
  return Object.fromEntries(entries.slice(0, limit));
}

// ---------------------------------------------------------------------------
// 이어서 할 수 있는가
// ---------------------------------------------------------------------------

export type ResumeIssue =
  /** 다른 계정이 저장했다 */
  | 'OWNER'
  /** 그때 쓰던 팀이 지금 팀과 다르다 */
  | 'TEAM'
  /** 너무 오래됐다 */
  | 'EXPIRED'
  /** 이미 끝난 경기다 */
  | 'FINISHED'
  /** 리그 일정에서 그 경기가 이미 처리됐다 (자동 진행 등) */
  | 'LEAGUE_DONE';

export const RESUME_ISSUE_KO: Record<ResumeIssue, string> = {
  OWNER: '다른 계정에서 저장한 경기입니다.',
  TEAM: '지금 선택한 팀과 다른 팀으로 치르던 경기입니다.',
  EXPIRED: '저장한 지 오래되어 이어서 할 수 없습니다.',
  FINISHED: '이미 끝난 경기입니다.',
  LEAGUE_DONE: '리그 일정에서 이미 처리된 경기입니다.',
};

export interface ResumeCheck {
  uid: string;
  /** 지금 활성화된 내 팀. 보상이 이 팀으로 가므로 저장 시점과 같아야 한다. */
  teamId: string;
  /** 리그 경기면 지금 그 일정의 상태. 리그 경기가 아니면 넘기지 않는다. */
  leagueGameStatus?: 'SCHEDULED' | 'IN_PROGRESS' | 'FINAL' | null;
}

/** 이어서 할 수 없는 이유. null이면 이어서 할 수 있다. */
export function resumeIssue(
  saved: SuspendedMatch,
  check: ResumeCheck,
  now: number,
): ResumeIssue | null {
  if (saved.uid !== check.uid) return 'OWNER';
  if (saved.teamId !== check.teamId) return 'TEAM';
  if (!isSuspendable(saved.state)) return 'FINISHED';
  if (now - saved.savedAt > RESUME_MAX_AGE_MS) return 'EXPIRED';
  // 상태를 넘기지 않은 호출(리그 경기가 아님)은 이 검사를 건너뛴다
  if (saved.leagueRef && check.leagueGameStatus != null && check.leagueGameStatus !== 'SCHEDULED') {
    return 'LEAGUE_DONE';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 표시
// ---------------------------------------------------------------------------

export interface SuspendedSummary {
  /** "SEO 3 : 2 BUS" */
  score: string;
  /** "5회말" */
  inning: string;
  /** "1사 2·3루" */
  situation: string;
  /** 내가 어느 쪽인가. "홈" / "원정" */
  sideLabel: string;
  /** "3회말 1사 · SEO 3 : 2 BUS" — 목록 한 줄에 그대로 쓴다. */
  headline: string;
}

const BASE_KO = ['1루', '2루', '3루'];

function basesText(state: GameState): string {
  const on = state.bases.map((r, i) => (r ? BASE_KO[i] : null)).filter(Boolean);
  if (!on.length) return '주자 없음';
  if (on.length === 3) return '만루';
  return on.join('·');
}

export function describeSuspended(saved: SuspendedMatch): SuspendedSummary {
  const s = saved.state;
  const inning = `${s.inning}회${s.half === 'TOP' ? '초' : '말'}`;
  const score = `${s.away.abbr} ${s.away.runs} : ${s.home.runs} ${s.home.abbr}`;
  const situation = `${s.outs}사 ${basesText(s)}`;
  return {
    score,
    inning,
    situation,
    sideLabel: saved.playerSide === 'home' ? '홈' : '원정',
    headline: `${inning} ${s.outs}사 · ${score}`,
  };
}

/** "방금 전" / "3시간 전" / "2일 전". 저장 시각을 목록에 붙일 때 쓴다. */
export function savedAgoText(savedAt: number, now: number): string {
  const min = Math.floor((now - savedAt) / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}
