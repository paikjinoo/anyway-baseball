import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { simulateGame } from './league';
import { createGame, preparePitch, resolvePitch } from './engine';
import { decidePitch, decideSteal, decideSwing } from './ai';
import { DEFAULT_SETTINGS } from './types';
import { batterTotals, buildGameRecord, era, inningsText } from './record';
import type { GameState, OffenseCommand, PitchCommand, PitchResult, Team } from './types';

function twoTeams(): [Team, Team] {
  return [
    generateTeam(new Rng(seedFromString('rec-away')), { ownerUid: 'u1', name: '어웨이' }),
    generateTeam(new Rng(seedFromString('rec-home')), { ownerUid: 'u2', name: '홈' }),
  ];
}

/** 실제로 끝까지 돌린 경기 하나. 박스스코어의 재료가 엔진이 채운 값 그대로인지 보려면 필요하다. */
function playedGame(seed = 'rec-game'): GameState {
  const [away, home] = twoTeams();
  return simulateGame(away, home, DEFAULT_SETTINGS, seed).state;
}

describe('buildGameRecord', () => {
  it('이닝별 득점의 합이 팀 최종 득점과 같다', () => {
    const rec = buildGameRecord(playedGame(), { kind: 'CPU', playedAt: 1000 });

    for (const box of [rec.away, rec.home]) {
      const sum = box.lineScore.reduce((a, b) => a + b, 0);
      expect(sum).toBe(box.runs);
    }
  });

  it('타자 개인 기록의 합이 팀 안타·득점과 맞는다', () => {
    const rec = buildGameRecord(playedGame(), { kind: 'CPU', playedAt: 1000 });

    for (const box of [rec.away, rec.home]) {
      const totals = batterTotals(box);
      expect(totals.h).toBe(box.hits);
      // 투수가 타석에 서는 규칙(DH 미사용)에서도 득점은 라인업 전원의 합이어야 하므로
      // 타자만 더한 값과 팀 득점이 어긋나면 어느 한쪽이 빠진 것이다.
      expect(totals.r).toBe(box.runs);
    }
  });

  it('치르지 않은 연장 칸은 잘라 낸다', () => {
    // 엔진이 회차를 넘길 때 이닝 칸을 먼저 늘려서, 9회에 끝난 경기에도 빈 10회가 남는다.
    const state = playedGame();
    expect(state.winner).not.toBe('TIE');

    const rec = buildGameRecord(state, { kind: 'CPU', playedAt: 1000 });
    const n = Math.max(rec.away.lineScore.length, rec.home.lineScore.length);
    expect(n).toBeGreaterThanOrEqual(state.settings.regulationInnings);
    // 마지막 칸이 양 팀 모두 0인 채로 남아 있으면 안 된다 (정규 이닝 이후에 한해)
    if (n > state.settings.regulationInnings) {
      const last = (rec.away.lineScore[n - 1] ?? 0) + (rec.home.lineScore[n - 1] ?? 0);
      expect(last).toBeGreaterThan(0);
    }
    // 잘라 내도 합계는 그대로다
    expect(rec.away.lineScore.reduce((a, b) => a + b, 0)).toBe(rec.away.runs);
    expect(rec.home.lineScore.reduce((a, b) => a + b, 0)).toBe(rec.home.runs);
  });

  it('출전한 선수만 담는다', () => {
    const state = playedGame();
    const rec = buildGameRecord(state, { kind: 'CPU', playedAt: 1000 });

    const rosterSize = Object.keys(state.away.roster).length;
    expect(rec.away.lines.length).toBeGreaterThan(0);
    // 벤치가 통째로 들어오면 필터가 죽은 것이다
    expect(rec.away.lines.length).toBeLessThan(rosterSize);
    for (const l of rec.away.lines) expect(l.stat.g).toBe(1);
  });

  it('타자는 타순대로, 투수는 그 뒤에 온다', () => {
    const rec = buildGameRecord(playedGame(), { kind: 'CPU', playedAt: 1000 });
    const kinds = rec.home.lines.map((l) => l.kind);
    const firstPitcher = kinds.indexOf('PITCHER');

    expect(firstPitcher).toBeGreaterThan(0);
    // 투수가 한 번 나온 뒤로는 타자가 다시 나오지 않는다
    expect(kinds.slice(firstPitcher).every((k) => k === 'PITCHER')).toBe(true);

    const orders = rec.home.lines.map((l) => l.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('같은 경기를 다시 치러도 기록 id가 겹치지 않는다', () => {
    const state = playedGame();
    const a = buildGameRecord(state, { kind: 'LEAGUE', playedAt: 1000 });
    const b = buildGameRecord(state, { kind: 'LEAGUE', playedAt: 2000 });
    expect(a.id).not.toBe(b.id);
  });

  it('클립이 없으면 필드를 만들지 않는다 (저장 용량)', () => {
    const rec = buildGameRecord(playedGame(), { kind: 'CPU', playedAt: 1000, clips: [] });
    expect(rec.clips).toBeUndefined();
  });
});

/**
 * 다시 보기가 성립하는 근거를 고정한다.
 *
 * 클립은 "투구 직전 상태 + 커맨드"만 들고 있고, 재생은 resolvePitch를 다시 부르는 것이다.
 * 그래서 같은 입력이 같은 결과를 낸다는 것과, 커맨드를 result에서 되살릴 수 있다는 것이
 * 둘 다 참이어야 다시 보기가 실제 경기와 같은 장면을 보여 준다.
 */
describe('클립 재현', () => {
  /** 경기를 돌리며 투구마다 (직전 상태, 커맨드, 결과)를 모은다. simulateGame과 같은 흐름. */
  function tapeGame(seed = 'clip-tape') {
    const [away, home] = twoTeams();
    let state = createGame(away, home, DEFAULT_SETTINGS, seed);
    const aiRng = new Rng(seedFromString(seed + ':ai'));
    const tape: { prev: GameState; pitch: PitchCommand; offense: OffenseCommand; result: PitchResult }[] = [];

    let guard = 0;
    while (state.phase !== 'GAME_OVER' && guard < 1200) {
      guard++;
      if (state.phase === 'INNING_BREAK') state.phase = 'SETUP';
      const pitch = decidePitch(state, aiRng, 'NORMAL');
      const steal = decideSteal(state, aiRng, 'NORMAL');
      const traj = preparePitch(state, pitch);
      const swing = decideSwing(state, traj, aiRng, 'NORMAL');
      const prev = structuredClone(state);
      const result = resolvePitch(state, pitch, { steal, swing });
      tape.push({ prev, pitch, offense: { steal, swing }, result });
      state = result.state;
    }
    return tape;
  }

  it('같은 상태와 커맨드는 언제나 같은 결과를 낸다', () => {
    const tape = tapeGame();
    expect(tape.length).toBeGreaterThan(100);

    for (const t of tape) {
      const again = resolvePitch(structuredClone(t.prev), t.pitch, t.offense);
      expect(again.kind).toBe(t.result.kind);
      expect(again.runsScored).toBe(t.result.runsScored);
      expect(again.description).toBe(t.result.description);
      expect(again.state.rngState).toBe(t.result.state.rngState);
    }
  });

  it('도루 명령을 결과에서 되살려도 판정이 같다', () => {
    // 클립은 steal 배열을 result.stealResults에서 복원한다. 주자가 없던 베이스에 내린
    // 지시는 결과에 남지 않으므로, 그 차이가 판정을 바꾸지 않아야 복원이 안전하다.
    //
    // CPU에게 맡기지 않고 직접 지시한다 — decideSteal은 창단 로스터 수준의 발로는
    // 사실상 발동하지 않아서(문턱값이 능력치 61), 표본이 0이 된다.
    const [away, home] = twoTeams();
    let state = createGame(away, home, DEFAULT_SETTINGS, 'clip-steal');
    const aiRng = new Rng(seedFromString('clip-steal:ai'));
    let checked = 0;
    let guard = 0;

    while (state.phase !== 'GAME_OVER' && guard < 1200) {
      guard++;
      if (state.phase === 'INNING_BREAK') state.phase = 'SETUP';
      const pitch = decidePitch(state, aiRng, 'NORMAL');
      const traj = preparePitch(state, pitch);
      const swing = decideSwing(state, traj, aiRng, 'NORMAL');
      // 1루에 주자가 있고 2루가 비었으면 무조건 뛴다
      const steal = state.bases[0] && !state.bases[1] ? [0] : [];
      const prev = structuredClone(state);
      const result = resolvePitch(state, pitch, { steal, swing });

      if (result.stealResults.length > 0) {
        const restored: OffenseCommand = {
          steal: result.stealResults.map((s) => s.fromBase),
          swing: result.swing,
        };
        const again = resolvePitch(structuredClone(prev), pitch, restored);
        expect(again.kind).toBe(result.kind);
        expect(again.runsScored).toBe(result.runsScored);
        expect(again.stealResults).toEqual(result.stealResults);
        checked++;
      }
      state = result.state;
    }

    expect(checked).toBeGreaterThan(5);
  });

  it('홈런은 클립 후보로 잡힌다', () => {
    const tape = tapeGame('clip-hr');
    expect(tape.some((t) => t.result.kind === 'HOME_RUN')).toBe(true);
  });
});

describe('표시 헬퍼', () => {
  it('이닝은 아웃 카운트를 야구식으로 적는다', () => {
    expect(inningsText(0)).toBe('0.0');
    expect(inningsText(20)).toBe('6.2');
    expect(inningsText(27)).toBe('9.0');
  });

  it('방어율은 9이닝 환산이고, 던지지 않았으면 null이다', () => {
    expect(era({ ip3: 0, er: 0 } as never)).toBeNull();
    // 9이닝(27아웃) 3자책 = 3.00
    expect(era({ ip3: 27, er: 3 } as never)).toBeCloseTo(3, 5);
    // 3이닝(9아웃) 3자책 = 9.00
    expect(era({ ip3: 9, er: 3 } as never)).toBeCloseTo(9, 5);
  });
});
