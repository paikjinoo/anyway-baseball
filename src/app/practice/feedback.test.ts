import { describe, expect, it } from 'vitest';
import { GOOD_TIMING_MS, describeSwing, summarize, type SwingLog } from './feedback';
import type { PitchResult } from '@/lib/game/types';

/** 필요한 필드만 채운 최소 결과. describeSwing이 읽는 것은 swing과 trajectory뿐이다. */
function result(over: {
  swing?: boolean;
  timingMs?: number;
  aimY?: number;
  zoneY?: number;
  contact?: boolean;
  kind?: PitchResult['kind'];
  noTrajectory?: boolean;
}): PitchResult {
  return {
    pitchNumber: 1,
    trajectory: over.noTrajectory
      ? undefined
      : ({ zoneX: 0, zoneY: over.zoneY ?? 0 } as PitchResult['trajectory']),
    swing: {
      swing: over.swing ?? true,
      type: 'NORMAL',
      aimX: 0,
      aimY: over.aimY ?? 0,
      timingMs: over.timingMs ?? 0,
    },
    contact: over.contact ?? false,
    kind: over.kind ?? 'STRIKE_SWINGING',
    stealResults: [],
    runnerMoves: [],
    fielders: [],
    outsRecorded: 0,
    runsScored: 0,
    scoringPlayerIds: [],
    rbi: 0,
    description: '',
    state: {} as PitchResult['state'],
    atBatEnded: false,
  };
}

describe('describeSwing', () => {
  it('방망이를 내지 않으면 피드백이 없다', () => {
    // 지켜본 공에는 타이밍이라는 개념 자체가 없다
    expect(describeSwing(result({ swing: false }))).toBeNull();
  });

  it('공을 던지지 않은 플레이도 피드백이 없다', () => {
    expect(describeSwing(result({ noTrajectory: true }))).toBeNull();
  });

  it('음수 타이밍은 이른 스윙이다', () => {
    // SwingCommand.timingMs의 정의가 "음수 = 이른 스윙"이라, 여기서 부호를 뒤집으면
    // 화면이 정반대로 알려 주게 된다. 연습 모드에서 그건 치명적이다.
    const early = describeSwing(result({ timingMs: -40 }))!;
    expect(early.detail).toContain('40ms 빨랐음');

    const late = describeSwing(result({ timingMs: 40 }))!;
    expect(late.detail).toContain('40ms 늦었음');
  });

  it('오차가 작으면 정확하다고 알려 준다', () => {
    const good = describeSwing(result({ timingMs: GOOD_TIMING_MS - 1, aimY: 0, zoneY: 0 }))!;
    expect(good.detail).toContain('타이밍 정확');
    expect(good.detail).toContain('조준 정확');
  });

  it('조준이 공보다 위면 위라고 알려 준다', () => {
    const above = describeSwing(result({ aimY: 0.5, zoneY: 0.2 }))!;
    expect(above.vertical).toBeCloseTo(0.3, 5);
    expect(above.detail).toContain('위');

    const below = describeSwing(result({ aimY: -0.4, zoneY: 0.2 }))!;
    expect(below.detail).toContain('아래');
  });
});

describe('summarize', () => {
  const log = (timingMs: number, contact: boolean): SwingLog => ({
    pitchNumber: 0,
    kind: contact ? 'SINGLE' : 'STRIKE_SWINGING',
    contact,
    timingMs,
    vertical: 0,
    detail: '',
  });

  it('기록이 없으면 0이다', () => {
    expect(summarize([])).toEqual({ n: 0, contactRate: 0, avgTiming: 0, tendency: '-' });
  });

  it('컨택률과 평균 타이밍을 낸다', () => {
    const s = summarize([log(-30, true), log(-50, false), log(-40, false), log(-40, true)]);
    expect(s.n).toBe(4);
    expect(s.contactRate).toBe(0.5);
    expect(s.avgTiming).toBe(-40);
  });

  it('한쪽으로 쏠리면 버릇으로 알려 준다', () => {
    expect(summarize([log(-60, false), log(-50, false)]).tendency).toBe('전반적으로 빠름');
    expect(summarize([log(60, false), log(50, false)]).tendency).toBe('전반적으로 늦음');
    expect(summarize([log(5, true), log(-5, true)]).tendency).toBe('좋음');
  });
});
