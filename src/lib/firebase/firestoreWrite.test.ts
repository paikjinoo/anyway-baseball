import { describe, expect, it } from 'vitest';
import { initializeApp } from 'firebase/app';
import { doc, getFirestore, initializeFirestore, setDoc, type Firestore } from 'firebase/firestore';
import { generateTeam } from '../game/generator';
import { Rng, seedFromString } from '../game/rng';
import { mergeSplits, mergeZoneSplits } from '../game/matchReward';
import type { Team } from '../game/types';

/**
 * "창단은 됐는데 Firestore에 팀이 없다"를 잡아 두는 테스트.
 *
 * 원인은 네트워크도 보안 규칙도 아니었다. setDoc은 값이 `undefined`인 필드를 만나면
 * 문서를 통째로 거부하는데, 그 거부가 **동기 예외**라 최선노력 동기화의 catch에 그대로
 * 삼켜졌다. 로컬 저장은 JSON.stringify가 그 필드를 떨어뜨려 멀쩡히 성공했으므로
 * 화면에는 아무 증상이 없었고, 새로고침 뒤에 저장한 사람만 원격 문서를 갖게 됐다.
 *
 * 실제 Firebase SDK를 쓴다. setDoc은 직렬화 단계에서 던지므로 네트워크가 필요 없다 —
 * 여기서 검증하는 것이 정확히 그 직렬화 단계다.
 */

let seq = 0;
function db(opts?: { ignoreUndefinedProperties: boolean }): Firestore {
  const app = initializeApp({ apiKey: 'k', projectId: 'p', appId: 'a' }, `probe-${seq++}`);
  return opts ? initializeFirestore(app, opts) : getFirestore(app);
}

/** setDoc이 동기적으로 던진 예외. 통과하면 null. */
function writeError(target: Firestore, data: unknown): Error | null {
  try {
    void setDoc(doc(target, 'teams', 't_probe'), data as Record<string, unknown>);
    return null;
  } catch (e) {
    return e as Error;
  }
}

function founding(): Team {
  return generateTeam(new Rng(seedFromString('fs-write')), { ownerUid: 'u1', plan: 'FOUNDING' });
}

/** 경기 보상이 지나간 팀. 타석에 못 선 선수의 스플릿이 undefined로 **존재하게** 된다. */
function afterMatch(team: Team): Team {
  return {
    ...team,
    players: team.players.map((p) => ({
      ...p,
      splits: mergeSplits(p.splits, undefined),
      zoneSplits: mergeZoneSplits(p.zoneSplits, undefined),
    })),
  };
}

describe('Firestore 쓰기', () => {
  it('창단 직후 팀에는 undefined 필드가 실제로 들어 있다', () => {
    const team = founding();
    const batters = team.players.filter((p) => p.kind === 'BATTER');
    expect(batters.length).toBeGreaterThan(0);
    // 야수의 role은 "없는 속성"이 아니라 "undefined인 속성"이다. 이게 이 버그의 씨앗이다.
    expect(batters.every((p) => 'role' in p && p.role === undefined)).toBe(true);
  });

  it('기본 설정에서는 그 팀이 거부된다 — 그것도 동기 예외로', () => {
    const err = writeError(db(), founding());
    expect(err?.message).toContain('Unsupported field value: undefined');
  });

  it('ignoreUndefinedProperties면 창단 팀도 경기 후 팀도 통과한다', () => {
    const target = db({ ignoreUndefinedProperties: true });
    const team = founding();
    expect(writeError(target, { ...team, updatedAt: 1 })).toBeNull();
    expect(writeError(target, { ...afterMatch(team), updatedAt: 2 })).toBeNull();
  });

  it('새로고침을 거친(JSON 왕복) 팀은 원래 통과했다 — 일부 계정만 저장된 이유다', () => {
    const roundTripped = JSON.parse(JSON.stringify(founding()));
    expect(writeError(db(), roundTripped)).toBeNull();
  });
});
