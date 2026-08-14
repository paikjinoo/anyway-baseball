import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTeam } from '../game/generator';
import { Rng, seedFromString } from '../game/rng';
import type { Team } from '../game/types';

/**
 * 저장소 층에서 본 조작 방어.
 *
 * integrity.test.ts가 서명 자체를 재는 곳이라면, 여기는 **실제로 돌던 치트를 그대로 넣고**
 * 무슨 일이 벌어지는지 재는 곳이다. 상점 화면 콘솔에 붙여 넣던 스니펫이 하는 일은 셋이다.
 *
 *   1. `ab:teams`를 읽어 내 팀의 gold를 300,000으로 바꾼다
 *   2. updatedAt을 지금 시각으로 찍는다 (그래야 원격 병합에서 이긴다)
 *   3. 다시 써 넣고 새로고침한다
 *
 * 그 세 줄이 통하지 않는다는 것을 여기서 고정한다.
 *
 * Firebase는 설정되지 않은 것으로 두어 **원격이 없는 최악의 경우**(게스트·오프라인)를 잰다.
 * 원격 사본이 있으면 조작본이 병합에서 지고 그냥 복구되므로, 방어가 약한 쪽은 이쪽이다.
 */

vi.mock('./client', () => ({
  firebaseConfigured: false,
  getDb: () => null,
  getFirebaseAuth: () => null,
  iceServers: () => [],
}));

/** node 환경이라 localStorage가 없다. store.ts의 lsRead/lsWrite가 기대하는 만큼만 흉내 낸다. */
const store = new Map<string, string>();
const shim = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.assign(globalThis, { window: globalThis, localStorage: shim });

const { listTeamsReport, saveTeam } = await import('./store');

const UID = 'u1';

function founding(seed = 'integrity'): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid: UID });
}

function raw(): Record<string, Team> {
  return JSON.parse(store.get('ab:teams') ?? '{}');
}

function write(all: Record<string, Team>) {
  store.set('ab:teams', JSON.stringify(all));
}

/** 상점 화면 콘솔에 붙여 넣던 스니펫. 골드를 넣고 시각을 새로 찍는다. */
function consoleCheat(teamId: string, gold = 300_000) {
  const all = raw();
  all[teamId] = { ...all[teamId], gold, updatedAt: Date.now() };
  write(all);
}

beforeEach(() => {
  store.clear();
});

describe('콘솔 조작', () => {
  it('골드를 넣고 새로고침하면 0으로 되돌아간다', async () => {
    const team = { ...founding(), gold: 7_000 };
    await saveTeam(team);

    consoleCheat(team.id);

    const report = await listTeamsReport(UID);
    expect(report.teams).toHaveLength(1);
    expect(report.teams[0].gold).toBe(0);
    expect(report.tampered).toEqual([team.name]);
  });

  it('선수단은 그대로 남는다 — 되돌리는 것은 골드뿐이다', async () => {
    const team = founding();
    await saveTeam(team);
    consoleCheat(team.id);

    const [loaded] = (await listTeamsReport(UID)).teams;
    expect(loaded.players).toHaveLength(team.players.length);
    expect(loaded.lineup).toEqual(team.lineup);
    expect(loaded.name).toBe(team.name);
  });

  it('원본은 선반에 남는다 — 판정이 틀렸을 때 되돌릴 출처', async () => {
    const team = founding();
    await saveTeam(team);
    consoleCheat(team.id);
    await listTeamsReport(UID);

    const shelf = JSON.parse(store.get('ab:teams:tampered') ?? '{}');
    expect(shelf[team.id].gold).toBe(300_000);
  });

  it('안내는 한 번만 뜬다 — 되돌린 문서에 새 서명이 찍히므로', async () => {
    const team = founding();
    await saveTeam(team);
    consoleCheat(team.id);

    expect((await listTeamsReport(UID)).tampered).toHaveLength(1);
    expect((await listTeamsReport(UID)).tampered).toHaveLength(0);
  });

  it('서명까지 지워도 잡는다 — 이 기기는 서명본을 이미 봤다', async () => {
    const team = { ...founding(), gold: 7_000 };
    await saveTeam(team);

    const all = raw();
    const { seal: _drop, ...unsealed } = all[team.id];
    all[team.id] = { ...(unsealed as Team), gold: 300_000, updatedAt: Date.now() };
    write(all);

    const report = await listTeamsReport(UID);
    expect(report.teams[0].gold).toBe(0);
    expect(report.tampered).toHaveLength(1);
  });

  it('메모리 위의 팀을 고쳐 정상 저장시켜도 골드가 늘지 않는다', async () => {
    // 서명은 저장된 문서를 지킨다. 스토어의 팀 객체를 직접 고친 뒤 뽑기 한 번을 정상으로
    // 돌리면 그 값이 정상 경로를 타고 새 서명을 받는데, 그 세탁은 증가 상한이 막는다.
    const team = { ...founding(), gold: 7_000 };
    await saveTeam(team);

    await saveTeam({ ...team, gold: 300_000 });
    expect(raw()[team.id].gold).toBe(7_000);
  });
});

describe('정상 플레이', () => {
  it('저장하고 다시 불러도 아무 일도 일어나지 않는다', async () => {
    const team = { ...founding(), gold: 12_345 };
    await saveTeam(team);

    const report = await listTeamsReport(UID);
    expect(report.teams[0].gold).toBe(12_345);
    expect(report.tampered).toHaveLength(0);
  });

  it('서명 이전에 저장된 팀은 통과시키고, 그다음부터 지킨다', async () => {
    // 이미 플레이 중이던 유저의 문서에는 서명이 없다. 첫 로드는 그대로 통과해야 하고,
    // 그 로드가 서명을 찍어 두므로 그다음 조작부터는 잡혀야 한다.
    const team = { ...founding(), gold: 40_000 };
    write({ [team.id]: team });

    const first = await listTeamsReport(UID);
    expect(first.teams[0].gold).toBe(40_000);
    expect(first.tampered).toHaveLength(0);
    expect(raw()[team.id].seal).toBeTypeOf('string');

    consoleCheat(team.id);
    expect((await listTeamsReport(UID)).teams[0].gold).toBe(0);
  });

  it('한도 안의 보상은 그대로 들어온다', async () => {
    const team = { ...founding(), gold: 1_000 };
    await saveTeam(team);
    // 리그 우승(8,000G)처럼 큰 보상도 한 번의 저장으로 들어온다.
    await saveTeam({ ...team, gold: 9_000 });
    expect(raw()[team.id].gold).toBe(9_000);

    const report = await listTeamsReport(UID);
    expect(report.teams[0].gold).toBe(9_000);
    expect(report.tampered).toHaveLength(0);
  });

  it('골드를 쓰는 저장은 얼마든 통과한다', async () => {
    const team = { ...founding(), gold: 200_000 };
    await saveTeam(team);
    await saveTeam({ ...team, gold: 0 });
    expect(raw()[team.id].gold).toBe(0);
  });
});
