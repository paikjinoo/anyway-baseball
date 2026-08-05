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
import { DEFAULT_SETTINGS } from '../game/types';

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
  if (cached) return cached;
  const db = getDb();
  if (firebaseConfigured && db) {
    try {
      const snap = await getDoc(doc(db, 'teams', teamId));
      if (snap.exists()) {
        const team = snap.data() as Team;
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
        const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
        all[t.id] = t;
        lsWrite(LS_TEAMS, all);
        return t;
      }
    } catch {
      // 캐시 폴백
    }
  }
  return cached;
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
      return Object.values(all).filter((t) => t.ownerUid === uid);
    } catch {
      // 캐시 폴백
    }
  }
  return Object.values(lsRead<Record<string, Team>>(LS_TEAMS, {})).filter(
    (t) => t.ownerUid === uid,
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
