import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { emptySeason, generateTeam } from './generator';
import {
  SEASON_LOG_LIMIT,
  careerOf,
  careerWithCurrent,
  closeSeason,
  computeTitles,
  contributionScore,
  qualifiedIP3,
  qualifiedPA,
  repairSplits,
  repairTeam,
  seasonNo,
} from './season';
import type { Player, SeasonStat, Team } from './types';

function team(): Team {
  return generateTeam(new Rng(seedFromString('season-team')), { ownerUid: 'me' });
}

/** 로스터 앞쪽 n명에게 시즌 기록을 심는다 */
function withLines(t: Team, lines: Partial<SeasonStat>[]): Team {
  return {
    ...t,
    players: t.players.map((p, i) =>
      i < lines.length ? { ...p, season: { ...emptySeason(), ...lines[i] } } : p,
    ),
  };
}

describe('closeSeason', () => {
  it('이번 시즌이 통산으로 넘어가고 시즌 기록이 비워진다', () => {
    const t = withLines(team(), [{ g: 10, pa: 40, ab: 36, h: 12, hr: 3, rbi: 9 }]);
    const before = t.players[0].season;

    const closed = closeSeason(t);
    const p = closed.players[0];

    expect(p.season).toEqual(emptySeason());
    expect(careerOf(p).h).toBe(before.h);
    expect(careerOf(p).hr).toBe(before.hr);
    expect(careerOf(p).g).toBe(before.g);
  });

  it('두 시즌을 마감하면 통산이 두 시즌의 합이다', () => {
    let t = withLines(team(), [{ g: 10, ab: 30, h: 9, hr: 2 }]);
    t = closeSeason(t);
    t = withLines(t, [{ g: 12, ab: 40, h: 14, hr: 5 }]);
    t = closeSeason(t);

    const c = careerOf(t.players[0]);
    expect(c.g).toBe(22);
    expect(c.ab).toBe(70);
    expect(c.h).toBe(23);
    expect(c.hr).toBe(7);
  });

  it('시즌 번호가 오르고 시즌 로그가 쌓인다', () => {
    let t = withLines(team(), [{ g: 5, ab: 10, h: 3 }]);
    expect(seasonNo(t)).toBe(1);

    t = closeSeason(t);
    expect(seasonNo(t)).toBe(2);
    expect(t.players[0].seasonLog).toEqual([
      { seasonNo: 1, stat: { ...emptySeason(), g: 5, ab: 10, h: 3 } },
    ]);
  });

  it('시즌 로그는 상한을 넘지 않고 최근 것만 남는다', () => {
    let t = team();
    for (let i = 1; i <= SEASON_LOG_LIMIT + 3; i++) {
      t = withLines(t, [{ g: 1, ab: i, h: 1 }]);
      t = closeSeason(t);
    }
    const log = t.players[0].seasonLog!;
    expect(log).toHaveLength(SEASON_LOG_LIMIT);
    // 가장 오래된 시즌부터 밀려난다
    expect(log[0].seasonNo).toBe(4);
    expect(log[log.length - 1].seasonNo).toBe(SEASON_LOG_LIMIT + 3);
  });

  it('한 경기도 안 뛴 선수는 로그를 남기지 않는다', () => {
    const t = closeSeason(team());
    expect(t.players.every((p) => !p.seasonLog?.length)).toBe(true);
  });

  it('능력치·레벨·티어는 건드리지 않는다', () => {
    const t = withLines(team(), [{ g: 10, ab: 30, h: 10 }]);
    const closed = closeSeason(t);
    for (let i = 0; i < t.players.length; i++) {
      const a = t.players[i];
      const b = closed.players[i];
      expect(b.batting).toEqual(a.batting);
      expect(b.tier).toBe(a.tier);
      expect(b.level).toBe(a.level);
      expect(b.trainingPoints).toBe(a.trainingPoints);
      expect(b.potential).toBe(a.potential);
    }
  });

  it('통산 표시값은 통산 + 이번 시즌이다', () => {
    let t = withLines(team(), [{ g: 10, ab: 30, h: 9 }]);
    t = closeSeason(t);
    t = withLines(t, [{ g: 4, ab: 12, h: 5 }]);

    expect(careerOf(t.players[0]).h).toBe(9);
    expect(careerWithCurrent(t.players[0]).h).toBe(14);
  });

  it('career 필드가 없는 옛 선수도 그대로 읽힌다', () => {
    const t = team();
    // 스키마 버전을 올리지 않으므로 이 필드가 없는 저장 데이터가 실제로 존재한다
    expect(t.players[0].career).toBeUndefined();
    expect(careerOf(t.players[0])).toEqual(emptySeason());
  });
});

describe('computeTitles', () => {
  const games = 20;

  it('규정 타석을 못 채우면 타율왕이 될 수 없다', () => {
    const min = qualifiedPA(games);
    const hits = Math.round(min * 0.3);
    const t = withLines(team(), [
      // 1타수 1안타 — 타율 1.000이지만 규정 미달
      { g: 1, pa: 1, ab: 1, h: 1 },
      // 규정을 채운 3할 타자
      { g: games, pa: min, ab: min, h: hits },
    ]);

    const avg = computeTitles(t.players, games).find((x) => x.id === 'AVG')!;
    expect(avg.playerId).toBe(t.players[1].id);
    expect(avg.value).toBe((hits / min).toFixed(3).slice(1));
  });

  it('홈런·타점·도루는 누적이라 규정 타석을 따지지 않는다', () => {
    const t = withLines(team(), [
      { g: 3, pa: 10, ab: 10, h: 4, hr: 4, rbi: 9, sb: 5 },
      { g: games, pa: 80, ab: 70, h: 20, hr: 2, rbi: 5, sb: 1 },
    ]);
    const titles = computeTitles(t.players, games);

    expect(titles.find((x) => x.id === 'HR')!.playerId).toBe(t.players[0].id);
    expect(titles.find((x) => x.id === 'HR')!.value).toBe('4홈런');
    expect(titles.find((x) => x.id === 'RBI')!.playerId).toBe(t.players[0].id);
    expect(titles.find((x) => x.id === 'SB')!.playerId).toBe(t.players[0].id);
  });

  it('방어율왕은 낮을수록 이기고 규정 이닝이 필요하다', () => {
    const minIP3 = qualifiedIP3(games);
    const t = withLines(team(), [
      // 1이닝 무실점 — 방어율 0.00이지만 규정 미달
      { g: 1, ip3: 3, er: 0 },
      { g: games, ip3: minIP3, er: 6 },
      { g: games, ip3: minIP3, er: 20 },
    ]);

    const eraTitle = computeTitles(t.players, games).find((x) => x.id === 'ERA')!;
    expect(eraTitle.playerId).toBe(t.players[1].id);
  });

  it('아무도 안 뛰었으면 타이틀이 없다', () => {
    expect(computeTitles(team().players, games)).toEqual([]);
  });

  it('기여도는 잘한 선수가 더 높다', () => {
    const great = { ...emptySeason(), g: 20, pa: 90, ab: 80, h: 30, hr: 10, rbi: 25, double: 8 };
    const poor = { ...emptySeason(), g: 20, pa: 90, ab: 80, h: 12, hr: 1, rbi: 5 };
    expect(contributionScore(great)).toBeGreaterThan(contributionScore(poor));

    const ace = { ...emptySeason(), g: 20, ip3: 360, pk: 110, w: 14, er: 30 };
    const batted = { ...emptySeason(), g: 20, ip3: 300, pk: 40, w: 4, er: 80 };
    expect(contributionScore(ace)).toBeGreaterThan(contributionScore(batted));
  });

  it('MVP는 가장 기여도가 높은 선수다', () => {
    const t = withLines(team(), [
      { g: 20, pa: 90, ab: 80, h: 32, hr: 12, rbi: 30, double: 9 },
      { g: 20, pa: 90, ab: 80, h: 15, hr: 1, rbi: 6 },
    ]);
    const mvp = computeTitles(t.players, games).find((x) => x.id === 'MVP')!;
    expect(mvp.playerId).toBe(t.players[0].id);
  });
});

describe('repairSplits', () => {
  /** 시즌 타수 ab, 스플릿 타수 vsR[0]인 선수 */
  function withSplit(ab: number, splitAb: number): Player {
    const p = team().players[0];
    return {
      ...p,
      season: { ...emptySeason(), ab },
      splits: { vsR: [splitAb, 0] as [number, number] },
    };
  }

  it('실제 타수보다 많이 쌓인 스플릿은 버린다', () => {
    // 이중 집계는 2의 거듭제곱으로 부푼다. 타율만 살려도 초기 경기 쪽으로 지수 가중된
    // 거짓말이 되므로 통째로 버린다.
    expect(repairSplits(withSplit(120, 833)).splits).toBeUndefined();
  });

  it('정상 데이터는 손대지 않는다 (같은 객체를 그대로 돌려준다)', () => {
    const p = withSplit(120, 120);
    expect(repairSplits(p)).toBe(p);
  });

  it('스플릿이 생기기 전에 쌓인 기록(스플릿 < 타수)도 그대로 둔다', () => {
    const p = withSplit(300, 40);
    expect(repairSplits(p)).toBe(p);
  });

  it('통산 기록도 실제 타수에 포함한다', () => {
    const p = { ...withSplit(20, 200), career: { ...emptySeason(), ab: 400 } };
    expect(repairSplits(p).splits).toBeDefined();
  });

  it('스플릿이 없는 선수도 안전하다', () => {
    const p = team().players[0];
    expect(repairSplits(p)).toBe(p);
  });

  it('repairTeam은 고칠 것이 없으면 원본 팀을 그대로 돌려준다', () => {
    const t = team();
    expect(repairTeam(t)).toBe(t);
  });

  it('repairTeam은 부푼 선수만 골라 고친다', () => {
    const t = team();
    const bloated = {
      ...t,
      players: t.players.map((p, i) =>
        i === 0 ? { ...p, splits: { vsR: [999, 300] as [number, number] } } : p,
      ),
    };
    const fixed = repairTeam(bloated);
    expect(fixed).not.toBe(bloated);
    expect(fixed.players[0].splits).toBeUndefined();
    expect(fixed.players[1]).toBe(bloated.players[1]);
  });
});
