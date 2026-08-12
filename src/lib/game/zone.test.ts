import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { simulateGame } from './league';
import { ZONE_STRIKE_LIMIT, ZONE_THIRD } from './constants';
import {
  ZONE_CELL_KO,
  describeLocation,
  screenCellToZoneCell,
  zoneCell,
} from './pitching';
import { mergeZoneSplits } from './matchReward';
import { DEFAULT_SETTINGS } from './types';

/**
 * 코스별 기록.
 *
 * 이 파일의 두 번째 블록이 "타수는 한 곳에서만 센다"를 기계가 지키게 하는 못이다.
 * 누가 새 결과 종류를 추가하며 engine.recordSplit을 우회하면 여기서 터진다.
 */

describe('zoneCell', () => {
  it('우타 기준으로 왼쪽 열이 몸쪽, 오른쪽 열이 바깥쪽이다', () => {
    expect(zoneCell(-0.9, 0, 'R') % 3).toBe(0); // 몸쪽
    expect(zoneCell(0, 0, 'R') % 3).toBe(1); // 한복판
    expect(zoneCell(0.9, 0, 'R') % 3).toBe(2); // 바깥쪽
  });

  it('좌타는 같은 좌표에서 열이 정확히 뒤집힌다', () => {
    // 두 손의 열을 더하면 늘 2다 — 한쪽이 0이면 다른 쪽은 2.
    for (const zx of [-1.4, -0.8, -0.36, 0.36, 0.8, 1.4]) {
      expect((zoneCell(zx, 0, 'R') % 3) + (zoneCell(zx, 0, 'L') % 3)).toBe(2);
    }
    // 한복판은 뒤집어도 한복판이다
    expect(zoneCell(0.1, 0, 'R')).toBe(zoneCell(0.1, 0, 'L'));
  });

  it('위아래는 손과 무관하게 같다', () => {
    expect(Math.floor(zoneCell(0, 0.9, 'R') / 3)).toBe(0); // 높은
    expect(Math.floor(zoneCell(0, 0, 'R') / 3)).toBe(1); // 가운데
    expect(Math.floor(zoneCell(0, -0.9, 'L') / 3)).toBe(2); // 낮은
  });

  it('존 밖 유인구도 9칸 안으로 들어온다', () => {
    // 판정에 쓰이는 좌표는 제구가 나쁘면 얼마든지 존 밖으로 나간다.
    // 버려 버리면 "낮은 바깥쪽 슬라이더에 속아 삼진"이 기록에서 사라진다.
    const rng = new Rng(seedFromString('zone-fuzz'));
    for (let i = 0; i < 10_000; i++) {
      const zx = rng.range(-3, 3);
      const zy = rng.range(-3, 3);
      const side = i % 2 ? 'L' : 'R';
      const cell = zoneCell(zx, zy, side);
      expect(Number.isInteger(cell)).toBe(true);
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThanOrEqual(8);
    }
  });

  it('칸 이름이 9개 있고 인덱스와 맞는다', () => {
    expect(ZONE_CELL_KO).toHaveLength(9);
    expect(ZONE_CELL_KO[zoneCell(-0.9, 0.9, 'R')]).toBe('높은 몸쪽');
    expect(ZONE_CELL_KO[zoneCell(0.9, -0.9, 'R')]).toBe('낮은 바깥쪽');
    expect(ZONE_CELL_KO[zoneCell(0, 0, 'R')]).toBe('한복판');
    // 좌타는 같은 이름이 반대쪽 칸에 붙는다
    expect(ZONE_CELL_KO[zoneCell(-0.9, 0.9, 'L')]).toBe('높은 바깥쪽');
  });

  it('우타에서는 실황 텍스트와 같은 칸을 가리킨다', () => {
    // 두 함수가 ZONE_THIRD를 공유하는지에 대한 회귀 방지.
    // describeLocation은 우타 기준 표기라 좌타는 비교 대상이 아니다.
    const cases: [number, number, string][] = [
      [0, 0, '한복판'],
      [-0.9, 0.9, '높은 몸쪽'],
      [0.9, -0.9, '낮은 바깥쪽'],
      [0.9, 0, '가운데 바깥쪽'],
      [-0.9, 0, '가운데 몸쪽'],
    ];
    for (const [zx, zy, expected] of cases) {
      expect(describeLocation(zx, zy)).toBe(expected);
      expect(ZONE_CELL_KO[zoneCell(zx, zy, 'R')]).toBe(expected);
    }
  });

  it('경계 상수가 판정 범위 안에 있다', () => {
    // ZONE_THIRD가 ZONE_STRIKE_LIMIT을 넘으면 가운데 열이 존 전체를 삼킨다.
    expect(ZONE_THIRD).toBeLessThan(ZONE_STRIKE_LIMIT);
    expect(ZONE_THIRD).toBeGreaterThan(0);
  });
});

describe('screenCellToZoneCell (화면 <-> 기록 좌표)', () => {
  // 반전이 두 겹이라(카메라 × 타자 손) 하나만 적용하면 절반의 경우에만 맞는다.
  // 눈으로는 거의 안 잡히므로 4조합을 전부 못 박는다.
  const TOP_RIGHT = 2;
  const TOP_LEFT = 0;

  it('정면 카메라 · 우타: 화면 오른쪽이 바깥쪽이다', () => {
    // mirrored=false면 패널 오른쪽이 zoneX>0이고, 우타에게 zoneX>0은 바깥쪽이다.
    expect(ZONE_CELL_KO[screenCellToZoneCell(TOP_RIGHT, 'R', false)]).toBe('높은 바깥쪽');
    expect(ZONE_CELL_KO[screenCellToZoneCell(TOP_LEFT, 'R', false)]).toBe('높은 몸쪽');
  });

  it('정면 카메라 · 좌타: 같은 자리가 몸쪽이 된다', () => {
    expect(ZONE_CELL_KO[screenCellToZoneCell(TOP_RIGHT, 'L', false)]).toBe('높은 몸쪽');
  });

  it('반전 카메라 · 우타: 화면 오른쪽이 몸쪽이 된다', () => {
    expect(ZONE_CELL_KO[screenCellToZoneCell(TOP_RIGHT, 'R', true)]).toBe('높은 몸쪽');
  });

  it('반전 카메라 · 좌타: 두 번 뒤집혀 원래대로 돌아온다', () => {
    expect(ZONE_CELL_KO[screenCellToZoneCell(TOP_RIGHT, 'L', true)]).toBe('높은 바깥쪽');
  });

  it('세로는 어느 조합에서도 뒤집히지 않는다', () => {
    for (const side of ['L', 'R'] as const) {
      for (const mirrored of [false, true]) {
        for (let i = 0; i < 9; i++) {
          // 화면 행과 기록 행이 같다 — 패널 위쪽은 늘 높은 공이다.
          expect(Math.floor(screenCellToZoneCell(i, side, mirrored) / 3)).toBe(Math.floor(i / 3));
        }
      }
    }
  });

  it('9칸을 빠짐없이 한 번씩 덮는다 (어느 조합에서도)', () => {
    for (const side of ['L', 'R'] as const) {
      for (const mirrored of [false, true]) {
        const mapped = Array.from({ length: 9 }, (_, i) => screenCellToZoneCell(i, side, mirrored));
        expect([...mapped].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      }
    }
  });
});

describe('코스 집계', () => {
  const res = simulateGame(
    generateTeam(new Rng(seedFromString('zone-away')), { ownerUid: 'a' }),
    generateTeam(new Rng(seedFromString('zone-home')), { ownerUid: 'b' }),
    DEFAULT_SETTINGS,
    'zone-1',
  );
  const players = [
    ...Object.values(res.state.away.roster),
    ...Object.values(res.state.home.roster),
  ];
  const batted = players.filter((p) => p.zoneSplits);

  it('한 경기에서 여러 타자가 코스 기록을 남긴다', () => {
    expect(batted.length).toBeGreaterThan(10);
  });

  it('9칸 타수 합이 좌우 스플릿 타수 합과 같다', () => {
    // 시뮬레이션은 피치 클락을 밟지 않으므로 등호가 성립한다.
    // 어긋나면 recordSplit을 우회한 결과 종류가 생겼다는 뜻이다.
    for (const p of batted) {
      const zoneAb = p.zoneSplits!.ab.reduce((a, b) => a + b, 0);
      const splitAb = (p.splits?.vsL?.[0] ?? 0) + (p.splits?.vsR?.[0] ?? 0);
      expect(zoneAb).toBe(splitAb);
    }
  });

  it('9칸 안타 합이 좌우 스플릿 안타 합과 같다', () => {
    for (const p of batted) {
      const zoneH = p.zoneSplits!.h.reduce((a, b) => a + b, 0);
      const splitH = (p.splits?.vsL?.[1] ?? 0) + (p.splits?.vsR?.[1] ?? 0);
      expect(zoneH).toBe(splitH);
    }
  });

  it('배열은 늘 9칸이고 안타가 타수를 넘지 않는다', () => {
    for (const p of batted) {
      const z = p.zoneSplits!;
      expect(z.ab).toHaveLength(9);
      expect(z.h).toHaveLength(9);
      for (let i = 0; i < 9; i++) expect(z.h[i]).toBeLessThanOrEqual(z.ab[i]);
    }
  });

  it('한 타자의 타수가 한 경기 상한을 넘지 않는다', () => {
    for (const p of batted) {
      expect(p.zoneSplits!.ab.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(8);
    }
  });
});

describe('mergeZoneSplits', () => {
  it('9칸을 빠짐없이 더한다', () => {
    const a = { ab: [1, 2, 3, 4, 5, 6, 7, 8, 9], h: [0, 1, 0, 1, 0, 1, 0, 1, 0] };
    const b = { ab: [10, 10, 10, 10, 10, 10, 10, 10, 10], h: [1, 1, 1, 1, 1, 1, 1, 1, 1] };
    const m = mergeZoneSplits(a, b)!;
    expect(m.ab).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(m.h).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1]);
  });

  it('한쪽이 없어도 다른 쪽을 그대로 돌려준다', () => {
    const a = { ab: [1, 0, 0, 0, 0, 0, 0, 0, 0], h: [1, 0, 0, 0, 0, 0, 0, 0, 0] };
    expect(mergeZoneSplits(a, undefined)).toEqual(a);
    expect(mergeZoneSplits(undefined, a)).toEqual(a);
  });

  it('둘 다 없으면 undefined다 (기록 없는 선수에 빈 배열을 심지 않는다)', () => {
    expect(mergeZoneSplits(undefined, undefined)).toBeUndefined();
  });
});
