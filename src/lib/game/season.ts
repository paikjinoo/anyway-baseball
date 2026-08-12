import { emptySeason } from './generator';
import { mergeSeason } from './matchReward';
import { era } from './record';
import type { Player, SeasonStat, Team } from './types';

/**
 * 시즌 경계.
 *
 * `Player.season`은 이름만 "시즌"이었고 실제로는 선수를 만든 순간부터 영구히 쌓이기만
 * 했다 — 초기화하는 코드가 어디에도 없었다. 그래서 "이번 시즌 3할"이라는 말이 성립하지
 * 않았고, 타율왕도 MVP도 잴 기준이 없었다.
 *
 * 여기서 하는 일은 그 경계를 긋는 것뿐이다. 마감하면 이번 시즌 기록이 통산으로 넘어가고
 * 시즌 기록은 0으로 돌아간다. **능력치·레벨·티어는 건드리지 않는다** — 시즌이 바뀐다고
 * 키운 선수가 약해지면 그건 다른 게임이다.
 */

/** 선수별로 남겨 둘 시즌 수. 저장 용량 상한이다. */
export const SEASON_LOG_LIMIT = 5;

/** 규정 타석 / 규정 이닝의 기준이 되는 팀 경기 수 대비 비율 */
const QUAL_PA_PER_GAME = 3.1;
const QUAL_IP_PER_GAME = 1.0;

/** 지금 시즌 번호. 없으면 1. */
export function seasonNo(team: Team): number {
  return team.seasonNo ?? 1;
}

/** 통산 기록. 없으면 빈 기록. **이번 시즌은 포함하지 않는다.** */
export function careerOf(p: Player): SeasonStat {
  return p.career ?? emptySeason();
}

/** 통산 + 이번 시즌. 화면에 "통산"으로 보여 줄 값이다. */
export function careerWithCurrent(p: Player): SeasonStat {
  return mergeSeason(careerOf(p), p.season);
}

/**
 * 이중 집계로 부푼 스플릿을 걷어낸다.
 *
 * engine.toTeamInGame이 splits를 비우지 않던 시절, 경기마다 저장분이 한 번 더 더해져
 * 타수가 2의 거듭제곱으로 늘었다 (3경기에 100 → 833). 타율은 초기 경기 쪽으로 지수
 * 가중돼 있어서 비율만 살려도 "정확해 보이는 거짓말"이 되므로, 믿을 수 없으면 버린다.
 *
 * 판정은 "스플릿 타수 합이 실제 타수(통산 + 이번 시즌)를 넘는가" 하나뿐이다. 스플릿은
 * 타수로 인정될 때만 세므로 정상 데이터에서는 두 값이 정확히 같고, 이 조건에 걸릴 일이
 * 없다. 그래서 마이그레이션 플래그도 스키마 버전도 필요 없다 — 조건이 스스로 사라진다.
 * splits는 원래 "없으면 기록이 없다는 뜻"인 선택 필드라 버려도 계약 위반이 아니다.
 */
export function repairSplits(p: Player): Player {
  const s = p.splits;
  if (!s) return p;
  const recorded = (s.vsL?.[0] ?? 0) + (s.vsR?.[0] ?? 0);
  if (recorded <= careerOf(p).ab + p.season.ab) return p;
  const next = { ...p };
  delete next.splits;
  return next;
}

/** 팀 전체에 repairSplits를 건다. 고칠 것이 없으면 원본을 그대로 돌려준다. */
export function repairTeam(t: Team): Team {
  let changed = false;
  const players = t.players.map((p) => {
    const next = repairSplits(p);
    if (next !== p) changed = true;
    return next;
  });
  return changed ? { ...t, players } : t;
}

/**
 * 시즌을 마감한다. 이번 시즌 기록을 통산으로 넘기고 시즌 기록을 비운다.
 *
 * 되돌릴 수 없으므로 화면에서 사용자가 직접 누를 때만 부른다 (자동으로 돌리지 않는다).
 * 한 경기도 안 뛴 선수는 로그를 남기지 않는다 — 벤치만 지킨 시즌이 기록에 쌓이면
 * seasonLog가 빈 줄로 차서 정작 뛴 시즌이 밀려난다.
 */
export function closeSeason(team: Team): Team {
  const no = seasonNo(team);
  return {
    ...team,
    seasonNo: no + 1,
    updatedAt: Date.now(),
    players: team.players.map((p) => {
      const played = p.season.g > 0;
      const log = played
        ? [...(p.seasonLog ?? []), { seasonNo: no, stat: p.season }].slice(-SEASON_LOG_LIMIT)
        : p.seasonLog;
      return {
        ...p,
        career: mergeSeason(careerOf(p), p.season),
        seasonLog: log,
        season: emptySeason(),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 타이틀
// ---------------------------------------------------------------------------

export type TitleId =
  | 'AVG'
  | 'HR'
  | 'RBI'
  | 'SB'
  | 'WIN'
  | 'ERA'
  | 'SO'
  | 'MVP';

export const TITLE_KO: Record<TitleId, string> = {
  AVG: '타율왕',
  HR: '홈런왕',
  RBI: '타점왕',
  SB: '도루왕',
  WIN: '다승왕',
  ERA: '방어율왕',
  SO: '탈삼진왕',
  MVP: 'MVP',
};

export interface TitleWinner {
  id: TitleId;
  playerId: string;
  name: string;
  /** 화면에 그대로 쓰는 수치 (".324", "31홈런") */
  value: string;
}

/**
 * 규정 타석. 팀이 치른 경기 수에 비례한다.
 *
 * 이게 없으면 1타수 1안타가 타율 1.000으로 타율왕이 된다. 실제 야구의 3.1타석/경기를
 * 그대로 쓴다.
 */
export function qualifiedPA(teamGames: number): number {
  return Math.ceil(teamGames * QUAL_PA_PER_GAME);
}

/** 규정 이닝 (아웃 카운트 단위). 1이닝/경기. */
export function qualifiedIP3(teamGames: number): number {
  return Math.ceil(teamGames * QUAL_IP_PER_GAME) * 3;
}

/**
 * 이 선수의 시즌 기여도. MVP를 고르는 데만 쓰는 아주 단순한 점수다.
 *
 * 정교한 WAR을 흉내 내지 않는다 — 리그 평균이나 포지션 조정 같은 입력이 없고,
 * 있는 척하면 숫자만 그럴듯해진다. 타자는 출루와 장타, 투수는 이닝과 탈삼진에서
 * 자책점을 빼는 정도로만 잰다.
 */
export function contributionScore(s: SeasonStat): number {
  const batting = s.h + s.bb * 0.7 + s.hbp * 0.7 + s.double + s.triple * 2 + s.hr * 3 + s.rbi * 0.5 + s.sb * 0.3 - s.cs * 0.3;
  const pitching = (s.ip3 / 3) * 1.6 + s.pk * 0.35 + s.w * 2 - s.er * 1.1;
  return batting + pitching;
}

/** 야구식 소수 표기 (".324"). format.baseballRate와 같은 규칙. */
function rate3(v: number): string {
  const s = v.toFixed(3);
  return v < 1 && s.startsWith('0') ? s.slice(1) : s;
}

/**
 * 순위에 올릴 선수 한 명.
 *
 * 팀마다 치른 경기 수가 다르므로 규정 타석·이닝의 분모를 **선수마다 들고 다닌다.**
 * 리그 최다 경기 팀 기준으로 통일하면 포스트시즌에서 무너진다 — 결승까지 간 팀이
 * 최대 7경기를 더 치르므로, 통일하면 탈락한 팀 타자가 전부 규정 미달로 사라진다.
 */
export interface RankedPlayer {
  playerId: string;
  name: string;
  teamId: string;
  teamAbbr: string;
  stat: SeasonStat;
  /** 이 선수의 팀이 치른 경기 수 */
  teamGames: number;
}

/**
 * 부문 하나의 명세.
 *
 * 타이틀 수상자와 리더보드가 **같은 표를 읽게 하려고** 뽑아냈다. 같은 규칙을 두 번 적으면
 * 언젠가 "결산 타율왕이 리더보드 2위"인 화면이 나오고, 그때는 어느 쪽이 맞는지 알 수 없다.
 */
export interface TitleSpec {
  id: TitleId;
  /** 정렬 키. 클수록 상위 — 방어율만 부호를 뒤집는다. */
  score: (e: RankedPlayer) => number;
  /** 이 부문 순위에 낄 자격 (규정 타석·이닝, 누적 0 제외) */
  eligible: (e: RankedPlayer) => boolean;
  format: (s: SeasonStat) => string;
}

export const TITLE_SPECS: readonly TitleSpec[] = [
  {
    id: 'AVG',
    score: (e) => e.stat.h / e.stat.ab,
    eligible: (e) => e.stat.ab > 0 && e.stat.pa >= qualifiedPA(e.teamGames),
    format: (s) => rate3(s.h / s.ab),
  },
  // 홈런·타점·도루·다승·탈삼진은 규정 타석을 따지지 않는다. 누적 기록이라 적게 나온
  // 선수가 1위가 되는 일이 구조적으로 생기지 않는다.
  { id: 'HR', score: (e) => e.stat.hr, eligible: (e) => e.stat.hr > 0, format: (s) => `${s.hr}홈런` },
  { id: 'RBI', score: (e) => e.stat.rbi, eligible: (e) => e.stat.rbi > 0, format: (s) => `${s.rbi}타점` },
  { id: 'SB', score: (e) => e.stat.sb, eligible: (e) => e.stat.sb > 0, format: (s) => `${s.sb}도루` },
  { id: 'WIN', score: (e) => e.stat.w, eligible: (e) => e.stat.w > 0, format: (s) => `${s.w}승` },
  {
    id: 'ERA',
    score: (e) => -(era(e.stat) ?? Infinity),
    eligible: (e) => e.stat.ip3 >= qualifiedIP3(e.teamGames),
    format: (s) => (era(s) ?? 0).toFixed(2),
  },
  { id: 'SO', score: (e) => e.stat.pk, eligible: (e) => e.stat.pk > 0, format: (s) => `${s.pk}탈삼진` },
  {
    id: 'MVP',
    score: (e) => contributionScore(e.stat),
    eligible: () => true,
    format: (s) => `기여도 ${contributionScore(s).toFixed(0)}`,
  },
];

/**
 * 리더보드에 나열할 부문. MVP는 빠진다 — 순위가 아니라 시즌을 마감할 때 주는 상 하나다.
 */
export const LEADERBOARD_CATEGORIES: readonly TitleId[] = ['AVG', 'HR', 'RBI', 'SB', 'WIN', 'ERA', 'SO'];

export interface LeaderRow {
  playerId: string;
  name: string;
  teamId: string;
  teamAbbr: string;
  value: string;
}

/** 출전 기록이 있는 선수만 순위 대상으로 추린다. */
export function rankedOf(
  players: Player[],
  teamGames: number,
  teamId = '',
  teamAbbr = '',
): RankedPlayer[] {
  return players
    .filter((p) => p.season.g > 0)
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      teamId,
      teamAbbr,
      stat: p.season,
      teamGames,
    }));
}

/** 한 부문의 상위 limit명. 자격 미달은 아예 빠진다. */
export function computeLeaders(entries: RankedPlayer[], id: TitleId, limit = 5): LeaderRow[] {
  const spec = TITLE_SPECS.find((s) => s.id === id);
  if (!spec) return [];
  return entries
    .filter(spec.eligible)
    .filter((e) => Number.isFinite(spec.score(e)))
    .sort((a, b) => spec.score(b) - spec.score(a))
    .slice(0, limit)
    .map((e) => ({
      playerId: e.playerId,
      name: e.name,
      teamId: e.teamId,
      teamAbbr: e.teamAbbr,
      value: spec.format(e.stat),
    }));
}

/**
 * 이번 시즌 타이틀 수상자.
 *
 * 각 부문의 1위를 computeLeaders에서 그대로 가져오므로 **수상자와 리더보드 1위가
 * 어긋날 수 없다.** 동점자는 목록 순서상 앞선 쪽이 이긴다 (Array.sort가 안정 정렬이다).
 */
export function computeTitlesOf(entries: RankedPlayer[]): TitleWinner[] {
  if (!entries.length) return [];
  const out: TitleWinner[] = [];
  for (const spec of TITLE_SPECS) {
    const top = computeLeaders(entries, spec.id, 1)[0];
    if (top) out.push({ id: spec.id, playerId: top.playerId, name: top.name, value: top.value });
  }
  return out;
}

/**
 * 한 팀 안에서의 타이틀 수상자.
 *
 * @param teamGames 팀이 치른 경기 수. 규정 타석·이닝의 기준이다.
 */
export function computeTitles(players: Player[], teamGames: number): TitleWinner[] {
  return computeTitlesOf(rankedOf(players, teamGames));
}
