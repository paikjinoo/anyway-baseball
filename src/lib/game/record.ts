import { emptySeason } from './generator';
import type {
  GameState,
  MatchRules,
  OffenseCommand,
  PitchCommand,
  PlayerKind,
  SeasonStat,
  Side,
  TeamInGame,
} from './types';
import { pickRules } from './types';

/**
 * 끝난 경기의 박스스코어.
 *
 * 지금까지 경기는 최종 스코어만 남기고 사라졌다 — 매 투구마다 만들어지던 실황 텍스트도,
 * 선수별 성적도 화면이 닫히는 순간 같이 없어졌다. 이 파일은 그걸 붙잡아 둔다.
 *
 * **새로 계산하는 값은 하나도 없다.** 엔진이 경기 내내 채워 둔 것을 옮겨 담을 뿐이다:
 * `TeamInGame.roster[id].season`은 engine.toTeamInGame이 emptySeason()으로 시작하므로
 * 이미 "이 경기의 델타"이고, 득점·안타·실책·이닝별 점수도 GameState에 그대로 있다.
 *
 * 저장은 localStorage 링버퍼로만 한다 (@see firebase/store.saveGameRecord).
 * Firestore에 쓰면 README가 약속한 "경기 1회당 쓰기 0"이 깨진다.
 */

/** 이 기록이 어느 모드에서 나왔는가. 리그 경기만 일정에 붙는다. */
export type RecordKind = 'CPU' | 'LEAGUE' | 'ONLINE' | 'RELAY';

export interface BoxLine {
  playerId: string;
  /** 기록 시점의 이름. 나중에 방출돼도 박스스코어는 그대로 읽혀야 한다. */
  name: string;
  kind: PlayerKind;
  /**
   * 표시 순서. 타자는 타순(1~9), 투수는 100 + 등판 순서.
   * 교체돼 나가 타순에서 빠진 선수는 그 뒤(50+)에 붙는다.
   */
  order: number;
  stat: SeasonStat;
}

export interface TeamBox {
  teamId: string;
  name: string;
  abbr: string;
  primaryColor: string;
  runs: number;
  hits: number;
  errors: number;
  lob: number;
  /** 이닝별 득점. index 0 = 1회. */
  lineScore: number[];
  /** 출전한 선수만. 타순 → 투수 순으로 정렬돼 있다. */
  lines: BoxLine[];
}

/**
 * 다시 볼 만한 한 플레이.
 *
 * 엔진이 결정론적이라 **투구 직전 상태와 그때의 커맨드 두 개면 완전히 재현된다** —
 * `resolvePitch(state, pitch, offense)` 한 번이면 원래와 같은 결과가 나온다.
 * 시드가 `state.rngState`에 들어 있어서 따로 저장할 것이 없다.
 */
export interface PlayClip {
  id: string;
  /** "9회말 2사, 역전 3점 홈런" 처럼 목록에 그대로 쓴다. */
  label: string;
  /** 투구 직전 상태. matchStore.prePitchState가 그대로 이 값이다. */
  state: GameState;
  pitch: PitchCommand;
  offense: OffenseCommand;
}

export interface GameRecord {
  id: string;
  kind: RecordKind;
  playedAt: number;
  rules: MatchRules;
  /** 리그 경기면 일정과 이어 붙이기 위한 참조 */
  leagueId?: string;
  leagueGameId?: string;
  away: TeamBox;
  home: TeamBox;
  winner?: Side | 'TIE';
  endedByMercy?: boolean;
  /** 승패가 붙은 투수 */
  decisionPitcherId?: string;
  /** 득점이 난 장면의 실황 텍스트 */
  highlights: string[];
  /** 다시 보기. 용량이 커서 최근 경기 몇 개에만 남는다. */
  clips?: PlayClip[];
}

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------

/**
 * 출전 여부. engine이 선발과 교체 투입 시점에 `season.g = 1`을 찍으므로
 * 이 값 하나가 곧 "이 경기에 나왔는가"다.
 */
function appeared(stat: SeasonStat): boolean {
  return stat.g > 0;
}

function buildTeamBox(t: TeamInGame, lineScore: number[]): TeamBox {
  const lines: BoxLine[] = [];

  for (const [id, p] of Object.entries(t.roster)) {
    if (!appeared(p.season)) continue;

    let order: number;
    if (p.kind === 'PITCHER') {
      // 등판 순서. usedPitcherIds는 강판된 투수만 담으므로 현재 투수는 그 뒤에 온다.
      const idx = t.usedPitcherIds.indexOf(id);
      order = 100 + (idx >= 0 ? idx : t.usedPitcherIds.length);
    } else {
      const slot = t.lineup.indexOf(id);
      // 교체돼 타순에서 빠진 야수는 -1이 된다. 타순 뒤, 투수 앞에 둔다.
      order = slot >= 0 ? slot + 1 : 50;
    }

    lines.push({
      playerId: id,
      name: p.name,
      kind: p.kind,
      order,
      stat: { ...p.season },
    });
  }

  lines.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ko'));

  return {
    teamId: t.teamId,
    name: t.name,
    abbr: t.abbr,
    primaryColor: t.primaryColor,
    runs: t.runs,
    hits: t.hits,
    errors: t.errors,
    lob: t.lob,
    lineScore: [...lineScore],
    lines,
  };
}

/**
 * 치르지 않은 연장 칸을 잘라 낸다.
 *
 * 엔진은 회차가 넘어갈 때 이닝 칸을 먼저 늘리고 종료 판정을 나중에 하므로, 9회에 끝난
 * 경기에도 0으로 찬 10회 칸이 남는다. 화면(Scoreboard)에서는 경기 중 한 번 스쳐 갈 뿐이지만
 * 기록은 영영 남으므로 여기서 정리한다.
 *
 * 무승부는 건드리지 않는다 — 연장 상한까지 가서 양 팀 모두 0점으로 끝난 이닝은
 * 실제로 치른 이닝이다.
 */
function trimUnplayedInnings(
  away: number[],
  home: number[],
  regulation: number,
  tie: boolean,
): [number[], number[]] {
  if (tie) return [away, home];
  let n = Math.max(away.length, home.length);
  while (n > regulation && (away[n - 1] ?? 0) === 0 && (home[n - 1] ?? 0) === 0) n--;
  return [away.slice(0, n), home.slice(0, n)];
}

export interface BuildRecordOptions {
  kind: RecordKind;
  playedAt: number;
  leagueId?: string;
  leagueGameId?: string;
  decisionPitcherId?: string;
  /** 득점 장면 실황. 헤드리스 자동 진행처럼 로그가 없는 경로는 비워 둔다. */
  highlights?: string[];
  clips?: PlayClip[];
}

/** 끝난 경기 상태에서 박스스코어를 만든다. */
export function buildGameRecord(state: GameState, opts: BuildRecordOptions): GameRecord {
  const [awayLine, homeLine] = trimUnplayedInnings(
    state.lineScore.away,
    state.lineScore.home,
    state.settings.regulationInnings,
    state.winner === 'TIE',
  );

  return {
    // state.id는 시드 소스라 같은 리그 경기를 다시 치르면 겹친다. 시각을 붙여 가른다.
    id: `${state.id}@${opts.playedAt}`,
    kind: opts.kind,
    playedAt: opts.playedAt,
    rules: pickRules(state.settings),
    leagueId: opts.leagueId,
    leagueGameId: opts.leagueGameId,
    away: buildTeamBox(state.away, awayLine),
    home: buildTeamBox(state.home, homeLine),
    winner: state.winner,
    endedByMercy: state.endedByMercy,
    decisionPitcherId: opts.decisionPitcherId,
    highlights: opts.highlights ?? [],
    clips: opts.clips?.length ? opts.clips : undefined,
  };
}

// ---------------------------------------------------------------------------
// 집계 헬퍼 (표시용)
// ---------------------------------------------------------------------------

/** 박스스코어 한 팀의 타자 합계. 이닝별 득점 합과 맞는지 확인하는 데도 쓴다. */
export function batterTotals(box: TeamBox): SeasonStat {
  const out = emptySeason();
  const keys = Object.keys(out) as (keyof SeasonStat)[];
  for (const l of box.lines) {
    if (l.kind !== 'BATTER') continue;
    for (const k of keys) out[k] += l.stat[k] ?? 0;
  }
  return out;
}

/** 방어율. ip3(아웃 카운트)와 자책점으로 계산한다. */
export function era(stat: SeasonStat): number | null {
  if (stat.ip3 <= 0) return null;
  return (stat.er * 27) / stat.ip3;
}

/** "6.2" 처럼 야구식 이닝 표기 */
export function inningsText(ip3: number): string {
  return `${Math.floor(ip3 / 3)}.${ip3 % 3}`;
}
