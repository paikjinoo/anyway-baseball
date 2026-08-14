import { TEAM_SCHEMA_VERSION } from './types';
import type { GameSettings, League, Team } from './types';
import type { GameRecord } from './record';

/**
 * 세이브 데이터 내보내기 / 가져오기.
 *
 * 기록·클립·설정은 localStorage에만 있고, 팀과 리그도 게스트에게는 로컬이 전부다.
 * 브라우저를 바꾸거나 데이터를 지우면 통산 기록이 통째로 사라지는데 되돌릴 방법이 없었다.
 *
 * **순수 함수만 둔다.** 저장소 접근은 firebase/store가 하고 여기서는 봉투를 만들고
 * 참조를 갈아끼우는 일만 한다 — 그래야 리타깃 로직을 단위 테스트할 수 있다.
 */

export const BACKUP_FORMAT = 'anyway-baseball-backup';

/**
 * 봉투 버전. **팀 스키마 버전과는 다른 축이다** — 봉투는 담는 방식이고,
 * 스키마는 내용물이다. 둘을 한 숫자로 묶으면 포장만 바뀌어도 내용물을 못 읽게 된다.
 */
export const BACKUP_ENVELOPE_VERSION = 1;

/** 파싱 전에 거절할 파일 크기. JSON.parse가 메인 스레드를 몇 초 잡는다. */
export const BACKUP_MAX_BYTES = 20 * 1024 * 1024;

/** 새 id를 찾는 시도 횟수 상한. 무한 루프 방어이며 정상 경로에서는 한두 번이면 끝난다. */
const MAX_ID_ATTEMPTS = 1000;

export interface BackupPayload {
  /** 내 팀 + 내 리그가 참조하는 CPU 팀. 스키마로 거르지 않은 **원본 그대로** 담는다. */
  teams: Team[];
  leagues: League[];
  settings: GameSettings;
  records: GameRecord[];
  activeTeamId: string | null;
  nickname: string | null;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  envelope: number;
  exportedAt: number;
  uid: string;
  /** 내보낼 때의 TEAM_SCHEMA_VERSION. 가져오는 쪽이 더 낮으면 거절한다. */
  teamSchemaVersion: number;
  appVersion: string;
  includesClips: boolean;
  data: BackupPayload;
}

export function buildBackup(opt: {
  uid: string;
  payload: BackupPayload;
  appVersion: string;
  exportedAt: number;
}): BackupFile {
  const clips = opt.payload.records.some((r) => r.clips?.length);
  return {
    format: BACKUP_FORMAT,
    envelope: BACKUP_ENVELOPE_VERSION,
    exportedAt: opt.exportedAt,
    uid: opt.uid,
    teamSchemaVersion: TEAM_SCHEMA_VERSION,
    appVersion: opt.appVersion,
    includesClips: clips,
    data: opt.payload,
  };
}

/** 파일명. 콜론·공백 없는 ASCII만 쓴다 (윈도·모바일 다운로드 호환). */
export function backupFileName(exportedAt: number, suffix = ''): string {
  const d = new Date(exportedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `anyway-baseball-backup-${stamp}${suffix}.json`;
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

export interface BackupSummary {
  exportedAt: number;
  uid: string;
  /** 내보낸 계정과 지금 계정이 같은가 */
  sameAccount: boolean;
  teamNames: string[];
  playerCount: number;
  leagueCount: number;
  recordCount: number;
  clipCount: number;
  teamSchemaVersion: number;
  /** 지금 앱이 읽을 수 없는 미래 스키마인가 */
  fromFuture: boolean;
}

export type BackupParse =
  | { ok: true; file: BackupFile; summary: BackupSummary }
  /** 사용자에게 그대로 보일 한국어 문구 */
  | { ok: false; message: string };

export function parseBackup(text: string, targetUid: string): BackupParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON 파일이 아닙니다.' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, message: '내용을 읽을 수 없습니다.' };

  const f = raw as Partial<BackupFile>;
  if (f.format !== BACKUP_FORMAT) {
    return { ok: false, message: 'Anyway Baseball 백업 파일이 아닙니다.' };
  }
  if (typeof f.envelope !== 'number' || f.envelope > BACKUP_ENVELOPE_VERSION) {
    return { ok: false, message: '더 새로운 버전에서 만든 백업입니다. 앱을 새로고침해 주세요.' };
  }
  const d = f.data;
  if (!d || !Array.isArray(d.teams) || !Array.isArray(d.leagues)) {
    return { ok: false, message: '백업 내용이 손상되었습니다.' };
  }

  const teamSchemaVersion = typeof f.teamSchemaVersion === 'number' ? f.teamSchemaVersion : 0;
  return {
    ok: true,
    file: f as BackupFile,
    summary: {
      exportedAt: typeof f.exportedAt === 'number' ? f.exportedAt : 0,
      uid: typeof f.uid === 'string' ? f.uid : '',
      sameAccount: f.uid === targetUid,
      teamNames: d.teams.filter((t) => t.ownerUid === f.uid).map((t) => t.name),
      playerCount: d.teams.reduce((a, t) => a + (t.players?.length ?? 0), 0),
      leagueCount: d.leagues.length,
      recordCount: d.records?.length ?? 0,
      clipCount: (d.records ?? []).reduce((a, r) => a + (r.clips?.length ?? 0), 0),
      teamSchemaVersion,
      // 내용물이 지금 코드보다 새로우면 마이그레이션으로도 못 내린다.
      fromFuture: teamSchemaVersion > TEAM_SCHEMA_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------
// 리타깃 — 이 파일의 유일한 난제
// ---------------------------------------------------------------------------

/**
 * 백업을 이 계정·이 기기의 것으로 갈아끼운다.
 *
 * 주 용도는 **게스트 → 구글 로그인 승격**과 기기 이전이다. 그냥 넣으면 두 가지가 깨진다.
 *
 * 1. `ownerUid`가 남의 것이라 listTeams / listLeagues의 소유자 필터에 전부 걸러진다.
 *    다음 새로고침에 통째로 사라진다.
 * 2. 같은 브라우저에 원래 주인의 문서가 남아 있으면 id가 부딪혀 서로를 덮어쓴다.
 *
 * 그래서 소유자를 바꾸고, **부딪히는 id만** 새로 만든다. `isTaken`은 "이 기기에 있고 내
 * 것이 아닌 id"를 뜻한다 — 안 부딪히면 id를 그대로 두므로 같은 계정 복구는 멱등이다.
 *
 * **`Player.id`는 바꾸지 않는다.** 팀 문서 안에서만 유효하고, Team.lineup / rotation과
 * GameRecord의 선수별 줄이 그대로 맞아떨어진다.
 */
export function retargetBackup(
  payload: BackupPayload,
  targetUid: string,
  sourceUid: string,
  isTaken: (id: string) => boolean,
): { payload: BackupPayload; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {};
  const used = new Set<string>();
  const claim = (id: string) => {
    if (idMap[id]) return idMap[id];
    // 결정론적 접미사. 같은 백업을 두 번 넣어도 같은 id가 나온다.
    // 이 백업 안에서 이미 쓴 id도 피한다 — 안 그러면 두 팀이 같은 새 id를 받는다.
    //
    // 상한을 두는 이유는 isTaken이 항상 true를 돌려주는 경우다. 그때 상한이 없으면
    // 브라우저가 그대로 멈춘다. 여기까지 왔다면 호출부가 잘못된 것이므로 더 버티지 않는다.
    let next = id;
    for (let n = 2; n < MAX_ID_ATTEMPTS && (isTaken(next) || used.has(next)); n++) {
      next = `${id}_i${n}`;
    }
    used.add(next);
    idMap[id] = next;
    return next;
  };

  // 소유자 교체 대상은 **원래 주인의 문서만**이다. 리그에 낀 CPU 팀(ownerUid: 'cpu')은
  // 그대로 둔다 — 소유자를 바꾸면 CPU 팀이 내 팀 목록에 나타난다.
  const mineTeam = (t: Team) => t.ownerUid === sourceUid;

  const teams = payload.teams.map((t) => {
    const id = claim(t.id);
    const ownerUid = mineTeam(t) ? targetUid : t.ownerUid;
    // **주인이나 id가 바뀌면 서명을 떼어 낸다.** 서명은 그 둘을 포함해 찍히므로
    // (@see game/integrity.economyFingerprint) 그대로 들고 가면 반드시 어긋나고,
    // 계정을 옮긴 것뿐인 정상 백업이 조작으로 잡혀 골드가 0이 된다. 새 주인의 문서는
    // 새로 서명받아야 하고, 그 일은 저장할 때 일어난다.
    //
    // undefined를 넣지 않고 키째 뺀다 — Firestore는 undefined 필드가 있는 문서를 거부한다.
    if (id === t.id && ownerUid === t.ownerUid) return t;
    const { seal: _drop, ...rest } = t;
    return { ...rest, id, ownerUid };
  });

  const leagues = payload.leagues.map((l) => retargetLeague(l, targetUid, sourceUid, claim));

  const records = payload.records.map((r) => ({
    ...r,
    leagueId: r.leagueId ? (idMap[r.leagueId] ?? r.leagueId) : r.leagueId,
    away: { ...r.away, teamId: idMap[r.away.teamId] ?? r.away.teamId },
    home: { ...r.home, teamId: idMap[r.home.teamId] ?? r.home.teamId },
  }));

  return {
    payload: {
      ...payload,
      teams,
      leagues,
      records,
      activeTeamId: payload.activeTeamId ? (idMap[payload.activeTeamId] ?? null) : null,
    },
    idMap,
  };
}

/**
 * 리그 안의 팀 참조를 전부 갈아끼운다.
 *
 * **`LeagueTeamRef.ownerUid`를 빠뜨리는 게 가장 흔한 함정이다.** 리그 화면과
 * league.relinkPlayerTeam이 "이 리그에 낀 내 팀"을 그 필드로 찾으므로, 문서 레벨만
 * 바꾸면 리그가 목록에는 보이는데 "내 팀이 참가하지 않은 리그"로 잠긴다.
 */
function retargetLeague(
  l: League,
  targetUid: string,
  sourceUid: string,
  claim: (id: string) => string,
): League {
  const t = (id: string) => claim(id);
  const opt = (id: string | undefined) => (id === undefined ? undefined : claim(id));
  const game = <G extends { awayTeamId: string; homeTeamId: string }>(g: G): G => ({
    ...g,
    awayTeamId: t(g.awayTeamId),
    homeTeamId: t(g.homeTeamId),
  });

  return {
    ...l,
    id: claim(l.id),
    ownerUid: l.ownerUid === sourceUid ? targetUid : l.ownerUid,
    teams: l.teams.map((ref) => ({
      ...ref,
      teamId: t(ref.teamId),
      ownerUid: ref.ownerUid === sourceUid ? targetUid : ref.ownerUid,
    })),
    cpuTeams: l.cpuTeams?.map((c) => ({ ...c, id: t(c.id) })),
    schedule: l.schedule.map(game),
    postseason: l.postseason && {
      ...l.postseason,
      championTeamId: opt(l.postseason.championTeamId),
      runnerUpTeamId: opt(l.postseason.runnerUpTeamId),
      series: l.postseason.series.map((s) => ({
        ...s,
        hiSeedId: t(s.hiSeedId),
        loSeedId: t(s.loSeedId),
        winnerId: opt(s.winnerId),
        games: s.games.map(game),
      })),
    },
  };
}
