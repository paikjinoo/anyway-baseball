import type { PitchResult, PlayResultKind } from '@/lib/game/types';

/**
 * 연습 타석의 피드백 계산.
 *
 * 순수 함수만 둔다 — 화면과 떼어 놓아야 값이 맞는지 테스트로 고정할 수 있고,
 * "빨랐다/늦었다"를 거꾸로 적는 종류의 실수가 조용히 살아남지 않는다.
 */

export interface SwingLog {
  pitchNumber: number;
  kind: PlayResultKind;
  contact: boolean;
  /** 스윙 타이밍 오차 (ms). 음수면 이른 스윙. */
  timingMs: number;
  /** 조준점과 공의 세로 어긋남. 양수면 배트가 공보다 위. */
  vertical: number;
  /** "18ms 빨랐음 · 배트가 0.12 위" */
  detail: string;
}

export const KIND_LABEL: Partial<Record<PlayResultKind, string>> = {
  SINGLE: '안타',
  DOUBLE: '2루타',
  TRIPLE: '3루타',
  HOME_RUN: '홈런',
  FOUL: '파울',
  STRIKE_SWINGING: '헛스윙',
  STRIKE_LOOKING: '루킹 스트라이크',
  BALL: '볼',
  GROUND_OUT: '땅볼',
  FLY_OUT: '뜬공',
  LINE_OUT: '직선타',
  POP_OUT: '내야 뜬공',
  FOUL_OUT: '파울 플라이',
  DOUBLE_PLAY: '병살타',
  FIELDERS_CHOICE: '야수선택',
  ERROR: '실책',
  SAC_FLY: '희생플라이',
  SAC_BUNT: '희생번트',
  INFIELD_FLY: '인필드 플라이',
  STRIKEOUT: '삼진',
  WALK: '볼넷',
  HIT_BY_PITCH: '몸에 맞는 공',
};

/** 이 오차 안쪽이면 잘 맞은 것으로 본다 (ms) */
export const GOOD_TIMING_MS = 15;

/**
 * 스윙 하나의 피드백. 방망이를 내지 않았으면 null이다 —
 * 지켜본 공에는 타이밍이라는 개념이 없다.
 */
export function describeSwing(r: PitchResult): SwingLog | null {
  if (!r.swing.swing || !r.trajectory) return null;

  const timingMs = Math.round(r.swing.timingMs);
  // SwingCommand.timingMs는 음수가 이른 스윙이다.
  const vertical = +(r.swing.aimY - r.trajectory.zoneY).toFixed(2);

  const timingText =
    Math.abs(timingMs) <= GOOD_TIMING_MS
      ? '타이밍 정확'
      : `${Math.abs(timingMs)}ms ${timingMs < 0 ? '빨랐음' : '늦었음'}`;

  const aimText =
    Math.abs(vertical) < 0.08
      ? '조준 정확'
      : `배트가 ${Math.abs(vertical).toFixed(2)} ${vertical > 0 ? '위' : '아래'}`;

  return {
    pitchNumber: r.pitchNumber,
    kind: r.kind,
    contact: r.contact,
    timingMs,
    vertical,
    detail: `${timingText} · ${aimText}`,
  };
}

export interface SwingSummary {
  n: number;
  contactRate: number;
  /** 평균 타이밍 오차 (ms). 음수면 전반적으로 이르다. */
  avgTiming: number;
  /** "빠름 / 늦음 / 좋음" — 평균이 한쪽으로 쏠렸는지 */
  tendency: string;
}

export function summarize(log: SwingLog[]): SwingSummary {
  if (!log.length) return { n: 0, contactRate: 0, avgTiming: 0, tendency: '-' };
  const contact = log.filter((l) => l.contact).length;
  const avg = Math.round(log.reduce((a, l) => a + l.timingMs, 0) / log.length);
  const tendency =
    Math.abs(avg) <= GOOD_TIMING_MS ? '좋음' : avg < 0 ? '전반적으로 빠름' : '전반적으로 늦음';
  return { n: log.length, contactRate: contact / log.length, avgTiming: avg, tendency };
}
