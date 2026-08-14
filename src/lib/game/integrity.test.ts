import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './rng';
import { generateTeam } from './generator';
import { normalizeTeam } from './migrate';
import { repairTeam } from './season';
import { drawPlayer, releasePlayer } from './shop';
import { upgradeTier } from './progression';
import {
  CPU_OWNER_UID,
  MAX_GOLD_GAIN_PER_SAVE,
  checkTeamSeal,
  clampGoldGain,
  economyFingerprint,
  hmacSha256,
  sealTeam,
  sha256,
} from './integrity';
import type { Player, Team } from './types';

/**
 * 무결성 서명.
 *
 * 재는 것은 둘이다.
 *
 *   1) **조작을 잡는가** — 골드·티어·레벨·아이템을 손대면 반드시 TAMPERED가 나와야 한다.
 *   2) **정상을 잡지 않는가** — 이쪽이 훨씬 위험하다. 오탐이 나면 손댄 적 없는 유저의
 *      골드가 0이 된다. 그래서 읽기 경로가 실제로 거는 정규화(normalizeTeam·repairTeam)와
 *      정상적인 게임 진행(뽑기·방출·강화)을 통과시킨 뒤에도 서명이 살아 있는지 잰다.
 */

function team(seed = 'seal', ownerUid = 'u1'): Team {
  return generateTeam(new Rng(seedFromString(seed)), { ownerUid });
}

/** 아무것도 본 적 없는 기기 */
const FRESH = { anchoredAt: null };
/** 이 팀의 서명본을 이미 저장한 적 있는 기기 */
const ANCHORED = { anchoredAt: 1 };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// 해시
//
// 직접 구현한 SHA-256/HMAC이라 표준 벡터로 못 박아 둔다. 여기가 틀리면 조작 감지가
// 조용히 "아무거나 통과"가 되거나 "전부 차단"이 된다.
// ---------------------------------------------------------------------------

describe('sha256', () => {
  it('빈 문자열', () => {
    expect(hex(sha256(bytes('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('abc', () => {
    expect(hex(sha256(bytes('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('블록 경계를 넘는 입력 (448비트 이상)', () => {
    const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(hex(sha256(bytes(msg)))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('여러 블록에 걸친 긴 입력', () => {
    expect(hex(sha256(bytes('a'.repeat(1000))))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });
});

describe('hmacSha256', () => {
  // RFC 4231 test case 1
  it('RFC 4231 케이스 1', () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(hex(hmacSha256(key, bytes('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  // RFC 4231 test case 2
  it('RFC 4231 케이스 2', () => {
    expect(hex(hmacSha256(bytes('Jefe'), bytes('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  // RFC 4231 test case 6 — 블록(64바이트)보다 긴 키는 먼저 해시된다
  it('RFC 4231 케이스 6 (긴 키)', () => {
    const key = new Uint8Array(131).fill(0xaa);
    const msg = 'Test Using Larger Than Block-Size Key - Hash Key First';
    expect(hex(hmacSha256(key, bytes(msg)))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });
});

// ---------------------------------------------------------------------------
// 조작 감지
// ---------------------------------------------------------------------------

describe('checkTeamSeal — 조작을 잡는다', () => {
  it('서명한 그대로면 통과한다', () => {
    expect(checkTeamSeal(sealTeam(team()), FRESH)).toBe('OK');
  });

  it('콘솔에서 골드만 바꾼 문서를 잡는다', () => {
    // 상점 화면에서 돌던 스니펫이 하는 일 그대로: 골드를 넣고 updatedAt을 찍는다.
    const sealed = sealTeam(team());
    const cheated = { ...sealed, gold: 300_000, updatedAt: Date.now() };
    expect(checkTeamSeal(cheated, FRESH)).toBe('TAMPERED');
  });

  it('골드를 원래대로 되돌려 놓으면 다시 통과한다', () => {
    // 서명이 지키는 것은 값이지 이력이 아니다. 되돌린 상태는 정상이므로 통과해야 한다 —
    // 안 그러면 조작 판정을 받은 문서를 고쳐 줄 방법이 없어진다.
    const sealed = sealTeam(team());
    const cheated = { ...sealed, gold: 300_000 };
    expect(checkTeamSeal({ ...cheated, gold: sealed.gold }, FRESH)).toBe('OK');
  });

  it('선수 티어·레벨을 올린 문서를 잡는다', () => {
    const sealed = sealTeam(team());
    const boosted: Team = {
      ...sealed,
      players: sealed.players.map((p, i) => (i === 3 ? { ...p, tier: 'S', level: 40 } : p)),
    };
    expect(checkTeamSeal(boosted, FRESH)).toBe('TAMPERED');
  });

  it('능력치를 올린 문서를 잡는다', () => {
    const sealed = sealTeam(team());
    const boosted: Team = {
      ...sealed,
      players: sealed.players.map((p, i) =>
        i === 0 ? { ...p, batting: { ...p.batting, power: 99 } } : p,
      ),
    };
    expect(checkTeamSeal(boosted, FRESH)).toBe('TAMPERED');
  });

  it('아이템을 넣은 문서를 잡는다', () => {
    const sealed = sealTeam(team());
    expect(checkTeamSeal({ ...sealed, inventory: { EXP_XL: 99 } }, FRESH)).toBe('TAMPERED');
  });

  it('선수를 통째로 끼워 넣은 문서를 잡는다', () => {
    const sealed = sealTeam(team());
    const extra = sealTeam(team('other')).players[0];
    expect(checkTeamSeal({ ...sealed, players: [...sealed.players, extra] }, FRESH)).toBe(
      'TAMPERED',
    );
  });

  it('남의 팀 서명을 베껴 붙여도 잡는다', () => {
    // 지문에 팀 id와 소유자가 들어 있어 서명은 그 팀에만 붙는다.
    const mine = sealTeam(team('mine'));
    const other = sealTeam(team('other'));
    expect(checkTeamSeal({ ...mine, seal: other.seal }, FRESH)).toBe('TAMPERED');
  });
});

describe('checkTeamSeal — 서명이 없는 문서', () => {
  it('처음 보는 기기에서는 통과시킨다 (서명 도입 이전 팀)', () => {
    expect(checkTeamSeal(team(), FRESH)).toBe('EXEMPT');
  });

  it('서명본을 본 적 있는 기기에서는 잡는다', () => {
    // 서명을 지우기만 하면 옛 문서인 척할 수 있는 우회를 앵커가 막는다.
    expect(checkTeamSeal(team(), ANCHORED)).toBe('TAMPERED');
  });

  it('CPU 팀은 검사하지 않는다', () => {
    // 리그에 끼워 넣는 팀이라 지갑이 없고, 리그 문서에서 복원될 때 서명을 달고 오지 않는다.
    expect(checkTeamSeal(team('cpu', CPU_OWNER_UID), ANCHORED)).toBe('EXEMPT');
  });

  it('팀 형태가 아닌 문서는 스키마 쪽에 넘긴다', () => {
    expect(checkTeamSeal(null, ANCHORED)).toBe('EXEMPT');
    expect(checkTeamSeal({ id: 'x' }, ANCHORED)).toBe('EXEMPT');
  });
});

// ---------------------------------------------------------------------------
// 오탐 — 여기가 깨지면 손대지 않은 유저의 골드가 사라진다
// ---------------------------------------------------------------------------

describe('economyFingerprint — 정상 문서를 잡지 않는다', () => {
  it('읽기 경로의 정규화를 지나도 지문이 같다', () => {
    // store.readTeamDoc이 실제로 거는 두 변환이다. 이 둘이 건드리는 값이 지문에 섞이면
    // 저장 → 새로고침 한 번에 멀쩡한 팀이 조작으로 잡힌다.
    const t = sealTeam(team());
    expect(economyFingerprint(repairTeam(normalizeTeam(t)))).toBe(economyFingerprint(t));
    expect(checkTeamSeal(repairTeam(normalizeTeam(t)), ANCHORED)).toBe('OK');
  });

  it('JSON을 왕복해도 지문이 같다', () => {
    // localStorage와 Firestore를 오가면 undefined 필드가 사라진다.
    const t = sealTeam(team());
    expect(checkTeamSeal(JSON.parse(JSON.stringify(t)), ANCHORED)).toBe('OK');
  });

  it('아이템 0개와 아이템 없음을 같게 본다', () => {
    // 마지막 하나를 쓰면 items.ts가 0을 남기는데, Firestore를 한 번 다녀오면 키가 사라진다.
    const t = team();
    const zero = economyFingerprint({ ...t, inventory: { EXP_S: 0 } });
    expect(zero).toBe(economyFingerprint({ ...t, inventory: {} }));
  });

  it('spentGold가 없는 옛 선수와 0인 선수를 같게 본다', () => {
    const t = team();
    const withField = t.players.map((p) => ({ ...p, spentGold: 0 }));
    const withoutField = t.players.map((p) => {
      const { spentGold: _drop, ...rest } = p;
      return rest as Player;
    });
    expect(economyFingerprint({ ...t, players: withField })).toBe(
      economyFingerprint({ ...t, players: withoutField }),
    );
  });

  it('경기 기록·부상·피로가 바뀌어도 지문이 같다', () => {
    // 경기마다 바뀌는 값은 지문 밖이어야 한다. 안 그러면 경기 한 번에 서명이 깨진다.
    const t = sealTeam(team());
    const played: Team = {
      ...t,
      seasonNo: 7,
      updatedAt: t.updatedAt + 10_000,
      players: t.players.map((p) => ({
        ...p,
        fatigue: 0.7,
        season: { ...p.season, g: 12, h: 20 },
        splits: { vsL: [10, 3] as [number, number] },
      })),
    };
    expect(checkTeamSeal(played, ANCHORED)).toBe('OK');
  });

  it('선수 순서만 바뀌어도 지문이 같다', () => {
    // Firestore가 배열 순서를 보존하긴 하지만, 여기에 기대면 언젠가 조용히 깨진다.
    const t = sealTeam(team());
    expect(checkTeamSeal({ ...t, players: [...t.players].reverse() }, ANCHORED)).toBe('OK');
  });

  it('정상적인 뽑기·방출·강화는 새 서명을 받는다', () => {
    // 게임 진행은 팀을 계속 바꾼다. 바뀐 팀에 다시 서명을 찍는 것이 정상 경로이고,
    // 그 결과가 통과해야 플레이가 막히지 않는다.
    const rich = { ...team(), gold: 200_000 };
    const drawn = drawPlayer(rich, 'PREMIUM', 'BATTER', 42);
    expect(drawn.ok).toBe(true);
    expect(checkTeamSeal(sealTeam(drawn.team), ANCHORED)).toBe('OK');

    const spare = drawn.team.players.find(
      (p) => p.kind === 'BATTER' && !drawn.team.lineup.includes(p.id),
    )!;
    const released = releasePlayer(drawn.team, spare.id);
    expect(released.ok).toBe(true);
    expect(checkTeamSeal(sealTeam(released.team), ANCHORED)).toBe('OK');

    // 티어 강화는 최대 레벨이어야 하므로 조건을 만들어 준다.
    const target = released.team.players[0];
    const ready: Team = {
      ...released.team,
      players: released.team.players.map((p) =>
        p.id === target.id ? { ...p, tier: 'C' as const, level: 10 } : p,
      ),
    };
    const up = upgradeTier(sealTeam(ready), target.id);
    expect(up.ok).toBe(true);
    expect(checkTeamSeal(sealTeam(up.team), ANCHORED)).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
// 증가 상한
// ---------------------------------------------------------------------------

describe('clampGoldGain', () => {
  it('정상 범위의 증가는 그대로 통과시킨다', () => {
    expect(clampGoldGain(1_000, 1_000 + MAX_GOLD_GAIN_PER_SAVE)).toBe(
      1_000 + MAX_GOLD_GAIN_PER_SAVE,
    );
  });

  it('한 번에 넘칠 수 없는 증가는 이전 값으로 되돌린다', () => {
    // 절반만 주는 식으로 깎지 않는다. 절반도 벌지 않은 골드다.
    expect(clampGoldGain(1_000, 300_000)).toBe(1_000);
  });

  it('감소는 얼마든 허용한다', () => {
    // 골드를 쓰는 것은 언제나 정상이다. 여기서 막으면 비싼 구매가 통째로 실패한다.
    expect(clampGoldGain(300_000, 0)).toBe(0);
  });

  it('음수와 NaN은 이전 값을 지킨다', () => {
    expect(clampGoldGain(500, -1)).toBe(500);
    expect(clampGoldGain(500, Number.NaN)).toBe(500);
  });
});
