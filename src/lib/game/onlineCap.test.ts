import { beforeEach, describe, expect, it } from 'vitest';
import { ONLINE_DAILY_EXP_CAP, ONLINE_DAILY_GOLD_CAP } from './onlineCap';

// ---------------------------------------------------------------------------
// 온라인 하루 한도. localStorage를 쓰는 원장이라 node 환경에 최소한의 스텁을 깔고 검증한다.
// ---------------------------------------------------------------------------

describe('온라인 보상 하루 한도', () => {
  let claimOnlineReward: typeof import('../firebase/store').claimOnlineReward;
  let onlineRewardUsedToday: typeof import('../firebase/store').onlineRewardUsedToday;
  let onlineRewardRemaining: typeof import('../firebase/store').onlineRewardRemaining;

  const WIN = { gold: 400, exp: 600 };

  beforeEach(async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = g;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const mod = await import('../firebase/store');
    claimOnlineReward = mod.claimOnlineReward;
    onlineRewardUsedToday = mod.onlineRewardUsedToday;
    onlineRewardRemaining = mod.onlineRewardRemaining;
  });

  it('한도까지는 요청한 만큼 그대로 준다', () => {
    const first = claimOnlineReward('u1', WIN);
    expect(first.granted).toEqual(WIN);
    expect(first.usedToday).toEqual(WIN);
  });

  it('한 경기 보상만으로는 하루 한도를 채울 수 없다', () => {
    expect(WIN.gold).toBeLessThan(ONLINE_DAILY_GOLD_CAP);
    expect(WIN.exp).toBeLessThan(ONLINE_DAILY_EXP_CAP);
  });

  it('누적이 한도를 넘으면 남은 만큼만 주고 그 뒤로는 0이다', () => {
    let gold = 0;
    let exp = 0;
    for (let i = 0; i < 30; i++) {
      const c = claimOnlineReward('u1', WIN);
      gold += c.granted.gold;
      exp += c.granted.exp;
    }
    // 몇 판을 이기든 하루 총량은 한도를 넘지 않는다 — 담합 방지의 핵심
    expect(gold).toBe(ONLINE_DAILY_GOLD_CAP);
    expect(exp).toBe(ONLINE_DAILY_EXP_CAP);
    expect(claimOnlineReward('u1', WIN).granted).toEqual({ gold: 0, exp: 0 });
    expect(onlineRewardRemaining('u1')).toEqual({ gold: 0, exp: 0 });
  });

  it('골드와 경험치 한도를 따로 센다', () => {
    // 골드만 소진시키면 경험치는 그대로 남아 있어야 한다
    claimOnlineReward('u1', { gold: ONLINE_DAILY_GOLD_CAP, exp: 0 });
    const after = claimOnlineReward('u1', WIN);
    expect(after.granted.gold).toBe(0);
    expect(after.granted.exp).toBe(WIN.exp);
  });

  it('한도를 딱 채우는 경계에서 넘지 않는다', () => {
    claimOnlineReward('u1', { gold: ONLINE_DAILY_GOLD_CAP - 10, exp: 0 });
    const last = claimOnlineReward('u1', WIN);
    expect(last.granted.gold).toBe(10);
    expect(last.usedToday.gold).toBe(ONLINE_DAILY_GOLD_CAP);
  });

  it('계정마다 따로 센다', () => {
    claimOnlineReward('u1', { gold: ONLINE_DAILY_GOLD_CAP, exp: ONLINE_DAILY_EXP_CAP });
    expect(onlineRewardUsedToday('u2')).toEqual({ gold: 0, exp: 0 });
    expect(claimOnlineReward('u2', WIN).granted).toEqual(WIN);
  });

  it('음수를 요청해도 누계가 줄지 않는다', () => {
    claimOnlineReward('u1', WIN);
    expect(claimOnlineReward('u1', { gold: -100, exp: -100 }).granted).toEqual({ gold: 0, exp: 0 });
    expect(onlineRewardUsedToday('u1')).toEqual(WIN);
  });
});
