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
import type { GameSettings, League, Team } from '../game/types';
import { DEFAULT_SETTINGS, TEAM_SCHEMA_VERSION } from '../game/types';
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

function lsRead<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsWrite(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 용량 초과 등은 무시한다
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

/**
 * 이 팀 문서를 지금 코드로 읽을 수 있는지.
 *
 * 티어/레벨/체형/역할 도입으로 구 스키마와 호환되지 않는다. 억지로 읽으면 능력치 상한과
 * 라인업 검증이 조용히 어긋나므로, 아예 없는 셈 치고 재창단으로 보낸다.
 */
export function isCurrentSchema(team: Team | null | undefined): team is Team {
  return !!team && team.schemaVersion === TEAM_SCHEMA_VERSION;
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
  if (cached) return isCurrentSchema(cached) ? cached : null;
  const db = getDb();
  if (firebaseConfigured && db) {
    try {
      const snap = await getDoc(doc(db, 'teams', teamId));
      if (snap.exists()) {
        const team = snap.data() as Team;
        if (!isCurrentSchema(team)) return null;
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
        const t = snap.data() as Team;
        if (!isCurrentSchema(t)) return null;
        const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
        all[t.id] = t;
        lsWrite(LS_TEAMS, all);
        return t;
      }
    } catch {
      // 캐시 폴백
    }
  }
  return isCurrentSchema(cached) ? cached : null;
}

export async function listTeams(uid: string): Promise<Team[]> {
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
      lsWrite(LS_TEAMS, all);
      return Object.values(all).filter((t) => t.ownerUid === uid && isCurrentSchema(t));
    } catch {
      // 캐시 폴백
    }
  }
  return Object.values(lsRead<Record<string, Team>>(LS_TEAMS, {})).filter(
    (t) => t.ownerUid === uid && isCurrentSchema(t),
  );
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

export function getCachedTeam(teamId: string): Team | null {
  return lsRead<Record<string, Team>>(LS_TEAMS, {})[teamId] ?? null;
}

// ---------------------------------------------------------------------------
// 리그
// ---------------------------------------------------------------------------

/** 구버전 리그는 로컬 CPU 팀을 찾아 새 동기화 형식으로 승격하고 캐시도 복원한다. */
function hydrateLeagueCpuTeams(league: League): League {
  const allTeams = lsRead<Record<string, Team>>(LS_TEAMS, {});
  const embedded = new Map((league.cpuTeams ?? []).map((team) => [team.id, team]));
  const cpuRefs = league.teams.filter((ref) => ref.isCPU);
  const cpuTeams = cpuRefs
    .map((ref) => embedded.get(ref.teamId) ?? allTeams[ref.teamId])
    .filter((team): team is Team => Boolean(team));
  for (const team of cpuTeams) allTeams[team.id] = team;
  lsWrite(LS_TEAMS, allTeams);
  if (cpuTeams.length === cpuRefs.length) return { ...league, cpuTeams };
  if (!league.cpuTeams?.length) return league;
  const withoutIncomplete = { ...league };
  delete withoutIncomplete.cpuTeams;
  return withoutIncomplete;
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
  // soundEnabled 하나만 있던 이전 저장값은 세 채널 스위치로 마이그레이션한다.
  // 당시 bgmVolume은 실제로 관중 볼륨에 쓰였으므로 crowdVolume의 초기값으로도 보존한다.
  const saved = lsRead<Partial<GameSettings> & { soundEnabled?: boolean }>(LS_SETTINGS, {});
  const { soundEnabled: legacyEnabled, ...current } = saved;
  const enabled = legacyEnabled ?? true;
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    sfxEnabled: saved.sfxEnabled ?? enabled,
    crowdEnabled: saved.crowdEnabled ?? enabled,
    bgmEnabled: saved.bgmEnabled ?? enabled,
    crowdVolume: saved.crowdVolume ?? saved.bgmVolume ?? DEFAULT_SETTINGS.crowdVolume,
  };
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
