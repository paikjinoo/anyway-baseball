/**
 * 도루 계측 하네스.
 *
 * **단정이 없다.** balance.test.ts가 회귀를 잡는 담장이라면, 이건 담장을 어디에 세울지
 * 정할 때 쓰는 자다. 도루 근처(주파 시간·딜리버리·팝타임·퀵모션 빈도·decideSteal 문턱값)를
 * 건드리면 여기부터 돌려서 무엇이 얼마나 움직였는지 보고 상수를 다시 유도한다.
 *
 * 4×180경기라 2분쯤 걸려서 평소 테스트에는 끼지 않는다. 돌리려면:
 *
 *   STEAL_PROBE=1 npx vitest run src/lib/game/steal-probe.test.ts --reporter=verbose
 *
 * (--reporter=verbose가 없으면 console.log가 안 보인다.)
 *
 * 재는 것:
 *   A. 자연 상태 — 8개 밸런스 지표 + 도루 지표 + 베이스별/속도별 분해
 *   B. 강제 도루 — 모든 기회에 뛰게 해서 얻는 순수 속도별 성공률 곡선
 *   C. 시간 분포 — 주파 시간과 수비 시간을 성분별로 분해 (상수 유도의 출발점)
 *   D. 포수 값어치 — arm/fielding만 갈아끼워 도루 허용 차이 측정
 *
 * balance.test.ts와 같은 시드(bal-N)를 써서 숫자가 직접 비교된다.
 */
import { describe, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { DEFAULT_SETTINGS } from './types';
import type { Player, Team } from './types';
import {
  bullpenCandidates,
  changePitcher,
  createGame,
  currentCatcher,
  offense,
  preparePitch,
  resolvePitch,
} from './engine';
import { decidePitch, decideSteal, decideSwing, shouldChangePitcher } from './ai';
import { effSpeed } from './batting';
import { stealDefenseTime, stealTime } from './baserunning';

const GAMES = 180;
/**
 * 시드 블록. 180경기 1회로는 득점이 ±0.27 흔들리므로, 결론을 낼 때는 SEED_BLOCK을 바꿔
 * 2~3개 블록을 돌려 평균으로 본다. 0이면 balance.test.ts와 완전히 같은 경기다.
 */
const SEED_BLOCK = Number(process.env.SEED_BLOCK ?? 0);
const seedOf = (i: number) => `bal-${SEED_BLOCK * GAMES + i}`;

function makeTeams(i: number): { away: Team; home: Team } {
  const rng = new Rng(seedFromString(seedOf(i)));
  return {
    away: generateTeam(rng, { ownerUid: 'a', id: `a${i}` }),
    home: generateTeam(rng, { ownerUid: 'b', id: `b${i}` }),
  };
}

interface StealObs {
  speed: number;
  safe: boolean;
  quickPitch: boolean;
  velocity: number;
  fromBase: number;
}

interface Probe {
  /** 1루 주자 + 2루 빔이면 무조건 뛰게 한다 (속도별 곡선 측정용) */
  force: boolean;
  onSteal(o: StealObs): void;
  /** 도루 기회(1루 주자 + 2루 빔)가 생긴 투구 수 */
  onChance(): void;
}

/** league.simulateGame의 루프를 그대로 옮기되 도루 명령에만 손을 댄다. */
function runGame(seed: string, away: Team, home: Team, probe: Probe) {
  let state = createGame(away, home, DEFAULT_SETTINGS, seed);
  const aiRng = new Rng(seedFromString(seed + ':ai'));

  let guard = 0;
  while (state.phase !== 'GAME_OVER' && guard < 1200) {
    guard++;
    if (state.phase === 'INNING_BREAK') state.phase = 'SETUP';

    const defSide = state.half === 'TOP' ? 'home' : 'away';
    if (shouldChangePitcher(state, 'NORMAL')) {
      const relief = bullpenCandidates(state, defSide)[0];
      if (relief) state = changePitcher(state, defSide, relief.id);
    }

    const pitchCmd = decidePitch(state, aiRng, 'NORMAL');
    const chance = !!state.bases[0] && !state.bases[1];
    if (chance) probe.onChance();

    const steal = probe.force
      ? chance
        ? [0]
        : []
      : decideSteal(state, aiRng, 'NORMAL');

    const traj = preparePitch(state, pitchCmd);
    const swing = decideSwing(state, traj, aiRng, 'NORMAL');

    const roster = offense(state).roster;
    const before = state.bases.map((r) => (r ? roster[r.playerId] : null));

    const res = resolvePitch(state, pitchCmd, { steal, swing });
    for (const r of res.stealResults) {
      const p = before[r.fromBase] as Player | null;
      if (!p) continue;
      probe.onSteal({
        speed: effSpeed(p),
        safe: r.safe,
        quickPitch: pitchCmd.quickPitch,
        velocity: traj.velocity,
        fromBase: r.fromBase,
      });
    }
    state = res.state;
  }
  return state;
}

/** 속도 10단위로 묶어 성공률을 표로 만든다 */
function speedTable(obs: StealObs[]): string {
  const buckets = new Map<number, StealObs[]>();
  for (const o of obs) {
    const b = Math.floor(o.speed / 10) * 10;
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(o);
  }
  let out = '  speed   n     성공률   주파시간\n';
  for (const b of [...buckets.keys()].sort((a, x) => a - x)) {
    const arr = buckets.get(b)!;
    const ok = arr.filter((o) => o.safe).length;
    // 주파 시간은 능력치만의 함수라 점프 노이즈 없이 버킷 중앙값으로 본다
    const rt = stealTime({ batting: { speed: b + 5 }, body: 'NORMAL' } as unknown as Player, 0);
    out += `  ${String(b).padStart(3)}대  ${String(arr.length).padStart(4)}  ${f((100 * ok) / arr.length, 1).padStart(6)}%  ${f(rt)}초\n`;
  }
  return out;
}

const pct = (arr: number[], q: number) => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '  -  ');

describe.skipIf(process.env.STEAL_PROBE !== '1')('도루 계측', () => {
  it('A. 자연 상태 — 전체 지표', () => {
    const t = { g: 0, r: 0, h: 0, hr: 0, d: 0, tr: 0, bb: 0, so: 0, ab: 0, sb: 0, cs: 0 };
    let chances = 0;
    const obs: StealObs[] = [];

    for (let i = 0; i < GAMES; i++) {
      const { away, home } = makeTeams(i);
      const state = runGame(seedOf(i), away, home, {
        force: false,
        onSteal: (o) => obs.push(o),
        onChance: () => chances++,
      });
      for (const side of ['away', 'home'] as const) {
        const team = state[side];
        t.g += 1;
        t.r += team.runs;
        for (const p of Object.values(team.roster)) {
          const s = p.season;
          t.h += s.h;
          t.hr += s.hr;
          t.d += s.double;
          t.tr += s.triple;
          t.bb += s.bb;
          t.so += s.so;
          t.ab += s.ab;
          t.sb += s.sb;
          t.cs += s.cs;
        }
      }
    }

    const per = (v: number) => v / t.g;
    const att = t.sb + t.cs;
    console.log(`
[A] 자연 상태 ${GAMES}경기 (팀·경기당)   실측 MLB
  득점   ${f(per(t.r))}    4.5
  안타   ${f(per(t.h))}    8.7
  홈런   ${f(per(t.hr))}    1.15
  2루타  ${f(per(t.d))}    1.65
  3루타  ${f(per(t.tr))}    0.14
  볼넷   ${f(per(t.bb))}    3.2
  삼진   ${f(per(t.so))}    8.5
  타율   ${f(t.h / t.ab, 3)}   .248
  ----
  도루   ${f(per(t.sb))}    0.5~0.6
  도실   ${f(per(t.cs))}    0.2
  시도   ${f(per(att))}    0.75
  성공률 ${f(att ? (100 * t.sb) / att : NaN, 1)}%   75%
  기회   ${f(chances / t.g)}회/팀·경기
  퀵모션 비율(도루 시도 시) ${f(obs.length ? (100 * obs.filter((o) => o.quickPitch).length) / obs.length : NaN, 1)}%
  ----  베이스별
${[0, 1, 2]
  .map((b) => {
    const a = obs.filter((o) => o.fromBase === b);
    const ok = a.filter((o) => o.safe).length;
    const spd = a.map((o) => o.speed);
    return `  ${b + 1}루->${b + 2 === 4 ? '홈' : `${b + 2}루`}  시도 ${f(a.length / t.g)}  성공률 ${f(a.length ? (100 * ok) / a.length : NaN, 1)}%  주자 speed 중앙 ${f(pct(spd, 0.5), 0)}`;
  })
  .join('\n')}
  ----  1루->2루 시도의 속도 분포
${speedTable(obs.filter((o) => o.fromBase === 0))}`);
  }, 300_000);

  it('B. 강제 도루 — 속도별 성공률 곡선', () => {
    const obs: StealObs[] = [];
    for (let i = 0; i < GAMES; i++) {
      const { away, home } = makeTeams(i);
      runGame(seedOf(i), away, home, {
        force: true,
        onSteal: (o) => obs.push(o),
        onChance: () => {},
      });
    }

    let out = `\n[B] 강제 도루 ${GAMES}경기 — 속도별 성공률 (n=${obs.length})\n`;
    out += speedTable(obs);
    const q = obs.filter((o) => o.quickPitch);
    const n = obs.filter((o) => !o.quickPitch);
    out += `  퀵모션 ${f((100 * q.length) / obs.length, 1)}% (성공률 ${f(q.length ? (100 * q.filter((o) => o.safe).length) / q.length : NaN, 1)}%) · 일반 성공률 ${f(n.length ? (100 * n.filter((o) => o.safe).length) / n.length : NaN, 1)}%`;
    console.log(out);
  }, 300_000);

  it('D. 포수 능력치의 값어치', () => {
    // 같은 시드 · 같은 로스터에서 포수의 arm/fielding만 갈아끼우고 도루 허용을 비교한다.
    const run = (stat: number | null) => {
      let sb = 0;
      let cs = 0;
      for (let i = 0; i < GAMES; i++) {
        const { away, home } = makeTeams(i);
        const patch = (t: Team): Team =>
          stat === null
            ? t
            : {
                ...t,
                players: t.players.map((p) =>
                  p.position === 'C' ? { ...p, batting: { ...p.batting, arm: stat, fielding: stat } } : p,
                ),
              };
        const state = runGame(seedOf(i), patch(away), patch(home), {
          force: false,
          onSteal: () => {},
          onChance: () => {},
        });
        for (const side of ['away', 'home'] as const) {
          for (const p of Object.values(state[side].roster)) {
            sb += p.season.sb;
            cs += p.season.cs;
          }
        }
      }
      return { sb: sb / (GAMES * 2), cs: cs / (GAMES * 2) };
    };

    const rows = [
      ['원본 (생성된 그대로)', run(null)],
      ['약한 포수 arm/field 20', run(20)],
      ['평범한 포수      50', run(50)],
      ['엘리트 포수      85', run(85)],
    ] as const;

    let out = `\n[D] 포수 능력치의 값어치 (팀·경기당 도루 허용)\n`;
    for (const [label, r] of rows) {
      const att = r.sb + r.cs;
      out += `  ${label.padEnd(24)} 도루 ${f(r.sb)} · 도실 ${f(r.cs)} · 성공률 ${f(att ? (100 * r.sb) / att : NaN, 1)}%\n`;
    }
    const weak = rows[1][1];
    const elite = rows[3][1];
    out += `  --> 약한 포수 -> 엘리트로 바꾸면 팀·경기당 도루 ${f(weak.sb - elite.sb)}개를 막는다 (144경기 ${f((weak.sb - elite.sb) * 144, 1)}개)`;
    console.log(out);
  }, 600_000);

  it('C. 시간 분포 — 주자 vs 수비', () => {
    // 실제 라인업에 서는 타자들의 speed 분포
    const speeds: number[] = [];
    const catchers: Player[] = [];
    for (let i = 0; i < GAMES; i++) {
      const { away, home } = makeTeams(i);
      const state = createGame(away, home, DEFAULT_SETTINGS, seedOf(i));
      const c = currentCatcher(state);
      if (c) catchers.push(c);
      for (const team of [away, home]) {
        for (const id of team.lineup) {
          const p = team.players.find((x) => x.id === id);
          if (p) speeds.push(effSpeed(p));
        }
      }
    }

    const rt = speeds.map((s) =>
      stealTime({ batting: { speed: s }, body: 'NORMAL' } as unknown as Player, 0),
    );
    const rng = new Rng(seedFromString('probe-def'));
    const dNormal = catchers.map((c) => stealDefenseTime(rng, c, false, 145));
    const dQuick = catchers.map((c) => stealDefenseTime(rng, c, true, 145));

    console.log(`
[C] 시간 분포 (n=${speeds.length} 타자, ${catchers.length} 포수)
  speed      p10 ${f(pct(speeds, 0.1), 0)} · 중앙 ${f(pct(speeds, 0.5), 0)} · p90 ${f(pct(speeds, 0.9), 0)} · 최대 ${f(pct(speeds, 0.999), 0)}
  주파시간   p10 ${f(pct(rt, 0.1))} · 중앙 ${f(pct(rt, 0.5))} · p90 ${f(pct(rt, 0.9))}초   (엘리트/평균/느림 목표 3.1 / 3.6 / 4.1)
             빠른쪽 p10=${f(pct(rt, 0.1))} 느린쪽 p90=${f(pct(rt, 0.9))}
  수비 일반  ${f(mean(dNormal.map((d) => d.total)))}초  = 딜리버리 ${f(mean(dNormal.map((d) => d.delivery)))} + 비행 ${f(mean(dNormal.map((d) => d.flight)))} + 팝타임 ${f(mean(dNormal.map((d) => d.popTime)))}   (목표 3.30)
  수비 퀵    ${f(mean(dQuick.map((d) => d.total)))}초  = 딜리버리 ${f(mean(dQuick.map((d) => d.delivery)))} + 비행 ${f(mean(dQuick.map((d) => d.flight)))} + 팝타임 ${f(mean(dQuick.map((d) => d.popTime)))}   (목표 3.05)
  팝타임 폭  ${f(pct(dNormal.map((d) => d.popTime), 0.05))} ~ ${f(pct(dNormal.map((d) => d.popTime), 0.95))}초`);
  }, 300_000);
});
