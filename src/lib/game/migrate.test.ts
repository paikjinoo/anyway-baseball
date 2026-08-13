import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { createLeague } from './league';
import {
  isTeamShaped,
  isUnrecoverable,
  LEGACY_TEAM_VERSION,
  migrateTeamDoc,
  normalizeLeague,
  normalizeSettings,
  normalizeTeam,
  type SkipReason,
  type TeamMigration,
} from './migrate';
import { DEFAULT_SETTINGS, TEAM_SCHEMA_VERSION } from './types';
import type { League, LeagueTeamRef, Team } from './types';

function team(seed = 'mig', ownerUid = 'me'): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid });
}

/**
 * 레지스트리가 비어 있는 지금도 체인 동작을 재려면 가짜 업그레이더를 주입해야 한다.
 * 실제 마이그레이션이 생기면 이 테스트가 그 형태를 이미 고정해 두고 있다.
 */
const FAKE: TeamMigration[] = [
  { from: 2, note: 'v3: 별명 필드 추가', up: (d) => ({ ...d, nickname: 'v3' }) },
  { from: 3, note: 'v4: 별명을 대문자로', up: (d) => ({ ...d, nickname: String(d.nickname).toUpperCase() }) },
];

describe('migrateTeamDoc', () => {
  it('목표 버전과 같으면 손대지 않는다', () => {
    const t = team();
    const out = migrateTeamDoc(t);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.migratedFrom).toBeNull();
    expect(out.team.id).toBe(t.id);
  });

  it('업그레이더를 순서대로 태워 목표 버전까지 올린다', () => {
    const out = migrateTeamDoc({ ...team(), schemaVersion: 2 }, FAKE, 4);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.team.schemaVersion).toBe(4);
    expect(out.migratedFrom).toBe(2);
    // 두 단계가 모두, 순서대로 적용됐다
    expect((out.team as unknown as { nickname: string }).nickname).toBe('V3');
  });

  it('중간부터 시작해도 남은 단계만 탄다', () => {
    const out = migrateTeamDoc({ ...team(), schemaVersion: 3, nickname: 'kept' }, FAKE, 4);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.team as unknown as { nickname: string }).nickname).toBe('KEPT');
  });

  it('버전이 미래면 절대 손대지 않는다', () => {
    // 억지로 읽고 되쓰면 최신 기기에서 만든 팀을 낡은 탭이 덮어써 데이터가 실제로 사라진다.
    const out = migrateTeamDoc({ ...team(), schemaVersion: TEAM_SCHEMA_VERSION + 5 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('TOO_NEW');
    expect(out.version).toBe(TEAM_SCHEMA_VERSION + 5);
    expect(out.name).toBeTruthy();
  });

  it('올려 줄 업그레이더가 없으면 TOO_OLD로 남긴다', () => {
    const out = migrateTeamDoc({ ...team(), schemaVersion: 1 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('TOO_OLD');
    // 무엇이 안 보이는지 사용자에게 말해 줄 수 있어야 한다
    expect(out.name).toBeTruthy();
    expect(out.id).toBeTruthy();
  });

  it('팀 문서라고 볼 수 없으면 CORRUPT다', () => {
    for (const bad of [{}, null, 'nope', { id: 't', name: 'x' }]) {
      const out = migrateTeamDoc(bad);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('CORRUPT');
    }
  });

  it('버전 필드가 없어도 팀 형태이면 손상이 아니라 옛 팀(v0)으로 읽는다', () => {
    // schemaVersion은 티어/레벨을 넣으면서 2로 시작했다. 그전 팀에는 필드 자체가 없는데,
    // 그걸 CORRUPT로 부르면 멀쩡한 옛 팀을 두고 "데이터가 손상됐다"고 거짓말하게 된다.
    const legacy: Record<string, unknown> = { ...team() };
    delete legacy.schemaVersion;

    const out = migrateTeamDoc(legacy);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('TOO_OLD');
    expect(out.version).toBe(LEGACY_TEAM_VERSION);
    // 무엇이 없어졌는지 이름으로 말할 수 있어야 한다
    expect(out.name).toBe(legacy.name);
    expect(out.id).toBe(legacy.id);
  });

  it('업그레이더가 던지면 FAILED로 남기고 멈춘다', () => {
    const boom: TeamMigration[] = [
      { from: 2, note: '터진다', up: () => { throw new Error('x'); } },
    ];
    const out = migrateTeamDoc({ ...team(), schemaVersion: 2 }, boom, 3);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('FAILED');
  });

  it('업그레이드 결과가 팀 형태가 아니면 통과시키지 않는다', () => {
    const wrecker: TeamMigration[] = [
      { from: 2, note: '선수를 다 지운다', up: (d) => ({ ...d, players: [] }) },
    ];
    const out = migrateTeamDoc({ ...team(), schemaVersion: 2 }, wrecker, 3);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('CORRUPT');
  });
});

describe('isUnrecoverable', () => {
  it('올려 줄 방법이 없는 옛 팀만 정리 대상이다', () => {
    expect(isUnrecoverable('TOO_OLD')).toBe(true);
  });

  it('나머지는 절대 정리하지 않는다', () => {
    // 특히 TOO_NEW — 다른 기기의 최신 빌드에서 저장한 멀쩡한 팀이다. 새로고침 한 번이면
    // 열리는데 여기서 true가 되면 그 팀을 진짜로 지워 버린다.
    for (const reason of ['TOO_NEW', 'CORRUPT', 'FAILED'] satisfies SkipReason[]) {
      expect(isUnrecoverable(reason)).toBe(false);
    }
  });
});

describe('isTeamShaped', () => {
  it('진짜 팀은 통과한다', () => {
    expect(isTeamShaped(team())).toBe(true);
  });

  it('필수 필드가 빠지면 걸러진다', () => {
    const t = team();
    expect(isTeamShaped({ ...t, players: [] })).toBe(false);
    expect(isTeamShaped({ ...t, lineup: undefined })).toBe(false);
    expect(isTeamShaped({ ...t, ownerUid: 42 })).toBe(false);
  });
});

describe('normalizeTeam', () => {
  it('seasonNo가 없으면 1로 채운다', () => {
    const t = { ...team(), seasonNo: undefined };
    expect(normalizeTeam(t).seasonNo).toBe(1);
  });

  it('채울 것이 없으면 원본을 그대로 돌려준다', () => {
    const t = { ...team(), seasonNo: 3 };
    expect(normalizeTeam(t)).toBe(t);
  });

  it('선수별 선택 필드는 채우지 않는다 (문서 크기 방어)', () => {
    // 46명 × 빈 SeasonStat이면 팀 문서가 5~10KB 늘어난다. 읽는 쪽이 ??로 정규화한다.
    const out = normalizeTeam(team());
    expect(out.players.every((p) => p.career === undefined)).toBe(true);
    expect(out.players.every((p) => p.seasonLog === undefined)).toBe(true);
  });
});

describe('normalizeSettings', () => {
  it('빈 값이면 기본 설정이다', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('구 soundEnabled를 세 채널로 승격한다', () => {
    // store.loadSettings에 인라인으로 있던 동작을 그대로 보존한다.
    const out = normalizeSettings({ soundEnabled: false, bgmVolume: 0.5 });
    expect(out.sfxEnabled).toBe(false);
    expect(out.crowdEnabled).toBe(false);
    expect(out.bgmEnabled).toBe(false);
    // 당시 bgmVolume은 실제로 관중 볼륨에 쓰였다
    expect(out.crowdVolume).toBe(0.5);
  });

  it('저장된 값이 기본값을 이긴다', () => {
    expect(normalizeSettings({ regulationInnings: 7, useDH: false }).regulationInnings).toBe(7);
    expect(normalizeSettings({ regulationInnings: 7, useDH: false }).useDH).toBe(false);
  });

  it('없던 필드는 기본값으로 채워진다', () => {
    // pitchSpeedScale이 undefined면 궤적 계산이 NaN이 된다.
    const out = normalizeSettings({ sfxEnabled: true });
    expect(out.pitchSpeedScale).toBe(DEFAULT_SETTINGS.pitchSpeedScale);
    expect(Number.isFinite(out.pitchSpeedScale)).toBe(true);
  });
});

describe('normalizeLeague', () => {
  function ref(t: Team, isCPU: boolean): LeagueTeamRef {
    return {
      teamId: t.id,
      ownerUid: t.ownerUid,
      name: t.name,
      abbr: t.abbr,
      primaryColor: t.primaryColor,
      secondaryColor: t.secondaryColor,
      logoId: t.logoId,
      isCPU,
    };
  }

  function setup(): { league: League; cpus: Team[] } {
    const mine = team('nl-mine', 'me');
    const cpus = [team('nl-a', 'cpu'), team('nl-b', 'cpu')];
    return {
      league: createLeague(
        'me',
        '리그',
        [ref(mine, false), ...cpus.map((c) => ref(c, true))],
        DEFAULT_SETTINGS,
        1,
        cpus,
      ),
      cpus,
    };
  }

  const none = { lookupTeam: () => null };

  it('멱등이다 (두 번 돌려도 같은 결과)', () => {
    // 저장할 때마다 도는 함수라 이게 깨지면 문서가 매번 달라져 원격 쓰기가 늘어난다.
    const { league } = setup();
    const once = normalizeLeague(league, none)!;
    const twice = normalizeLeague(once.league, none)!;
    expect(twice.changed).toBe(false);
    expect(twice.league).toBe(once.league);
  });

  it('설정이 비어 있으면 기본값으로 채운다', () => {
    const { league } = setup();
    const broken = { ...league, settings: { sfxEnabled: true } as never };
    const out = normalizeLeague(broken, none)!;
    expect(out.changed).toBe(true);
    expect(out.league.settings.pitchSpeedScale).toBe(DEFAULT_SETTINGS.pitchSpeedScale);
  });

  it('cpuTeams가 없는 옛 리그를 캐시에서 복원한다', () => {
    const { league, cpus } = setup();
    const legacy: League = { ...league, cpuTeams: undefined };
    const byId = new Map(cpus.map((t) => [t.id, t]));

    const out = normalizeLeague(legacy, { lookupTeam: (id) => byId.get(id) ?? null })!;
    expect(out.changed).toBe(true);
    expect(out.league.cpuTeams).toHaveLength(cpus.length);
  });

  it('캐시에도 없으면 반쪽으로 두지 않고 통째로 비운다', () => {
    // 일부만 채우면 "일부 경기만 재현되는" 리그가 되어 없느니만 못하다.
    const { league } = setup();
    const half: League = { ...league, cpuTeams: [league.cpuTeams![0]] };
    const out = normalizeLeague(half, none)!;
    expect(out.league.cpuTeams).toBeUndefined();
  });

  it('문서에만 있는 CPU 팀은 캐시로 되돌릴 목록에 올린다', () => {
    // 다른 기기에서 리그를 열었을 때 CPU 팀 캐시를 되살리는 경로다.
    const { league, cpus } = setup();
    const out = normalizeLeague(league, none)!;
    expect(out.restoredTeams.map((t) => t.id).sort()).toEqual(cpus.map((t) => t.id).sort());
  });

  it('형태가 아예 깨졌으면 null이다', () => {
    expect(normalizeLeague(null, none)).toBeNull();
    expect(normalizeLeague({ id: 'x' }, none)).toBeNull();
  });
});
