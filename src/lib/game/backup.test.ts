import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { createLeague, recordPostseasonResult, recordResult, startPostseason } from './league';
import {
  BACKUP_ENVELOPE_VERSION,
  BACKUP_FORMAT,
  backupFileName,
  buildBackup,
  parseBackup,
  retargetBackup,
  type BackupPayload,
} from './backup';
import { checkTeamSeal, sealTeam } from './integrity';
import { DEFAULT_SETTINGS, TEAM_SCHEMA_VERSION } from './types';
import type { League, LeagueTeamRef, Team } from './types';

function team(seed: string, ownerUid: string): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid });
}

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

/** 내 팀 1 + CPU 3, 정규 일정을 끝내고 포스트시즌까지 진행한 백업 */
function payload(uid = 'guest_a'): { data: BackupPayload; mine: Team; league: League } {
  const mine = team('bk-mine', uid);
  const cpus = [team('bk-a', 'cpu'), team('bk-b', 'cpu'), team('bk-c', 'cpu')];
  let league = createLeague(
    uid,
    '백업 리그',
    [ref(mine, false), ...cpus.map((c) => ref(c, true))],
    DEFAULT_SETTINGS,
    1,
    cpus,
  );
  // 정규 일정을 모두 소화해 포스트시즌 대진을 만든다 (참조가 가장 많이 생기는 상태).
  for (const g of league.schedule) league = recordResult(league, g.id, 5, 3);
  league = startPostseason(league);
  const first = league.postseason!.series[0].games[0];
  league = recordPostseasonResult(league, first.id, 4, 2);

  return {
    data: {
      teams: [mine, ...cpus],
      leagues: [league],
      settings: DEFAULT_SETTINGS,
      records: [],
      activeTeamId: mine.id,
      nickname: '감독',
    },
    mine,
    league,
  };
}

/**
 * "원래 주인의 문서가 같은 브라우저에 그대로 남아 있는" 상태.
 * 게스트 -> 구글 승격이 정확히 이 상황이다.
 */
function collideAll(data: BackupPayload): (id: string) => boolean {
  const ids = new Set<string>([
    ...data.teams.map((t) => t.id),
    ...data.leagues.map((l) => l.id),
  ]);
  return (id) => ids.has(id);
}

describe('retargetBackup', () => {
  it('소유자를 이 계정으로 갈아끼운다', () => {
    const { data, mine } = payload('guest_a');
    const { payload: next } = retargetBackup(data, 'google_b', 'guest_a', collideAll(data));

    expect(next.teams.find((t) => t.name === mine.name)!.ownerUid).toBe('google_b');
    expect(next.leagues[0].ownerUid).toBe('google_b');
  });

  it('주인이 바뀐 팀은 서명을 떼고 나간다', () => {
    // 서명은 팀 id와 소유자를 포함해 찍힌다. 그대로 들고 가면 새 계정에서 반드시 어긋나
    // 계정을 옮긴 것뿐인 정상 백업이 조작으로 잡히고 골드가 0이 된다.
    const { data, mine } = payload('guest_a');
    const sealed = { ...data, teams: data.teams.map(sealTeam) };
    const { payload: next } = retargetBackup(sealed, 'google_b', 'guest_a', collideAll(sealed));

    const moved = next.teams.find((t) => t.name === mine.name)!;
    expect('seal' in moved).toBe(false);
    // undefined로 남기면 Firestore가 문서를 통째로 거부한다
    expect(Object.values(moved).includes(undefined)).toBe(false);
    expect(checkTeamSeal(moved, { anchoredAt: null })).toBe('EXEMPT');
  });

  it('같은 계정으로 되돌리면 서명을 그대로 둔다', () => {
    // id도 주인도 그대로인 멱등 복구다. 여기서까지 서명을 떼면 보호가 한 칸 헐거워진다.
    const { data, mine } = payload('guest_a');
    const sealed = { ...data, teams: data.teams.map(sealTeam) };
    const { payload: next } = retargetBackup(sealed, 'guest_a', 'guest_a', () => false);

    const same = next.teams.find((t) => t.name === mine.name)!;
    expect(checkTeamSeal(same, { anchoredAt: 1 })).toBe('OK');
  });

  it('LeagueTeamRef.ownerUid도 함께 바꾼다', () => {
    // 여기를 빠뜨리면 리그가 목록에는 보이는데 "내 팀이 참가하지 않은 리그"로 잠긴다.
    // 리그 화면과 relinkPlayerTeam이 전부 이 필드로 내 팀을 찾는다.
    const { data } = payload('guest_a');
    const { payload: next } = retargetBackup(data, 'google_b', 'guest_a', collideAll(data));

    const myRef = next.leagues[0].teams.find((r) => !r.isCPU)!;
    expect(myRef.ownerUid).toBe('google_b');
    // CPU는 그대로 — 소유자를 바꾸면 CPU 팀이 내 팀 목록에 나타난다
    expect(next.leagues[0].teams.filter((r) => r.isCPU).every((r) => r.ownerUid === 'cpu')).toBe(true);
  });

  it('참조 지점을 하나도 빠뜨리지 않는다', () => {
    // 팀 id를 품은 자리가 열두 군데로 흩어져 있다. 하나라도 빠지면 리그가 조용히 깨진다.
    const { data, league } = payload('guest_a');
    const { payload: next, idMap } = retargetBackup(data, 'google_b', 'guest_a', collideAll(data));
    const l = next.leagues[0];
    const m = (id: string) => idMap[id];

    expect(next.teams.map((t) => t.id)).toEqual(data.teams.map((t) => m(t.id)));
    expect(l.id).toBe(m(league.id));
    expect(l.teams.map((r) => r.teamId)).toEqual(league.teams.map((r) => m(r.teamId)));
    expect(l.cpuTeams!.map((c) => c.id)).toEqual(league.cpuTeams!.map((c) => m(c.id)));
    expect(l.schedule.map((g) => [g.awayTeamId, g.homeTeamId])).toEqual(
      league.schedule.map((g) => [m(g.awayTeamId), m(g.homeTeamId)]),
    );
    expect(l.postseason!.series.map((s) => [s.hiSeedId, s.loSeedId])).toEqual(
      league.postseason!.series.map((s) => [m(s.hiSeedId), m(s.loSeedId)]),
    );
    expect(l.postseason!.series.flatMap((s) => s.games).map((g) => [g.awayTeamId, g.homeTeamId])).toEqual(
      league.postseason!.series.flatMap((s) => s.games).map((g) => [m(g.awayTeamId), m(g.homeTeamId)]),
    );
    expect(next.activeTeamId).toBe(m(data.activeTeamId!));
    // 새 id는 모두 원본과 달라야 한다 (collideAll이 전부 충돌시켰으므로)
    expect(Object.entries(idMap).every(([from, to]) => from !== to)).toBe(true);
  });

  it('두 문서가 같은 새 id를 받지 않는다', () => {
    const { data } = payload('guest_a');
    const { idMap } = retargetBackup(data, 'google_b', 'guest_a', collideAll(data));
    const news = Object.values(idMap);
    expect(new Set(news).size).toBe(news.length);
  });

  it('isTaken이 늘 참이어도 멈춘다 (무한 루프 방어)', () => {
    // 호출부가 잘못돼도 브라우저가 멈추면 안 된다.
    const { data } = payload('guest_a');
    const { idMap } = retargetBackup(data, 'google_b', 'guest_a', () => true);
    expect(Object.keys(idMap).length).toBeGreaterThan(0);
  });

  it('갈아끼운 뒤에도 참조 그래프가 서로 맞는다', () => {
    const { data } = payload('guest_a');
    const { payload: next } = retargetBackup(data, 'google_b', 'guest_a', collideAll(data));
    const l = next.leagues[0];
    const known = new Set(l.teams.map((r) => r.teamId));

    expect(new Set(next.teams.map((t) => t.id))).toEqual(known);
    expect(l.cpuTeams!.every((c) => known.has(c.id))).toBe(true);
    for (const g of l.schedule) {
      expect(known.has(g.awayTeamId)).toBe(true);
      expect(known.has(g.homeTeamId)).toBe(true);
    }
    for (const s of l.postseason!.series) {
      expect(known.has(s.hiSeedId)).toBe(true);
      expect(known.has(s.loSeedId)).toBe(true);
      for (const g of s.games) {
        expect(known.has(g.awayTeamId)).toBe(true);
        expect(known.has(g.homeTeamId)).toBe(true);
      }
    }
    expect(known.has(next.activeTeamId!)).toBe(true);
  });

  it('부딪히지 않으면 id를 그대로 둔다 (같은 계정 복구는 멱등)', () => {
    const { data, mine, league } = payload('guest_a');
    const { payload: next, idMap } = retargetBackup(data, 'guest_a', 'guest_a', () => false);

    expect(next.teams.find((t) => t.id === mine.id)).toBeDefined();
    expect(next.leagues[0].id).toBe(league.id);
    expect(Object.entries(idMap).every(([from, to]) => from === to)).toBe(true);
  });

  it('충돌하는 id만 결정론적으로 새로 만든다', () => {
    // 게스트 팀이 같은 브라우저에 남아 있는 상태에서 구글 계정으로 넣는 상황.
    const { data, mine } = payload('guest_a');
    const taken = new Set([mine.id]);
    const a = retargetBackup(data, 'google_b', 'guest_a', (id) => taken.has(id));
    const b = retargetBackup(data, 'google_b', 'guest_a', (id) => taken.has(id));

    expect(a.idMap[mine.id]).not.toBe(mine.id);
    // 두 번 돌려도 같은 id가 나온다
    expect(b.idMap[mine.id]).toBe(a.idMap[mine.id]);
    // 안 부딪힌 리그 id는 그대로
    expect(a.payload.leagues[0].id).toBe(data.leagues[0].id);
  });

  it('경기 기록의 팀 참조도 따라간다', () => {
    const { data, mine, league } = payload('guest_a');
    const withRecord: BackupPayload = {
      ...data,
      records: [
        {
          id: 'r1',
          kind: 'LEAGUE',
          playedAt: 1,
          rules: { ...DEFAULT_SETTINGS },
          leagueId: league.id,
          away: { teamId: mine.id, name: 'x', abbr: 'X', primaryColor: '#fff', runs: 1, hits: 1, errors: 0, lob: 0, lineScore: [1], lines: [] },
          home: { teamId: league.teams[1].teamId, name: 'y', abbr: 'Y', primaryColor: '#000', runs: 0, hits: 0, errors: 0, lob: 0, lineScore: [0], lines: [] },
          highlights: [],
        },
      ],
    };
    const { payload: next, idMap } = retargetBackup(withRecord, 'google_b', 'guest_a', collideAll(withRecord));
    const r = next.records[0];

    expect(r.leagueId).toBe(idMap[league.id]);
    expect(r.away.teamId).toBe(idMap[mine.id]);
    expect(r.home.teamId).toBe(idMap[league.teams[1].teamId]);
  });

  it('선수 id는 바꾸지 않는다 (팀 문서 안에서만 유효하다)', () => {
    const { data, mine } = payload('guest_a');
    const { payload: next } = retargetBackup(data, 'google_b', 'guest_a', collideAll(data));
    const t = next.teams.find((x) => x.name === mine.name)!;

    expect(t.players.map((p) => p.id)).toEqual(mine.players.map((p) => p.id));
    // 타순·로테이션이 그대로 맞아떨어진다
    expect(t.lineup.every((id) => t.players.some((p) => p.id === id))).toBe(true);
    expect(t.rotation.every((id) => t.players.some((p) => p.id === id))).toBe(true);
  });
});

describe('parseBackup', () => {
  function file(uid = 'guest_a') {
    const { data } = payload(uid);
    return JSON.stringify(
      buildBackup({ uid, payload: data, appVersion: '0.1.0', exportedAt: 1_700_000_000_000 }),
    );
  }

  it('정상 백업을 읽고 요약을 만든다', () => {
    const out = parseBackup(file(), 'guest_a');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary.sameAccount).toBe(true);
    expect(out.summary.leagueCount).toBe(1);
    expect(out.summary.playerCount).toBeGreaterThan(50);
    expect(out.summary.teamSchemaVersion).toBe(TEAM_SCHEMA_VERSION);
    expect(out.summary.fromFuture).toBe(false);
  });

  it('다른 계정에서 만든 백업임을 알려 준다', () => {
    const out = parseBackup(file('guest_a'), 'google_b');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.summary.sameAccount).toBe(false);
  });

  it('JSON이 아니면 거절한다', () => {
    const out = parseBackup('not json', 'x');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('JSON');
  });

  it('다른 앱의 JSON이면 거절한다', () => {
    const out = parseBackup(JSON.stringify({ hello: 1 }), 'x');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('백업 파일이 아닙니다');
  });

  it('더 새로운 봉투 버전이면 거절한다', () => {
    const bad = JSON.stringify({
      format: BACKUP_FORMAT,
      envelope: BACKUP_ENVELOPE_VERSION + 1,
      data: { teams: [], leagues: [] },
    });
    const out = parseBackup(bad, 'x');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('새로운 버전');
  });

  it('내용물이 미래 스키마면 표시한다', () => {
    const bad = JSON.stringify({
      format: BACKUP_FORMAT,
      envelope: BACKUP_ENVELOPE_VERSION,
      uid: 'x',
      exportedAt: 1,
      teamSchemaVersion: TEAM_SCHEMA_VERSION + 3,
      data: { teams: [], leagues: [], records: [] },
    });
    const out = parseBackup(bad, 'x');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.summary.fromFuture).toBe(true);
  });

  it('내용이 손상됐으면 거절한다', () => {
    const bad = JSON.stringify({
      format: BACKUP_FORMAT,
      envelope: BACKUP_ENVELOPE_VERSION,
      data: { teams: 'nope' },
    });
    const out = parseBackup(bad, 'x');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('손상');
  });
});

describe('backupFileName', () => {
  it('콜론·공백 없는 ASCII 파일명을 만든다', () => {
    const name = backupFileName(Date.parse('2026-08-12T15:30:00'));
    expect(name).toMatch(/^anyway-baseball-backup-\d{8}-\d{4}\.json$/);
    expect(name).not.toMatch(/[: ]/);
  });

  it('접미사를 붙일 수 있다 (가져오기 직전 자동 백업)', () => {
    expect(backupFileName(Date.now(), '-before-import')).toContain('-before-import.json');
  });
});
