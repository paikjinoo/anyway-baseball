'use client';

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from 'firebase/firestore';
import { getDb, firebaseConfigured } from './client';
import type { GameRecord } from '../game/record';
import type { GameSettings, League, Team } from '../game/types';
import { repairTeam } from '../game/season';
import {
  migrateTeamDoc,
  normalizeLeague,
  normalizeSettings,
  type SkipReason,
} from '../game/migrate';
import type { BackupPayload } from '../game/backup';
import {
  readSuspendedMatch,
  trimSuspendedMatches,
  type SuspendedMatch,
} from '../game/resume';
import { ONLINE_DAILY_EXP_CAP, ONLINE_DAILY_GOLD_CAP } from '../game/onlineCap';

/**
 * 팀 / 리그 / 설정 저장소.
 *
 * Firestore 사용량을 최소로 유지하기 위해, 실제 경기 중에는 여기에 전혀 쓰지 않는다.
 * 쓰기가 발생하는 시점은 팀 저장, 훈련 결과 저장, 리그 경기 결과 기록뿐이다.
 * Firebase가 설정되지 않은 환경에서는 localStorage로 동일한 API를 제공한다.
 */

const LS_TEAMS = 'ab:teams';
const LS_LEAGUES = 'ab:leagues';
const LS_SETTINGS = 'ab:settings';
const LS_NICKNAME = 'ab:nickname';
const LS_ONLINE_REWARD = 'ab:onlineRewardDaily';
const LS_RECORDS = 'ab:gameRecords';
const LS_SUSPENDED = 'ab:suspendedMatches';

function lsRead<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 저장에 성공했는지 돌려준다. 용량을 스스로 줄여야 하는 쪽(경기 기록)이 이 값을 본다. */
function lsWrite(key: string, value: unknown): boolean {
  if (typeof window === 'undefined') return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // 용량 초과 등은 무시한다
    return false;
  }
}

/** 로컬 작업을 막지 않는 최선 노력 원격 동기화. 실패 데이터는 로컬 캐시에 남는다. */
function syncRemote(task: () => Promise<unknown>) {
  try {
    void task().catch(() => {});
  } catch {
    // SDK 초기화/네트워크 오류가 동기적으로 나도 로컬 저장은 이미 끝났다.
  }
}

// ---------------------------------------------------------------------------
// 팀
// ---------------------------------------------------------------------------

/** 읽지 못한 문서 하나. 사용자에게 왜 안 보이는지 설명하는 데 쓴다. */
export interface SkippedDoc {
  id: string | null;
  name: string | null;
  version: number | null;
  reason: SkipReason;
}

export interface TeamLoadReport {
  teams: Team[];
  /** 스키마가 안 맞아 목록에서 빠진 문서들. 원본은 지우지 않는다. */
  skipped: SkippedDoc[];
  /** 이번 로드에서 업그레이드된 팀 수 */
  migrated: number;
}

/**
 * 저장소에서 읽은 팀 문서를 쓸 수 있는 형태로 만든다.
 * **팀을 돌려주는 모든 경로가 여기를 지난다** — 반환 지점마다 흩어 놓으면 반드시 어딘가 빠진다.
 *
 * 1) 스키마 버전을 목표까지 끌어올리고 (@see game/migrate.migrateTeamDoc)
 * 2) 이중 집계로 부푼 스플릿을 걷어낸다 (@see game/season.repairTeam)
 */
function readTeamDoc(raw: unknown): { team: Team | null; skipped: SkippedDoc | null; migratedFrom: number | null } {
  if (!raw) return { team: null, skipped: null, migratedFrom: null };
  const out = migrateTeamDoc(raw);
  if (!out.ok) {
    return {
      team: null,
      skipped: { id: out.id, name: out.name, version: out.version, reason: out.reason },
      migratedFrom: null,
    };
  }
  return { team: repairTeam(out.team), skipped: null, migratedFrom: out.migratedFrom };
}

/** 팀 하나만 필요할 때. 못 읽으면 null이다. */
function readTeam(raw: unknown): Team | null {
  return readTeamDoc(raw).team;
}

export async function saveTeam(team: Team): Promise<void> {
  const next = { ...team, updatedAt: Date.now() };
  // 네트워크와 무관하게 로컬 저장을 먼저 완료한다.
  const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
  all[team.id] = next;
  lsWrite(LS_TEAMS, all);
  const db = getDb();
  if (firebaseConfigured && db) syncRemote(() => setDoc(doc(db, 'teams', team.id), next));
}

export async function loadTeam(teamId: string): Promise<Team | null> {
  const cached = lsRead<Record<string, Team>>(LS_TEAMS, {})[teamId];
  if (cached) return readTeam(cached);
  const db = getDb();
  if (firebaseConfigured && db) {
    try {
      const snap = await getDoc(doc(db, 'teams', teamId));
      if (snap.exists()) {
        const team = readTeam(snap.data() as Team);
        if (!team) return null;
        const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
        all[team.id] = team;
        lsWrite(LS_TEAMS, all);
        return team;
      }
    } catch {
      // 원격 실패 시 아래의 null/캐시 결과를 사용한다.
    }
  }
  return null;
}

/** 원격 우선으로 최신 팀을 가져온다 (다른 기기에서 수정했을 수 있음) */
export async function fetchTeamFresh(teamId: string): Promise<Team | null> {
  const cached = lsRead<Record<string, Team>>(LS_TEAMS, {})[teamId] ?? null;
  const db = getDb();
  if (firebaseConfigured && db) {
    try {
      const snap = await getDoc(doc(db, 'teams', teamId));
      if (snap.exists()) {
        const t = readTeam(snap.data() as Team);
        if (!t) return null;
        const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
        all[t.id] = t;
        lsWrite(LS_TEAMS, all);
        return t;
      }
    } catch {
      // 캐시 폴백
    }
  }
  return readTeam(cached);
}

export async function listTeams(uid: string): Promise<Team[]> {
  return (await listTeamsReport(uid)).teams;
}

/**
 * 팀 목록 + 읽지 못한 문서 목록.
 *
 * 지금까지는 스키마가 안 맞는 팀이 **아무 설명 없이 사라졌다** — 사용자 화면에서는 창단
 * 온보딩으로 떨어질 뿐이라 데이터가 그냥 없어진 것처럼 보였다. 무엇이 왜 빠졌는지 돌려준다.
 */
export async function listTeamsReport(uid: string): Promise<TeamLoadReport> {
  const db = getDb();
  if (firebaseConfigured && db) {
    try {
      const q = query(collection(db, 'teams'), where('ownerUid', '==', uid));
      const snap = await getDocs(q);
      const teams = snap.docs.map((d) => d.data() as Team);
      const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
      for (const t of teams) {
        if (!all[t.id] || t.updatedAt >= all[t.id].updatedAt) all[t.id] = t;
      }
      const report = ownedTeams(all, uid);
      // 업그레이드된 문서는 캐시에 되쓴다. 다음 로드부터는 변환 비용이 들지 않는다.
      for (const t of report.teams) all[t.id] = t;
      lsWrite(LS_TEAMS, all);
      // **updatedAt은 올리지 않는다.** listTeams의 LWW 병합이 왜곡된다 —
      // 마이그레이션은 형태 변환일 뿐 "새 저장"이 아니다.
      if (report.migrated > 0) {
        for (const t of report.teams) syncRemote(() => setDoc(doc(db, 'teams', t.id), t));
      }
      return report;
    } catch {
      // 캐시 폴백
    }
  }
  return ownedTeams(lsRead<Record<string, Team>>(LS_TEAMS, {}), uid);
}

function ownedTeams(all: Record<string, Team>, uid: string): TeamLoadReport {
  const out: TeamLoadReport = { teams: [], skipped: [], migrated: 0 };
  for (const raw of Object.values(all)) {
    if (raw?.ownerUid !== uid) continue;
    const r = readTeamDoc(raw);
    if (r.team) {
      out.teams.push(r.team);
      if (r.migratedFrom !== null) out.migrated += 1;
    } else if (r.skipped) {
      out.skipped.push(r.skipped);
    }
  }
  return out;
}

export async function deleteTeam(teamId: string): Promise<void> {
  const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
  delete all[teamId];
  lsWrite(LS_TEAMS, all);
  const db = getDb();
  if (firebaseConfigured && db) syncRemote(() => deleteDoc(doc(db, 'teams', teamId)));
}

/** CPU 팀 등 소유자가 없는 팀도 로컬에 보관한다 */
export function cacheTeamLocal(team: Team) {
  const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
  all[team.id] = team;
  lsWrite(LS_TEAMS, all);
}

/**
 * 캐시에 있는 팀. 리그의 CPU 팀이 이 경로로 나간다.
 *
 * 여기도 readTeamDoc을 지나야 한다 — 안 그러면 "내 팀은 업그레이드됐는데 CPU 팀은
 * 구버전"인 상태로 엔진에 들어가 능력치 상한과 라인업 검증이 조용히 어긋난다.
 */
export function getCachedTeam(teamId: string): Team | null {
  return readTeam(lsRead<Record<string, Team>>(LS_TEAMS, {})[teamId]);
}

// ---------------------------------------------------------------------------
// 리그
// ---------------------------------------------------------------------------

/**
 * 리그 문서 정규화. 규칙은 game/migrate에 있고 여기서는 저장소 조회만 주입한다.
 *
 * 순수 함수 쪽은 "무엇을 복원해야 하는지"만 돌려주므로, 캐시에 되쓰는 부수효과는
 * 반드시 여기서 해야 한다 — 빠뜨리면 CPU 팀 캐시 복원이 조용히 죽는다.
 */
function hydrateLeagueCpuTeams(league: League): League {
  const res = normalizeLeague(league, {
    lookupTeam: (id) => readTeam(lsRead<Record<string, Team>>(LS_TEAMS, {})[id]),
  });
  if (!res) return league;
  if (res.restoredTeams.length) {
    const allTeams = lsRead<Record<string, Team>>(LS_TEAMS, {});
    for (const t of res.restoredTeams) allTeams[t.id] = t;
    lsWrite(LS_TEAMS, allTeams);
  }
  return res.league;
}

export async function saveLeague(league: League): Promise<void> {
  const next = hydrateLeagueCpuTeams(league);
  const all = lsRead<Record<string, League>>(LS_LEAGUES, {});
  all[next.id] = next;
  lsWrite(LS_LEAGUES, all);
  const db = getDb();
  if (firebaseConfigured && db) syncRemote(() => setDoc(doc(db, 'leagues', next.id), next));
}

export async function listLeagues(uid: string): Promise<League[]> {
  const db = getDb();
  if (firebaseConfigured && db) {
    try {
      const q = query(collection(db, 'leagues'), where('ownerUid', '==', uid));
      const snap = await getDocs(q);
      const leagues = snap.docs.map((d) => d.data() as League);
      const all = lsRead<Record<string, League>>(LS_LEAGUES, {});
      for (const league of leagues) {
        const cached = all[league.id];
        const withCachedTeams =
          !league.cpuTeams?.length && cached?.cpuTeams?.length
            ? { ...league, cpuTeams: cached.cpuTeams }
            : league;
        const hydrated = hydrateLeagueCpuTeams(withCachedTeams);
        all[league.id] = hydrated;
        if (!league.cpuTeams?.length && hydrated.cpuTeams?.length) {
          // 원본 브라우저에서 구버전 리그를 한 번 불러오기만 해도 원격 문서를 자동 승격한다.
          syncRemote(() => setDoc(doc(db, 'leagues', hydrated.id), hydrated));
        }
      }
      lsWrite(LS_LEAGUES, all);
      return Object.values(all)
        .filter((l) => l.ownerUid === uid)
        .map(hydrateLeagueCpuTeams);
    } catch {
      // 캐시 폴백
    }
  }
  return Object.values(lsRead<Record<string, League>>(LS_LEAGUES, {}))
    .filter((l) => l.ownerUid === uid)
    .map(hydrateLeagueCpuTeams);
}

export function getCachedLeague(id: string): League | null {
  return lsRead<Record<string, League>>(LS_LEAGUES, {})[id] ?? null;
}

export async function deleteLeague(id: string): Promise<void> {
  const all = lsRead<Record<string, League>>(LS_LEAGUES, {});
  const league = all[id];
  delete all[id];
  lsWrite(LS_LEAGUES, all);
  if (league) {
    const allTeams = lsRead<Record<string, Team>>(LS_TEAMS, {});
    const stillUsed = new Set(
      Object.values(all).flatMap((other) =>
        other.teams.filter((ref) => ref.isCPU).map((ref) => ref.teamId),
      ),
    );
    for (const ref of league.teams) {
      if (ref.isCPU && !stillUsed.has(ref.teamId)) delete allTeams[ref.teamId];
    }
    lsWrite(LS_TEAMS, allTeams);
  }
  const db = getDb();
  if (firebaseConfigured && db) syncRemote(() => deleteDoc(doc(db, 'leagues', id)));
}

// ---------------------------------------------------------------------------
// 경기 기록 (박스스코어) — 이 기기에만 남는다
//
// **Firestore에 쓰지 않는다.** README가 "경기 1회당 Firestore 쓰기 0"을 약속하고 있고,
// 박스스코어는 경기마다 반드시 생기므로 여기에 원격 동기화를 붙이면 그 약속이 통째로
// 깨진다. 기록이 사라져도 리그 순위와 팀 데이터는 멀쩡하다 — 잃어도 되는 데이터라서
// 로컬에만 두는 것이다.
// ---------------------------------------------------------------------------

/** 보관할 경기 수. 넘치면 오래된 것부터 버린다. */
export const RECORD_LIMIT = 60;
/**
 * 다시 보기 클립을 남길 최근 경기 수.
 *
 * 클립 하나가 GameState를 통째로 품고 있어(로스터 46명) 수십 KB다. localStorage는
 * 보통 5MB뿐이라 전 경기에 남기면 다른 저장(팀·리그)까지 밀어낸다.
 */
export const CLIP_GAME_LIMIT = 3;

function trimRecords(list: GameRecord[]): GameRecord[] {
  return list
    .slice(0, RECORD_LIMIT)
    .map((r, i) => (i < CLIP_GAME_LIMIT ? r : r.clips ? { ...r, clips: undefined } : r));
}

/**
 * 경기 기록 저장. 최신순으로 쌓고 용량을 스스로 관리한다.
 *
 * 용량이 넘치면 **클립부터 버린다.** 박스스코어는 KB 단위지만 클립은 그 수십 배라,
 * 둘 중 하나만 남길 수 있다면 남길 것은 기록 쪽이다.
 */
export function saveGameRecord(rec: GameRecord): void {
  const list = [rec, ...lsRead<GameRecord[]>(LS_RECORDS, []).filter((r) => r.id !== rec.id)];

  if (lsWrite(LS_RECORDS, trimRecords(list))) return;

  // 1차 폴백: 클립을 전부 버리고 박스스코어만 남긴다.
  const noClips = list.map((r) => (r.clips ? { ...r, clips: undefined } : r));
  if (lsWrite(LS_RECORDS, noClips)) return;

  // 2차 폴백: 보관 경기 수를 줄인다. 그래도 안 되면 조용히 포기한다.
  lsWrite(LS_RECORDS, noClips.slice(0, 10));
}

/** 최신순 경기 기록. leagueId를 주면 그 리그 경기만 고른다. */
export function listGameRecords(leagueId?: string): GameRecord[] {
  const all = lsRead<GameRecord[]>(LS_RECORDS, []);
  return leagueId ? all.filter((r) => r.leagueId === leagueId) : all;
}

/** 리그 일정의 한 경기에 해당하는 기록. 같은 경기를 다시 치렀으면 가장 최근 것. */
export function findLeagueGameRecord(leagueId: string, gameId: string): GameRecord | null {
  return (
    lsRead<GameRecord[]>(LS_RECORDS, []).find(
      (r) => r.leagueId === leagueId && r.leagueGameId === gameId,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// 중단된 경기 (이어서 하기) — 이 기기에만 남는다
//
// **Firestore에 쓰지 않는다.** 이 문서는 매 투구마다 다시 쓰이므로 원격 동기화를 붙이면
// "경기 1회당 Firestore 쓰기 0"이라는 약속이 경기 한 번에 수백 번 깨진다.
// 기기를 옮기면 이어서 할 수 없다는 뜻이지만, 그 대가로 경기 중 통신이 0으로 유지된다.
// ---------------------------------------------------------------------------

function suspendedSlot(uid: string, key: string): string {
  return `${uid}|${key}`;
}

function readSuspendedAll(): Record<string, SuspendedMatch> {
  const raw = lsRead<Record<string, unknown>>(LS_SUSPENDED, {});
  const out: Record<string, SuspendedMatch> = {};
  for (const [slot, doc] of Object.entries(raw)) {
    const parsed = readSuspendedMatch(doc);
    // 형식이 다르면(구버전·손상) 조용히 버린다. 이어서 하기는 잃어도 되는 데이터다.
    if (parsed) out[slot] = parsed;
  }
  return out;
}

/**
 * 진행 중인 경기 저장. 슬롯이 넘치면 오래된 경기부터 버린다.
 *
 * 용량이 모자라면 **다른 슬롯을 버리고 지금 경기만 남긴다** — 지금 치르고 있는 경기가
 * 예전에 중단한 경기보다 언제나 중요하다.
 */
export function saveSuspendedMatch(m: SuspendedMatch): void {
  const all = readSuspendedAll();
  all[suspendedSlot(m.uid, m.key)] = m;
  if (lsWrite(LS_SUSPENDED, trimSuspendedMatches(all))) return;
  lsWrite(LS_SUSPENDED, { [suspendedSlot(m.uid, m.key)]: m });
}

/** 그 슬롯의 중단 경기. 없거나 형식이 다르면 null이다. */
export function loadSuspendedMatch(uid: string, key: string): SuspendedMatch | null {
  return readSuspendedAll()[suspendedSlot(uid, key)] ?? null;
}

/** 이 계정의 중단 경기 목록. 최근에 저장한 것부터. */
export function listSuspendedMatches(uid: string): SuspendedMatch[] {
  return Object.values(readSuspendedAll())
    .filter((m) => m.uid === uid)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function clearSuspendedMatch(uid: string, key: string): void {
  const all = readSuspendedAll();
  const slot = suspendedSlot(uid, key);
  if (!(slot in all)) return;
  delete all[slot];
  lsWrite(LS_SUSPENDED, all);
}

// ---------------------------------------------------------------------------
// 감독 닉네임 (계정별 — 기기 간 동기화)
//
// 온라인 대전에서 상대에게 보이는 이름이다. 구글 계정 이름을 그대로 쓰면 실명이
// 노출되고 바꿀 수도 없어서, 계정 이름 위에 덮어쓰는 별명을 따로 둔다.
// 설정과 달리 기기별이 아니라 계정에 붙으므로 profiles/{uid}로 동기화한다.
// ---------------------------------------------------------------------------

export const NICKNAME_MAX = 12;

/** 앞뒤·연속 공백을 정리하고 길이를 제한한다. 빈 문자열이면 닉네임 해제로 본다. */
export function normalizeNickname(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, NICKNAME_MAX);
}

/** 이 기기에 저장된 닉네임. 계정마다 따로 기억한다. */
export function loadNickname(uid: string): string | null {
  const saved = lsRead<Record<string, string>>(LS_NICKNAME, {})[uid];
  return saved ? saved : null;
}

/**
 * 닉네임 저장. null이면 해제하고 계정 이름으로 돌아간다.
 * remote=false(게스트)면 로컬에만 남긴다 — 게스트 uid는 Firebase 인증이 없어 규칙에 막힌다.
 */
export function saveNickname(uid: string, nickname: string | null, remote = true) {
  const all = lsRead<Record<string, string>>(LS_NICKNAME, {});
  if (nickname) all[uid] = nickname;
  else delete all[uid];
  lsWrite(LS_NICKNAME, all);

  const db = getDb();
  if (!remote || !firebaseConfigured || !db) return;
  syncRemote(() =>
    setDoc(doc(db, 'profiles', uid), { uid, nickname: nickname ?? '', updatedAt: Date.now() }),
  );
}

/** 다른 기기에서 정한 닉네임을 가져온다. 실패하면 로컬 값을 그대로 쓴다. */
export async function fetchNickname(uid: string): Promise<string | null> {
  const db = getDb();
  if (!firebaseConfigured || !db) return loadNickname(uid);
  try {
    const snap = await getDoc(doc(db, 'profiles', uid));
    if (!snap.exists()) return loadNickname(uid);
    const remote = normalizeNickname(String((snap.data() as { nickname?: unknown }).nickname ?? ''));
    // 원격을 로컬 캐시에도 반영해 다음 로그인부터는 깜빡임 없이 뜨게 한다.
    const all = lsRead<Record<string, string>>(LS_NICKNAME, {});
    if (remote) all[uid] = remote;
    else delete all[uid];
    lsWrite(LS_NICKNAME, all);
    return remote || null;
  } catch {
    return loadNickname(uid);
  }
}

// ---------------------------------------------------------------------------
// 게임 설정 (로컬 전용 — 기기별 설정)
// ---------------------------------------------------------------------------

export function loadSettings(): GameSettings {
  return normalizeSettings(lsRead<unknown>(LS_SETTINGS, {}));
}

export function saveSettings(s: GameSettings) {
  lsWrite(LS_SETTINGS, s);
}

// ---------------------------------------------------------------------------
// 온라인 대전 일일 보상 한도 (기기별 로컬 원장)
//
// 한도의 목적은 "서로 짜고 하루 종일 보상을 찍어내는 것"을 막는 것이다.
// 판정이 클라이언트에 있는 게임이라 이 원장도 로컬에 둔다 — 브라우저 데이터를
// 지우면 초기화되지만, 그건 팀·선수 데이터도 마찬가지다.
// 서버 검증 없이 막을 수 있는 선이 여기까지라는 점을 알고 쓰는 장치다.
//
// 골드와 경험치는 쓰임이 달라(티어 강화 vs 레벨업) 한도를 따로 센다.
// ---------------------------------------------------------------------------

interface DailyRewardRow {
  /** 로컬 시간 기준 YYYY-MM-DD */
  date: string;
  gold: number;
  exp: number;
}

/** 한 경기에서 요청하는 보상량 */
export interface OnlineRewardRequest {
  gold: number;
  exp: number;
}

export interface OnlineRewardClaim {
  /** 실제로 지급된 양. 한도에 걸리면 요청보다 적다. */
  granted: OnlineRewardRequest;
  /** 지급 후 오늘 누계 */
  usedToday: OnlineRewardRequest;
  cap: OnlineRewardRequest;
}

const EMPTY_ROW: Omit<DailyRewardRow, 'date'> = { gold: 0, exp: 0 };

/** 로컬 시간 기준 날짜 키. 한도는 플레이어가 사는 곳의 자정에 풀린다. */
function todayKey(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** 오늘 이 계정이 온라인 대전으로 이미 받은 양 */
export function onlineRewardUsedToday(uid: string): OnlineRewardRequest {
  const row = lsRead<Record<string, DailyRewardRow>>(LS_ONLINE_REWARD, {})[uid];
  if (row?.date !== todayKey()) return { ...EMPTY_ROW };
  return { gold: row.gold ?? 0, exp: row.exp ?? 0 };
}

export const ONLINE_REWARD_CAP: OnlineRewardRequest = {
  gold: ONLINE_DAILY_GOLD_CAP,
  exp: ONLINE_DAILY_EXP_CAP,
};

/** 오늘 남은 온라인 보상 한도 */
export function onlineRewardRemaining(uid: string): OnlineRewardRequest {
  const used = onlineRewardUsedToday(uid);
  return {
    gold: Math.max(0, ONLINE_DAILY_GOLD_CAP - used.gold),
    exp: Math.max(0, ONLINE_DAILY_EXP_CAP - used.exp),
  };
}

/**
 * 한도 안에서 보상을 확정하고 실제 지급량을 돌려준다.
 * 읽기·계산·쓰기를 한 번에 처리하므로 호출한 쪽이 한도를 따로 볼 필요가 없다.
 */
export function claimOnlineReward(uid: string, requested: OnlineRewardRequest): OnlineRewardClaim {
  const used = onlineRewardUsedToday(uid);
  const granted: OnlineRewardRequest = {
    gold: Math.max(0, Math.min(Math.round(requested.gold), ONLINE_DAILY_GOLD_CAP - used.gold)),
    exp: Math.max(0, Math.min(Math.round(requested.exp), ONLINE_DAILY_EXP_CAP - used.exp)),
  };
  const usedToday: OnlineRewardRequest = {
    gold: used.gold + granted.gold,
    exp: used.exp + granted.exp,
  };

  const today = todayKey();
  const all = lsRead<Record<string, DailyRewardRow>>(LS_ONLINE_REWARD, {});
  // 어제 이전 기록은 남겨 둘 이유가 없다 (계정을 바꿔 가며 쓰면 계속 쌓인다)
  for (const [key, row] of Object.entries(all)) {
    if (row?.date !== today) delete all[key];
  }
  all[uid] = { date: today, ...usedToday };
  lsWrite(LS_ONLINE_REWARD, all);

  return { granted, usedToday, cap: ONLINE_REWARD_CAP };
}

// ---------------------------------------------------------------------------
// 백업 (내보내기 / 가져오기)
//
// 규칙은 game/backup에 있고 여기서는 저장소 입출력만 한다.
// ---------------------------------------------------------------------------

/**
 * 백업에 담을 것을 모은다.
 *
 * **스키마로 거르지 않는다.** 지금 코드가 못 읽는 팀도 백업에는 원본이 들어가야 한다 —
 * 나중에 마이그레이션이 생기면 되살아날 데이터를 백업이 먼저 지워 버리면 안 된다.
 *
 * 내 팀뿐 아니라 **내 리그가 참조하는 CPU 팀까지** 담는다. 옛 리그(cpuTeams 없음)를
 * 다른 기기에서 되살리려면 그게 유일한 출처다.
 */
export function exportSnapshot(uid: string, opt: { includeClips: boolean }): BackupPayload {
  const allTeams = lsRead<Record<string, Team>>(LS_TEAMS, {});
  const allLeagues = lsRead<Record<string, League>>(LS_LEAGUES, {});

  const leagues = Object.values(allLeagues).filter((l) => l.ownerUid === uid);
  const wanted = new Set<string>();
  for (const t of Object.values(allTeams)) if (t.ownerUid === uid) wanted.add(t.id);
  for (const l of leagues) for (const ref of l.teams) wanted.add(ref.teamId);

  const records = lsRead<GameRecord[]>(LS_RECORDS, []);
  return {
    teams: [...wanted].map((id) => allTeams[id]).filter(Boolean),
    leagues,
    settings: loadSettings(),
    records: opt.includeClips ? records : records.map((r) => (r.clips ? { ...r, clips: undefined } : r)),
    activeTeamId: typeof window === 'undefined' ? null : localStorage.getItem('ab:activeTeam'),
    nickname: loadNickname(uid),
  };
}

/** 이 기기에 이미 있고 uid의 것이 아닌 팀·리그 id. 리타깃의 충돌 판정에 쓴다. */
export function takenIds(uid: string): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(lsRead<Record<string, Team>>(LS_TEAMS, {}))) {
    if (t.ownerUid !== uid) out.add(t.id);
  }
  for (const l of Object.values(lsRead<Record<string, League>>(LS_LEAGUES, {}))) {
    if (l.ownerUid !== uid) out.add(l.id);
  }
  return out;
}

export interface ImportResult {
  teams: Team[];
  leagues: League[];
  activeTeamId: string | null;
  recordCount: number;
  /** 가져오는 도중 업그레이드된 팀 수 */
  migrated: number;
  skipped: SkippedDoc[];
}

/**
 * 이 계정의 팀·리그를 payload로 **통째로 교체한다.**
 *
 * 병합하지 않는 이유는 "한 계정 한 팀" 규칙 때문이다 — 골드와 인벤토리가 팀에 붙어 있어서
 * 팀이 둘이 되면 지갑이 늘어난다.
 *
 * 기록만은 병합한다. `ab:gameRecords`는 계정 개념이 없는 기기 전역 링버퍼라, 교체하면
 * 다른 계정으로 치른 경기까지 날아간다.
 */
export async function importSnapshot(payload: BackupPayload, uid: string): Promise<ImportResult> {
  // 1) 이 계정의 기존 문서를 지운다. **리그를 먼저** — deleteLeague가 안 쓰는 CPU 팀도 정리한다.
  for (const l of Object.values(lsRead<Record<string, League>>(LS_LEAGUES, {}))) {
    if (l.ownerUid === uid) await deleteLeague(l.id);
  }
  for (const t of Object.values(lsRead<Record<string, Team>>(LS_TEAMS, {}))) {
    // 원격에 남겨 두면 다음 새로고침에 listTeams가 되살려 팀이 둘이 된다.
    if (t.ownerUid === uid) await deleteTeam(t.id);
  }

  // 2) 팀. 마이그레이션을 태워 지금 코드가 읽을 수 있는 것만 저장한다.
  const out: ImportResult = {
    teams: [],
    leagues: [],
    activeTeamId: null,
    recordCount: 0,
    migrated: 0,
    skipped: [],
  };
  for (const raw of payload.teams) {
    const r = readTeamDoc(raw);
    if (!r.team) {
      if (r.skipped) out.skipped.push(r.skipped);
      continue;
    }
    if (r.migratedFrom !== null) out.migrated += 1;
    if (r.team.ownerUid === uid) {
      await saveTeam(r.team);
      out.teams.push(r.team);
    } else {
      // 리그의 CPU 팀. 소유자가 없으므로 캐시에만 둔다.
      cacheTeamLocal(r.team);
    }
  }

  // 3) 리그. saveLeague가 내장 cpuTeams를 캐시에 되살려 준다.
  for (const l of payload.leagues) {
    await saveLeague(l);
    out.leagues.push(l);
  }

  // 4) 나머지
  saveSettings(payload.settings);
  if (payload.nickname) saveNickname(uid, payload.nickname);
  out.recordCount = importGameRecords(payload.records);
  out.activeTeamId = out.teams.some((t) => t.id === payload.activeTeamId)
    ? payload.activeTeamId
    : (out.teams[0]?.id ?? null);
  return out;
}

/** 경기 기록 병합. id가 겹치면 가져온 쪽을 쓰고, 최신순으로 정리해 용량 상한을 지킨다. */
export function importGameRecords(incoming: GameRecord[]): number {
  const mine = new Map(incoming.map((r) => [r.id, r]));
  for (const r of lsRead<GameRecord[]>(LS_RECORDS, [])) if (!mine.has(r.id)) mine.set(r.id, r);
  const merged = [...mine.values()].sort((a, b) => b.playedAt - a.playedAt);

  // saveGameRecord와 같은 3단 폴백. 용량이 넘치면 클립부터 버린다.
  const trimmed = trimRecords(merged);
  if (lsWrite(LS_RECORDS, trimmed)) return trimmed.length;
  const noClips = merged.map((r) => (r.clips ? { ...r, clips: undefined } : r));
  if (lsWrite(LS_RECORDS, noClips)) return noClips.length;
  lsWrite(LS_RECORDS, noClips.slice(0, 10));
  return Math.min(10, noClips.length);
}
