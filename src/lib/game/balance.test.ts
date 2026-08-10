import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { simulateGame } from './league';
import { DEFAULT_SETTINGS } from './types';

/**
 * 밸런스 회귀 테스트.
 *
 * 엔진은 시드 기반 결정론이라 헤드리스로 대량 시뮬레이션할 수 있다. 180경기(=360 팀·경기)를
 * 돌려 팀·경기당 지표가 MLB 실측 근처에 머무는지 본다. 능력치·물리·성장 곡선을 건드리면
 * 여기서 먼저 티가 난다.
 *
 * 범위는 "정확히 이 값"이 아니라 "이 밖으로 나가면 뭔가 깨진 것"에 맞춰 넉넉히 잡았다.
 */
describe('밸런스 (180경기 시뮬레이션)', () => {
  it('팀·경기당 지표가 MLB 실측 근처에 머문다', () => {
    const total = { g: 0, r: 0, h: 0, hr: 0, d: 0, t: 0, bb: 0, so: 0, ab: 0 };

    for (let i = 0; i < 180; i++) {
      const rng = new Rng(seedFromString(`bal-${i}`));
      const away = generateTeam(rng, { ownerUid: 'a', id: `a${i}` });
      const home = generateTeam(rng, { ownerUid: 'b', id: `b${i}` });
      const res = simulateGame(away, home, DEFAULT_SETTINGS, `bal-${i}`);

      for (const side of ['away', 'home'] as const) {
        const team = res.state[side];
        total.g += 1;
        total.r += team.runs;
        for (const p of Object.values(team.roster)) {
          const s = p.season;
          total.h += s.h;
          total.hr += s.hr;
          total.d += s.double;
          total.t += s.triple;
          total.bb += s.bb;
          total.so += s.so;
          total.ab += s.ab;
        }
      }
    }

    const per = (v: number) => v / total.g;
    const avg = total.h / total.ab;

    // 실측 기준값 (MLB): 득점 4.5 · 안타 8.7 · 홈런 1.15 · 2루타 1.65 · 3루타 0.14
    //                     볼넷 3.2 · 삼진 8.5 · 타율 .248
    expect(per(total.r)).toBeGreaterThan(3.6);
    expect(per(total.r)).toBeLessThan(5.4);
    expect(per(total.h)).toBeGreaterThan(7.6);
    expect(per(total.h)).toBeLessThan(9.6);
    expect(per(total.hr)).toBeGreaterThan(0.8);
    expect(per(total.hr)).toBeLessThan(1.6);
    expect(per(total.d)).toBeGreaterThan(1.2);
    expect(per(total.d)).toBeLessThan(2.1);
    // 3루타가 흔해지면 주루/수비 도달 시간 모델이 깨진 것이다
    expect(per(total.t)).toBeLessThan(0.35);
    expect(per(total.bb)).toBeGreaterThan(2.0);
    expect(per(total.bb)).toBeLessThan(4.4);
    expect(per(total.so)).toBeGreaterThan(7.4);
    expect(per(total.so)).toBeLessThan(9.6);
    expect(avg).toBeGreaterThan(0.225);
    expect(avg).toBeLessThan(0.275);
  }, 120_000);

  it('선발이 완투하지 않고 불펜이 등판한다', () => {
    const rng = new Rng(seedFromString('relief'));
    const away = generateTeam(rng, { ownerUid: 'a', id: 'ra' });
    const home = generateTeam(rng, { ownerUid: 'b', id: 'rb' });
    const res = simulateGame(away, home, DEFAULT_SETTINGS, 'relief');
    // 지친 투수를 내리지 않으면 선발이 140구를 던지며 볼넷·득점이 부풀려진다
    expect(res.state.home.usedPitcherIds.length).toBeGreaterThan(1);
    expect(res.state.away.usedPitcherIds.length).toBeGreaterThan(1);
  });
});
