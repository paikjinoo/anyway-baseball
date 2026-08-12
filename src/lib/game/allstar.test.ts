import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { emptySeason, generateTeam } from './generator';
import { createGame } from './engine';
import { applyMatchResult, type MatchRewardContext } from './matchReward';
import {
  buildAllStarTeam,
  myAllStarShare,
  originalPlayerId,
  prefixOf,
  suggestPicks,
  type AllStarEntry,
} from './allstar';
import { DEFAULT_SETTINGS } from './types';
import type { Team, TeamInGame } from './types';

function team(seed: string, ownerUid: string): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid });
}

function entry(uid: string, slot: 0 | 1, t: Team): AllStarEntry {
  return { uid, slot, team: t, picks: suggestPicks(t, slot) };
}

/** 두 사람이 픽을 낸 원정 올스타 팀과 그 경기 상태 */
function setup() {
  const mine = team('as-mine', 'me');
  const partner = team('as-partner', 'partner');
  const built = buildAllStarTeam([entry('me', 0, mine), entry('partner', 1, partner)], 'away', 7);
  const state = createGame(built.team, team('as-foe', 'foe'), DEFAULT_SETTINGS, 'as-game');
  return { mine, partner, built, inGame: state.away };
}

describe('올스타 선수 id 접두사', () => {
  it('붙였다 떼면 원래 id로 돌아온다', () => {
    for (const side of ['away', 'home'] as const) {
      for (const slot of [0, 1] as const) {
        expect(originalPlayerId(prefixOf(side, slot) + 'p_abc123')).toBe('p_abc123');
      }
    }
  });

  it('접두사가 없는 id는 그대로 둔다', () => {
    expect(originalPlayerId('p_abc123')).toBe('p_abc123');
  });

  it('합쳐진 팀의 모든 선수 id가 원래 팀의 id로 되돌아간다', () => {
    const { mine, partner, built } = setup();
    const known = new Set([...mine.players, ...partner.players].map((p) => p.id));
    for (const p of built.team.players) {
      expect(p.id).not.toBe(originalPlayerId(p.id)); // 접두사가 실제로 붙어 있다
      expect(known.has(originalPlayerId(p.id))).toBe(true);
    }
  });
});

describe('내 몫 분리', () => {
  it('내가 낸 선수만 남고 원래 id로 조회된다', () => {
    const { mine, built, inGame } = setup();
    const share = myAllStarShare(inGame, built.owners, 'me');

    const myPicks = Object.keys(built.owners).filter((id) => built.owners[id] === 'me');
    expect(myPicks.length).toBeGreaterThan(0);
    expect(Object.keys(share.roster)).toHaveLength(myPicks.length);

    // 내 진짜 팀의 id로 바로 찾아진다
    for (const id of myPicks) {
      expect(share.roster[originalPlayerId(id)]).toBeDefined();
      expect(mine.players.some((p) => p.id === originalPlayerId(id))).toBe(true);
    }
  });

  it('동료가 낸 선수는 들어오지 않는다', () => {
    const { partner, built, inGame } = setup();
    const share = myAllStarShare(inGame, built.owners, 'me');
    for (const p of partner.players) {
      expect(share.roster[p.id]).toBeUndefined();
    }
  });
});

describe('2대2 경험치 지급', () => {
  /** 로스터의 첫 타자에게 안타 기록을 심고, 그 선수의 접두사 없는 id를 돌려준다 */
  function giveHits(inGame: TeamInGame, owners: Record<string, string>, uid: string): string {
    const id = Object.keys(inGame.roster).find(
      (k) => owners[k] === uid && inGame.roster[k].kind === 'BATTER',
    )!;
    inGame.roster[id].season = { ...emptySeason(), g: 1, pa: 4, ab: 4, h: 3, hr: 1, rbi: 3 };
    return originalPlayerId(id);
  }

  const ctx: MatchRewardContext = {
    kind: 'ONLINE',
    outcome: 'WIN',
    runsScored: 6,
    runsAllowed: 2,
    seed: 99,
    recordSeason: false,
  };

  it('내가 낸 선수가 경험치를 받는다', () => {
    const { mine, built, inGame } = setup();
    const heroId = giveHits(inGame, built.owners, 'me');

    const share = myAllStarShare(inGame, built.owners, 'me');
    const result = applyMatchResult(mine, share, ctx);

    const hero = result.lines.find((l) => l.playerId === heroId);
    expect(hero).toBeDefined();
    expect(hero!.exp).toBeGreaterThan(0);
    expect(mine.players.some((p) => p.id === heroId)).toBe(true);
  });

  it('동료가 낸 선수의 활약은 내 팀 경험치가 되지 않는다', () => {
    const { mine, built, inGame } = setup();
    giveHits(inGame, built.owners, 'partner');

    const share = myAllStarShare(inGame, built.owners, 'me');
    const result = applyMatchResult(mine, share, ctx);

    // 내 선수는 아무도 기록이 없으므로 경험치 명세가 비어 있다
    expect(result.lines.reduce((a, l) => a + l.exp, 0)).toBe(0);
  });

  it('변환 없이 넘기면 전원 0이 된다 (수정 전 동작)', () => {
    const { mine, built, inGame } = setup();
    const heroId = giveHits(inGame, built.owners, 'me');

    // 접두사 붙은 id로는 내 팀 선수를 하나도 찾지 못한다
    const broken = applyMatchResult(mine, inGame, ctx);
    expect(broken.lines.reduce((a, l) => a + l.exp, 0)).toBe(0);

    // 같은 기록이라도 변환을 거치면 지급된다
    const fixed = applyMatchResult(mine, myAllStarShare(inGame, built.owners, 'me'), ctx);
    expect(fixed.lines.find((l) => l.playerId === heroId)!.exp).toBeGreaterThan(0);
  });
});
