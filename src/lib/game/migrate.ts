import { DEFAULT_SETTINGS, TEAM_SCHEMA_VERSION } from './types';
import type { GameSettings, League, Team } from './types';

/**
 * 저장된 문서를 지금 코드가 읽을 수 있는 형태로 올린다.
 *
 * 지금까지는 팀 문서의 `schemaVersion`이 안 맞으면 **아예 없는 셈 쳤다.** 티어/레벨 도입
 * 때는 그게 옳았지만, 그 뒤로는 아무도 그 값을 올리지 못했다 — 올리는 순간 모든 유저의
 * 팀이 조용히 사라지기 때문이다. 그래서 지난 열두 번의 스키마 변경이 전부 "선택 필드로
 * 몰래 추가"로 처리됐고, 언젠가 진짜 파괴적 변경이 필요해지면 쓸 수 있는 수단이 없었다.
 *
 * 이 파일은 그 수단이다. 버전을 올려도 기존 문서가 업그레이드되어 살아남는다.
 *
 * **순수 함수만 둔다.** localStorage도 Firestore도 import하지 않는다 — 그래야 저장소를
 * 흉내 내지 않고 단위 테스트할 수 있다.
 */

// ---------------------------------------------------------------------------
// 팀 문서
// ---------------------------------------------------------------------------

/** 저장돼 있던 그대로의 문서. 어느 버전인지 모르므로 Team으로 단정하지 않는다. */
export type TeamDoc = Record<string, unknown>;

export interface TeamMigration {
  /** 이 업그레이더의 출발 버전. from -> from + 1 로만 올린다 (건너뛰기 금지). */
  from: number;
  /** 왜 올렸는지 한 줄. 실패했을 때 사용자에게 그대로 보여 준다. */
  note: string;
  up(doc: TeamDoc): TeamDoc;
}

/**
 * 버전별 업그레이더.
 *
 * **지금은 비어 있다** — v2가 최신이라서다. TEAM_SCHEMA_VERSION을 3으로 올릴 때
 * `{ from: 2, note: '...', up }` 한 항목을 여기에 추가하면 v2 문서가 자동으로 따라온다.
 * 비어 있어도 체인 동작은 테스트로 고정돼 있다 (가짜 업그레이더를 주입해서 잰다).
 */
export const TEAM_MIGRATIONS: readonly TeamMigration[] = [];

export type SkipReason =
  /** 팀 문서의 형태가 아니다 */
  | 'CORRUPT'
  /** 더 새 버전에서 저장됐다 */
  | 'TOO_NEW'
  /** 여기까지 올려 줄 업그레이더가 없다 */
  | 'TOO_OLD'
  /** 업그레이더가 도중에 실패했다 */
  | 'FAILED';

export const SKIP_REASON_KO: Record<SkipReason, string> = {
  CORRUPT: '데이터가 손상되었습니다',
  TOO_NEW: '더 새로운 버전에서 저장되었습니다',
  TOO_OLD: '너무 오래된 형식입니다',
  FAILED: '변환에 실패했습니다',
};

export type TeamDocOutcome =
  /** migratedFrom이 null이면 손대지 않았다는 뜻이다 */
  | { ok: true; team: Team; migratedFrom: number | null }
  | { ok: false; reason: SkipReason; version: number | null; id: string | null; name: string | null };

/** 엔진에 넣어도 즉시 터지지 않을 최소 형태인지. 깊은 검증은 하지 않는다 (비용). */
export function isTeamShaped(doc: unknown): doc is Team {
  if (!doc || typeof doc !== 'object') return false;
  const t = doc as Partial<Team>;
  return (
    typeof t.id === 'string' &&
    typeof t.ownerUid === 'string' &&
    typeof t.name === 'string' &&
    Array.isArray(t.players) &&
    t.players.length > 0 &&
    Array.isArray(t.lineup) &&
    Array.isArray(t.rotation)
  );
}

function versionOf(doc: unknown): number | null {
  if (!doc || typeof doc !== 'object') return null;
  const v = (doc as TeamDoc).schemaVersion;
  return typeof v === 'number' ? v : null;
}

function labelOf(doc: unknown): { id: string | null; name: string | null } {
  const d = (doc ?? {}) as TeamDoc;
  return {
    id: typeof d.id === 'string' ? d.id : null,
    name: typeof d.name === 'string' ? d.name : null,
  };
}

/**
 * 팀 문서를 목표 버전까지 끌어올린다.
 *
 * migrations와 target을 인자로 받는 이유는 레지스트리가 빈 지금도 체인 동작을 테스트할 수
 * 있게 하기 위해서다. 실제 호출부는 기본값을 그대로 쓴다.
 *
 * **버전이 미래면 절대 손대지 않는다** (TOO_NEW). 억지로 읽고 되쓰면, 최신 기기에서 만든
 * 팀을 열어 둔 낡은 탭이 덮어써 데이터가 실제로 사라진다.
 */
export function migrateTeamDoc(
  raw: unknown,
  migrations: readonly TeamMigration[] = TEAM_MIGRATIONS,
  target: number = TEAM_SCHEMA_VERSION,
): TeamDocOutcome {
  const label = labelOf(raw);
  const version = versionOf(raw);
  if (version === null) return { ok: false, reason: 'CORRUPT', version: null, ...label };
  if (version > target) return { ok: false, reason: 'TOO_NEW', version, ...label };

  let doc = raw as TeamDoc;
  let at = version;
  while (at < target) {
    const step = migrations.find((m) => m.from === at);
    if (!step) return { ok: false, reason: 'TOO_OLD', version: at, ...labelOf(doc) };
    try {
      doc = { ...step.up(doc), schemaVersion: at + 1 };
    } catch {
      return { ok: false, reason: 'FAILED', version: at, ...labelOf(doc) };
    }
    at += 1;
  }

  if (!isTeamShaped(doc)) return { ok: false, reason: 'CORRUPT', version: at, ...labelOf(doc) };
  return { ok: true, team: normalizeTeam(doc), migratedFrom: version === target ? null : version };
}

/**
 * 팀 단위 스칼라의 기본값만 채운다.
 *
 * **선수별 선택 필드(career / seasonLog / splits / spentGold)는 채우지 않는다.** 46명 ×
 * 빈 SeasonStat이면 팀 문서가 5~10KB 늘어 localStorage 5MB 한계와 클립 저장에 그대로
 * 압력이 간다. 그 필드들은 이미 읽는 쪽이 `??`로 정규화한다 (season.careerOf 등).
 */
export function normalizeTeam(team: Team): Team {
  const seasonNo = typeof team.seasonNo === 'number' ? team.seasonNo : 1;
  const inventory = team.inventory ?? {};
  if (team.seasonNo === seasonNo && team.inventory === inventory) return team;
  return { ...team, seasonNo, inventory };
}

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

/**
 * 저장된 설정을 지금 형태로 올린다. store.loadSettings의 본문을 순수 함수로 뽑은 것이다.
 *
 * 리그 문서 안의 GameSettings도 같은 처리가 필요해서 밖으로 꺼냈다 — 거기는 지금까지
 * 아무 정규화도 지나지 않아, pitchSpeedScale이 없던 시절 리그를 열면 undefined가 그대로
 * 궤적 계산에 들어가 NaN이 된다.
 */
export function normalizeSettings(saved: unknown): GameSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<GameSettings> & {
    soundEnabled?: boolean;
  };
  // soundEnabled 하나만 있던 이전 저장값은 세 채널 스위치로 마이그레이션한다.
  // 당시 bgmVolume은 실제로 관중 볼륨에 쓰였으므로 crowdVolume의 초기값으로도 보존한다.
  const { soundEnabled: legacyEnabled, ...current } = s;
  const enabled = legacyEnabled ?? true;
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    sfxEnabled: s.sfxEnabled ?? enabled,
    crowdEnabled: s.crowdEnabled ?? enabled,
    bgmEnabled: s.bgmEnabled ?? enabled,
    crowdVolume: s.crowdVolume ?? s.bgmVolume ?? DEFAULT_SETTINGS.crowdVolume,
  };
}

// ---------------------------------------------------------------------------
// 리그 문서
// ---------------------------------------------------------------------------

/**
 * **리그에는 스키마 버전을 두지 않는다.**
 *
 * 팀은 "못 읽으면 재창단"이라는 탈출구가 있지만 리그는 없다 — 시즌 승패·포스트시즌 대진·
 * 보상 지급 표식이 통째로 날아가고, 복구 수단이 relinkPlayerTeam 하나뿐이다. 게다가
 * 지금까지 League 변경은 전부 가산적이었으므로(cpuTeams / postseason / rewardedAt)
 * 버전 게이트가 막아 낼 위험이 실재한 적이 없다.
 *
 * 대신 정책을 못 박는다: **리그는 파괴적 변경을 하지 않는다.** 필드를 바꿔야 하면 새
 * 필드를 추가하고 옛 필드는 읽기 전용으로 남긴다(expand → migrate → contract).
 * 함수 안에 흩어져 있던 정규화는 아래 목록으로 모은다 — 순서 있는 멱등 함수들이다.
 */
export interface LeagueContext {
  /** 이 기기에 캐시된 팀. store가 localStorage 조회를 넣어 준다. */
  lookupTeam(id: string): Team | null;
}

export interface LeagueNormalizeResult {
  league: League;
  /** 리그에서 복원해 캐시에 되살려야 하는 CPU 팀 */
  restoredTeams: Team[];
  /** 원본과 달라졌는가. 원격 재기록 여부의 판단 근거다. */
  changed: boolean;
}

type LeagueNormalizer = (l: League, ctx: LeagueContext, out: Team[]) => League;

/**
 * 리그 문서에 순서대로 적용하는 정규화. 전부 멱등이어야 한다 —
 * 저장할 때마다 돌기 때문에 한 번 더 돌아도 같은 결과가 나와야 한다.
 */
const LEAGUE_NORMALIZERS: readonly LeagueNormalizer[] = [
  // 1) 설정 정규화. 여기가 비면 pitchSpeedScale이 undefined인 채 엔진에 들어간다.
  (l) => {
    const settings = normalizeSettings(l.settings);
    const same = (Object.keys(settings) as (keyof GameSettings)[]).every(
      (k) => l.settings?.[k] === settings[k],
    );
    return same ? l : { ...l, settings };
  },
  // 2) 구버전 리그의 CPU 팀을 로컬 캐시에서 복원해 문서에 박제한다.
  //    하나라도 못 찾으면 통째로 비운다 — 반쪽짜리 cpuTeams는 "일부 경기만 재현되는"
  //    상태를 만들어 없느니만 못하다.
  (l, ctx, out) => {
    const embedded = new Map((l.cpuTeams ?? []).map((t) => [t.id, t]));
    const cpuIds = l.teams.filter((t) => t.isCPU).map((t) => t.teamId);
    if (!cpuIds.length) return l;

    const resolved: Team[] = [];
    for (const id of cpuIds) {
      const found = embedded.get(id) ?? ctx.lookupTeam(id);
      if (!found) return l.cpuTeams ? { ...l, cpuTeams: undefined } : l;
      resolved.push(found);
      // 문서에만 있고 캐시에 없는 팀은 캐시로 되돌려 준다 (다른 기기에서 열었을 때).
      if (!ctx.lookupTeam(id)) out.push(found);
    }
    const same =
      l.cpuTeams?.length === resolved.length && resolved.every((t, i) => l.cpuTeams![i] === t);
    return same ? l : { ...l, cpuTeams: resolved };
  },
];

/** 리그 문서를 정규화한다. 형태가 아예 깨졌으면 null. */
export function normalizeLeague(raw: unknown, ctx: LeagueContext): LeagueNormalizeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as League;
  if (typeof src.id !== 'string' || !Array.isArray(src.teams) || !Array.isArray(src.schedule)) {
    return null;
  }

  const restoredTeams: Team[] = [];
  let league = src;
  for (const step of LEAGUE_NORMALIZERS) league = step(league, ctx, restoredTeams);
  return { league, restoredTeams, changed: league !== src };
}
