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
  isUnrecoverable,
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
import { CPU_OWNER_UID, checkTeamSeal, clampGoldGain, sealTeam } from '../game/integrity';

/**
 * 팀 / 리그 / 설정 저장소.
 *
 * Firestore 사용량을 최소로 유지하기 위해, 실제 경기 중에는 여기에 전혀 쓰지 않는다.
 * 쓰기가 발생하는 시점은 팀 저장, 훈련 결과 저장, 리그 경기 결과 기록뿐이다.
 * Firebase가 설정되지 않은 환경에서는 localStorage로 동일한 API를 제공한다.
 */

const LS_TEAMS = 'ab:teams';
/**
 * 정리한 옛 팀 문서를 옮겨 두는 선반. **지우는 게 아니라 옮기는 것이다.**
 *
 * 목록 조회(`ab:teams`)에서 빠지므로 사용자에게는 사라진 것과 같지만, 원본 바이트는 남는다.
 * 백업 내보내기가 "지금 코드가 못 읽는 팀도 원본을 담는다"는 원칙을 지키고 있어서
 * (@see exportSnapshot), 여기서 진짜로 삭제해 버리면 그 원칙이 무의미해진다.
 */
const LS_LEGACY_TEAMS = 'ab:teams:legacy';
/**
 * 조작이 감지되어 골드를 되돌린 문서의 원본 선반. LS_LEGACY_TEAMS와 같은 이유로 둔다 —
 * 판정이 틀렸을 때 되돌릴 수 있어야 한다.
 */
const LS_TAMPERED_TEAMS = 'ab:teams:tampered';
/**
 * 팀별로 이 기기가 마지막으로 서명해 저장한 시각. 서명 없는 문서를 언제까지 봐 줄지
 * 정하는 표식이다 (@see game/integrity.SealContext).
 */
const LS_SEAL_ANCHOR = 'ab:sealed';
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

/**
 * 게스트 uid 접두사. Firebase 인증이 없는 로컬 전용 계정이다.
 *
 * auth가 아니라 여기 있는 이유는 import 방향 때문이다 — auth.ts가 이미 store를 가져다 쓰고
 * 있어서 반대 방향으로 참조하면 순환이 된다.
 */
export const GUEST_UID_PREFIX = 'guest_';

/**
 * 이 uid로는 Firestore에 쓸 수 없다. 보안 규칙이 `request.auth != null`을 요구하는데
 * 게스트는 Firebase 인증을 거치지 않기 때문이다. 시도하면 매번 권한 오류만 나므로
 * **아예 보내지 않는다** — 실패 로그를 조용히 만들려는 게 아니라, 진짜 실패만 남기려는 것이다.
 */
export function isGuestUid(uid: string): boolean {
  return uid.startsWith(GUEST_UID_PREFIX);
}

/**
 * 로컬 작업을 막지 않는 최선 노력 원격 동기화. 실패 데이터는 로컬 캐시에 남는다.
 *
 * **삼켜도 흔적은 남긴다.** 예전에는 빈 catch였는데, 그 침묵이 실제로 오래 대가를 치렀다 —
 * setDoc은 `undefined` 필드를 만나면 프로미스가 아니라 **동기 예외**로 문서를 통째로
 * 거부하고(@see firebase/client.getDb), 로컬 저장은 JSON 직렬화 덕에 멀쩡히 성공한다.
 * 그래서 화면상으로는 아무 문제가 없는 채 원격 쓰기만 전부 사라졌다.
 */
function syncRemote(task: () => Promise<unknown>, what = '동기화') {
  const warn = (e: unknown) => {
    if (process.env.NODE_ENV !== 'production') console.warn(`[firestore] ${what} 실패`, e);
  };
  try {
    void task().catch(warn);
  } catch (e) {
    // SDK 초기화/직렬화 오류가 동기적으로 나도 로컬 저장은 이미 끝났다.
    warn(e);
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
  /** 이번 로드에서 정리한 옛 팀 수. 사용자에게 한 번 알려 주고 끝낸다. */
  cleaned: number;
  /** 서명이 맞지 않아 골드를 되돌린 팀의 이름. 사용자에게 왜 골드가 없어졌는지 설명한다. */
  tampered: string[];
}

// ---------------------------------------------------------------------------
// 서명 앵커
// ---------------------------------------------------------------------------

function sealAnchors(): Record<string, number> {
  return lsRead<Record<string, number>>(LS_SEAL_ANCHOR, {});
}

/** 이 팀의 서명본을 이 기기가 저장한 적이 있는지 (@see game/integrity.SealContext) */
function anchorOf(teamId: string): number | null {
  const at = sealAnchors()[teamId];
  return typeof at === 'number' ? at : null;
}

function noteSealed(teamId: string, at: number) {
  const all = sealAnchors();
  if (all[teamId] === at) return;
  all[teamId] = at;
  lsWrite(LS_SEAL_ANCHOR, all);
}

/**
 * 앵커를 지운다. **팀을 지울 때 반드시 같이 지워야 한다** — 안 지우면 백업 가져오기가
 * 막힌다. 서명 이전에 내보낸 백업에는 서명이 없는데, 앵커가 남아 있으면 그 정상 백업이
 * 조작으로 판정된다.
 */
function forgetSealed(teamId: string) {
  const all = sealAnchors();
  if (!(teamId in all)) return;
  delete all[teamId];
  lsWrite(LS_SEAL_ANCHOR, all);
}

/** 조작 판정을 받은 원본을 선반에 옮긴다. 판정이 틀렸을 때 되돌릴 유일한 출처다. */
function shelveTampered(id: string, raw: unknown) {
  const shelf = lsRead<Record<string, unknown>>(LS_TAMPERED_TEAMS, {});
  shelf[id] = raw;
  lsWrite(LS_TAMPERED_TEAMS, shelf);
}

export interface TeamDocRead {
  team: Team | null;
  skipped: SkippedDoc | null;
  migratedFrom: number | null;
  /** 서명이 맞지 않아 골드를 0으로 되돌렸는가 */
  tampered: boolean;
}

/**
 * 저장소에서 읽은 팀 문서를 쓸 수 있는 형태로 만든다.
 * **팀을 돌려주는 모든 경로가 여기를 지난다** — 반환 지점마다 흩어 놓으면 반드시 어딘가 빠진다.
 *
 * 1) 서명을 맞춰 보고 (@see game/integrity.checkTeamSeal)
 * 2) 스키마 버전을 목표까지 끌어올리고 (@see game/migrate.migrateTeamDoc)
 * 3) 이중 집계로 부푼 스플릿을 걷어낸 뒤 (@see game/season.repairTeam)
 * 4) 다시 서명한다.
 *
 * **마지막에 다시 서명하는 것이 핵심이다.** 2)와 3)이 문서를 바꾸므로, 그대로 캐시에
 * 되쓰면 다음 로드에서 옛 서명과 어긋나 멀쩡한 팀이 조작으로 잡힌다.
 *
 * 조작이 감지돼도 **문서를 버리지 않는다.** 골드만 0으로 되돌리고 선수·기록은 그대로 둔다.
 * 판정이 틀렸을 때 잃는 것을 최소로 하려는 것이고, 원본은 선반에 남는다.
 */
function readTeamDoc(raw: unknown): TeamDocRead {
  if (!raw) return { team: null, skipped: null, migratedFrom: null, tampered: false };

  const id = (raw as Team).id;
  const verdict = checkTeamSeal(raw, { anchoredAt: typeof id === 'string' ? anchorOf(id) : null });

  const out = migrateTeamDoc(raw);
  if (!out.ok) {
    return {
      team: null,
      skipped: { id: out.id, name: out.name, version: out.version, reason: out.reason },
      migratedFrom: null,
      tampered: false,
    };
  }

  const repaired = repairTeam(out.team);
  // CPU 팀은 지갑이 없어 검사도 서명도 하지 않는다. 리그 화면이 순위표를 그릴 때마다
  // 팀마다 부르는 경로라(@see app/league/page.tsx) 헛수고를 덜어 두는 뜻도 있다.
  if (repaired.ownerUid === CPU_OWNER_UID) {
    return { team: repaired, skipped: null, migratedFrom: out.migratedFrom, tampered: false };
  }

  const tampered = verdict === 'TAMPERED';
  if (tampered) {
    shelveTampered(repaired.id, raw);
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[integrity] 서명 불일치 — 골드를 되돌립니다 (${repaired.id})`);
    }
  }

  return {
    team: sealTeam(tampered ? { ...repaired, gold: 0 } : repaired),
    skipped: null,
    migratedFrom: out.migratedFrom,
    tampered,
  };
}

/** 팀 하나만 필요할 때. 못 읽으면 null이다. */
function readTeam(raw: unknown): Team | null {
  return readTeamDoc(raw).team;
}

export async function saveTeam(team: Team): Promise<void> {
  const all = lsRead<Record<string, Team>>(LS_TEAMS, {});

  // 직전 저장본이 성한 문서일 때만 증가폭을 본다. 조작된 문서를 기준으로 삼으면 그 값이
  // 정상의 기준이 되어 버리고, 백업 가져오기처럼 직전 문서가 아예 없는 경우는 상한이 없다
  // (deleteTeam이 먼저 지우고 들어온다).
  const prev = all[team.id];
  const trusted =
    prev && checkTeamSeal(prev, { anchoredAt: anchorOf(team.id) }) === 'OK' ? prev : null;
  const gold = trusted ? clampGoldGain(trusted.gold, team.gold) : team.gold;
  if (process.env.NODE_ENV !== 'production' && trusted && gold !== team.gold) {
    console.warn(`[integrity] 한 번에 늘 수 없는 골드입니다 (${trusted.gold} → ${team.gold})`);
  }

  const next = sealTeam({ ...team, gold, updatedAt: Date.now() });
  // 네트워크와 무관하게 로컬 저장을 먼저 완료한다.
  all[team.id] = next;
  lsWrite(LS_TEAMS, all);
  noteSealed(next.id, next.updatedAt);
  const db = getDb();
  if (firebaseConfigured && db && !isGuestUid(team.ownerUid)) {
    syncRemote(() => setDoc(doc(db, 'teams', team.id), next), `팀 저장(${team.id})`);
  }
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
  // 게스트는 규칙에 막혀 조회 자체가 실패한다. 물어보지 않고 바로 캐시로 간다.
  if (firebaseConfigured && db && !isGuestUid(uid)) {
    try {
      const q = query(collection(db, 'teams'), where('ownerUid', '==', uid));
      const snap = await getDocs(q);
      const teams = snap.docs.map((d) => d.data() as Team);
      const remoteIds = new Set(snap.docs.map((d) => d.id));
      const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
      for (const t of teams) {
        // **조작된 캐시본은 원격을 절대 이기지 못한다.** 콘솔로 골드를 고치는 스니펫은
        // updatedAt까지 지금 시각으로 새로 찍기 때문에, 시각만 비교하면 조작본이 언제나
        // 이긴다. 서명이 깨진 문서는 시각을 보지 않고 원격 사본으로 되돌린다 —
        // 로그인 사용자에게는 이 한 줄이 곧 자동 복구다.
        const local = all[t.id];
        const keepLocal =
          local && checkTeamSeal(local, { anchoredAt: anchorOf(t.id) }) !== 'TAMPERED'
            ? local.updatedAt > t.updatedAt
            : false;
        if (!keepLocal) all[t.id] = t;
      }
      const report = ownedTeams(all, uid);
      // 업그레이드된 문서는 캐시에 되쓴다. 다음 로드부터는 변환 비용이 들지 않는다.
      // 서명도 이때 최신으로 갱신된다 (@see readTeamDoc).
      for (const t of report.teams) all[t.id] = t;
      const purged = purgeUnreadableTeams(all, report);
      // 앵커는 **서명본이 실제로 디스크에 앉은 뒤에만** 남긴다. 용량이 꽉 차 저장이 실패했는데
      // 앵커만 세우면, 다음 로드에서 서명 없는 캐시본이 통째로 조작 판정을 받는다.
      if (lsWrite(LS_TEAMS, all)) anchorLoaded(report.teams);
      // 원격에도 남겨 두면 다음 로드에 그대로 다시 내려와 정리가 매번 반복된다.
      for (const id of purged) syncRemote(() => deleteDoc(doc(db, 'teams', id)), `옛 팀 정리(${id})`);
      // **updatedAt은 올리지 않는다.** listTeams의 LWW 병합이 왜곡된다 —
      // 마이그레이션은 형태 변환일 뿐 "새 저장"이 아니다.
      //
      // 원격이 **통째로 비었을 때만** 이 기기의 팀을 올린다. saveTeam이 한 번 실패하면 그
      // 팀은 이 기기에만 남는데, 목록 조회는 캐시로 조용히 폴백하므로 화면에는 아무 증상이
      // 없다. 그래서 기기를 옮기거나 브라우저 데이터를 지우는 순간에야 팀이 없다는 걸 알게
      // 된다. 다시 저장할 일이 생길 때까지 기다리지 않고 여기서 메운다.
      //
      // 조건을 "원격에 하나도 없음"으로 좁힌 이유는 **부활을 막기 위해서다.** 원격에 팀이
      // 이미 있는데 이 기기 캐시에 다른 팀이 남아 있다면, 그건 다른 기기에서 지우고 새로
      // 창단했다는 뜻이다. 그 상태에서 캐시본을 올리면 "한 계정 한 팀"이 깨진다.
      const repair = remoteIds.size === 0 ? report.teams : [];
      for (const t of report.migrated > 0 ? report.teams : repair) {
        syncRemote(() => setDoc(doc(db, 'teams', t.id), t), `팀 업로드(${t.id})`);
      }
      return report;
    } catch (e) {
      // 캐시 폴백
      if (process.env.NODE_ENV !== 'production') console.warn('[firestore] 팀 목록 조회 실패', e);
    }
  }
  // 게스트이거나 원격 조회가 실패한 경로. 로컬만 정리하면 되고, 원격에 사본이 남아 있다면
  // 다음번 조회 성공 때 다시 걸려 그때 지워진다.
  const cached = lsRead<Record<string, Team>>(LS_TEAMS, {});
  const report = ownedTeams(cached, uid);
  purgeUnreadableTeams(cached, report);
  // 원격 경로와 달리 예전에는 정리할 게 있을 때만 되썼다. 지금은 **언제나** 되쓴다 —
  // 읽으면서 갱신한 서명이 디스크에 앉아야 앵커를 세울 수 있고, 앵커가 서야 서명을 지우는
  // 우회가 막힌다. 팀은 계정당 하나라 쓰기 비용도 무시할 만하다.
  for (const t of report.teams) cached[t.id] = t;
  if (lsWrite(LS_TEAMS, cached)) anchorLoaded(report.teams);
  return report;
}

/** 서명이 디스크에 앉은 팀에 "이 기기는 이 팀의 서명본을 봤다"를 남긴다 */
function anchorLoaded(teams: Team[]) {
  for (const t of teams) noteSealed(t.id, t.updatedAt);
}

function ownedTeams(all: Record<string, Team>, uid: string): TeamLoadReport {
  const out: TeamLoadReport = { teams: [], skipped: [], migrated: 0, cleaned: 0, tampered: [] };
  for (const raw of Object.values(all)) {
    if (raw?.ownerUid !== uid) continue;
    const r = readTeamDoc(raw);
    if (r.team) {
      out.teams.push(r.team);
      if (r.migratedFrom !== null) out.migrated += 1;
      if (r.tampered) out.tampered.push(r.team.name);
    } else if (r.skipped) {
      out.skipped.push(r.skipped);
    }
  }
  return out;
}

/**
 * 되살릴 수 없는 옛 팀을 목록에서 치운다. `all`과 `report`를 제자리에서 고치고,
 * 원격에서도 지워야 할 id를 돌려준다.
 *
 * 이걸 자동으로 하는 이유는, 그냥 두면 **영원히 남기 때문이다.** 대상 문서는 티어/레벨이
 * 들어오기 전에 만들어져 지금 코드로는 열리지 않고, 그 유저는 이미 재창단을 마쳤다.
 * 매번 "읽지 못한 데이터가 있습니다"만 띄우면서 할 수 있는 일은 아무것도 주지 못한다.
 *
 * **지우는 범위는 isUnrecoverable이 정한다** (@see game/migrate). 특히 TOO_NEW —
 * 다른 기기의 최신 빌드에서 저장한 멀쩡한 팀 — 는 절대 여기 들어오면 안 된다.
 */
function purgeUnreadableTeams(all: Record<string, Team>, report: TeamLoadReport): string[] {
  const doomed: string[] = [];
  const kept: SkippedDoc[] = [];
  for (const s of report.skipped) {
    if (s.id !== null && isUnrecoverable(s.reason)) doomed.push(s.id);
    else kept.push(s);
  }
  if (!doomed.length) return [];

  // 선반에 옮기는 게 **먼저다.** 용량이 꽉 차 선반 저장이 실패했는데 목록에서 먼저
  // 빼 버리면, 되살릴 여지를 남기려던 원본이 그 순간 진짜로 사라진다.
  const shelf = lsRead<Record<string, unknown>>(LS_LEGACY_TEAMS, {});
  for (const id of doomed) shelf[id] = all[id];
  if (!lsWrite(LS_LEGACY_TEAMS, shelf)) return [];

  for (const id of doomed) delete all[id];
  report.skipped = kept;
  report.cleaned = doomed.length;
  return doomed;
}

export async function deleteTeam(teamId: string): Promise<void> {
  const all = lsRead<Record<string, Team>>(LS_TEAMS, {});
  const owner = all[teamId]?.ownerUid;
  delete all[teamId];
  lsWrite(LS_TEAMS, all);
  // 팀이 사라지면 서명 표식도 같이 사라져야 한다 (@see forgetSealed).
  forgetSealed(teamId);
  const db = getDb();
  if (firebaseConfigured && db && !(owner && isGuestUid(owner))) {
    syncRemote(() => deleteDoc(doc(db, 'teams', teamId)), `팀 삭제(${teamId})`);
  }
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
  if (firebaseConfigured && db && !isGuestUid(next.ownerUid)) {
    syncRemote(() => setDoc(doc(db, 'leagues', next.id), next), `리그 저장(${next.id})`);
  }
}

export async function listLeagues(uid: string): Promise<League[]> {
  const db = getDb();
  if (firebaseConfigured && db && !isGuestUid(uid)) {
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
          syncRemote(() => setDoc(doc(db, 'leagues', hydrated.id), hydrated), `리그 승격(${hydrated.id})`);
        }
      }
      lsWrite(LS_LEAGUES, all);
      // 리그에는 팀 같은 복구 업로드를 두지 않는다. 리그는 계정당 여러 개라 "원격이 비었다"가
      // 곧 유실을 뜻하지 않고, 경기 결과마다 saveLeague가 돌아 스스로 메워진다.
      return Object.values(all)
        .filter((l) => l.ownerUid === uid)
        .map(hydrateLeagueCpuTeams);
    } catch (e) {
      // 캐시 폴백
      if (process.env.NODE_ENV !== 'production') console.warn('[firestore] 리그 목록 조회 실패', e);
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
  if (firebaseConfigured && db && !(league && isGuestUid(league.ownerUid))) {
    syncRemote(() => deleteDoc(doc(db, 'leagues', id)), `리그 삭제(${id})`);
  }
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
  syncRemote(
    () => setDoc(doc(db, 'profiles', uid), { uid, nickname: nickname ?? '', updatedAt: Date.now() }),
    '닉네임 저장',
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
  /** 서명이 맞지 않아 골드를 되돌린 팀 이름. 백업 파일을 고쳐 넣은 경우다. */
  tampered: string[];
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
    tampered: [],
  };
  for (const raw of payload.teams) {
    const r = readTeamDoc(raw);
    if (!r.team) {
      if (r.skipped) out.skipped.push(r.skipped);
      continue;
    }
    if (r.migratedFrom !== null) out.migrated += 1;
    if (r.team.ownerUid === uid) {
      if (r.tampered) out.tampered.push(r.team.name);
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
