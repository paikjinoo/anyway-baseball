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

// ---------------------------------------------------------------------------
// 팀
// ---------------------------------------------------------------------------

export async function saveTeam(team: Team): Promise<void> {
  const next = { ...team, updatedAt: Date.now() };
  const db = getDb();
  if (firebaseConfigured && db) {
    await setDoc(doc(db, 'teams', team.id), next);
  }
  // 로컬에도 항상 캐싱해 둔다 (오프라인 플레이 / 읽기 횟수 절감)
  const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
  all[team.id] = next;
  lsWrite(LS_TEAMS, all);
}

export async function loadTeam(teamId: string): Promise<Team | null> {
  const cached = lsRead<Record<string, Team>>(LS_TEAMS, {})[teamId];
  if (cached) return cached;
  const db = getDb();
  if (firebaseConfigured && db) {
    const snap = await getDoc(doc(db, 'teams', teamId));
    if (snap.exists()) return snap.data() as Team;
  }
  return null;
}

/** 원격 우선으로 최신 팀을 가져온다 (다른 기기에서 수정했을 수 있음) */
export async function fetchTeamFresh(teamId: string): Promise<Team | null> {
  const db = getDb();
  if (firebaseConfigured && db) {
    const snap = await getDoc(doc(db, 'teams', teamId));
    if (snap.exists()) {
      const t = snap.data() as Team;
      const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
      all[t.id] = t;
      lsWrite(LS_TEAMS, all);
      return t;
    }
  }
  return loadTeam(teamId);
}

export async function listTeams(uid: string): Promise<Team[]> {
  const db = getDb();
  if (firebaseConfigured && db) {
    const q = query(collection(db, 'teams'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    const teams = snap.docs.map((d) => d.data() as Team);
    const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
    for (const t of teams) all[t.id] = t;
    lsWrite(LS_TEAMS, all);
    return teams;
  }
  return Object.values(lsRead<Record<string, Team>>(LS_TEAMS, {})).filter(
    (t) => t.ownerUid === uid,
  );
}

export async function deleteTeam(teamId: string): Promise<void> {
  const db = getDb();
  if (firebaseConfigured && db) {
    await deleteDoc(doc(db, 'teams', teamId));
  }
  const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
  delete all[teamId];
  lsWrite(LS_TEAMS, all);
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

export async function saveLeague(league: League): Promise<void> {
  const db = getDb();
  if (firebaseConfigured && db) {
    await setDoc(doc(db, 'leagues', league.id), league);
  }
  const all = lsRead<Record<string, League>>(LS_LEAGUES, {});
  all[league.id] = league;
  lsWrite(LS_LEAGUES, all);
}

export async function listLeagues(uid: string): Promise<League[]> {
  const db = getDb();
  if (firebaseConfigured && db) {
    const q = query(collection(db, 'leagues'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    const leagues = snap.docs.map((d) => d.data() as League);
    const all = lsRead<Record<string, League>>(LS_LEAGUES, {});
    for (const l of leagues) all[l.id] = l;
    lsWrite(LS_LEAGUES, all);
    return leagues;
  }
  return Object.values(lsRead<Record<string, League>>(LS_LEAGUES, {})).filter(
    (l) => l.ownerUid === uid,
  );
}

export function getCachedLeague(id: string): League | null {
  return lsRead<Record<string, League>>(LS_LEAGUES, {})[id] ?? null;
}

export async function deleteLeague(id: string): Promise<void> {
  const db = getDb();
  if (firebaseConfigured && db) await deleteDoc(doc(db, 'leagues', id));
  const all = lsRead<Record<string, League>>(LS_LEAGUES, {});
  delete all[id];
  lsWrite(LS_LEAGUES, all);
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
