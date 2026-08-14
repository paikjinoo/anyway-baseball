import { POSITION_KO } from './constants';
import { ROTATION_SIZE, autoLineup, autoRotation } from './generator';
import type { BatterPosition, PitcherRole, Player, Team } from './types';

/**
 * 로스터 편성 규칙.
 *
 * 선수는 생성 시점에 투수/타자로 갈리고 그 구분은 바뀌지 않는다. 플레이어가 바꿀 수 있는 것은
 *   - 투수: 마운드 역할 (선발 / 중간계투 / 마무리)
 *   - 타자: 야수 포지션 9개
 * 뿐이다. 선발은 항상 정확히 4명이고, 마무리는 최대 1명이다.
 */

/**
 * 마무리로 지정할 수 있는 인원.
 *
 * 마무리는 교체 후보 목록의 맨 뒤로 밀리는 역할 표시일 뿐이고(engine.RELIEF_ORDER),
 * 같은 역할끼리는 남은 투구 여력 순으로 갈린다. 그래서 둘을 두면 스태미나가 넉넉한 쪽이
 * 알아서 먼저 올라온다 — 경기마다 다른 마무리를 쓰고 싶다는 요구가 이걸로 해결된다.
 */
export const MAX_CLOSERS = 2;
export const LINEUP_SIZE = 9;

export const ROLE_KO: Record<PitcherRole, string> = {
  SP: '선발',
  RP: '중간계투',
  CP: '마무리',
};

export const ROLE_DESC: Record<PitcherRole, string> = {
  SP: '로테이션을 돌며 경기를 시작합니다. 스태미나가 길수록 오래 끌고 갑니다.',
  RP: '경기 중간에 올라옵니다. 교체 후보 목록에서 가장 먼저 뜹니다.',
  CP: '리드를 지킬 마지막 이닝을 위해 남겨 둡니다. 교체 후보 목록의 맨 뒤에 놓입니다.',
};

export function pitchersOf(team: Team): Player[] {
  return team.players.filter((p) => p.kind === 'PITCHER');
}

export function battersOf(team: Team): Player[] {
  return team.players.filter((p) => p.kind === 'BATTER');
}

export function starters(team: Team): Player[] {
  return pitchersOf(team).filter((p) => p.role === 'SP');
}

export function closers(team: Team): Player[] {
  return pitchersOf(team).filter((p) => p.role === 'CP');
}

/** 라인업에 들어 있지 않은 타자 (경기 중 대타/대주자/대수비 후보) */
export function benchBatters(team: Team): Player[] {
  const inLineup = new Set(team.lineup);
  // 부상자도 후보에 남긴다. 능력치가 깎일 뿐 못 나가는 건 아니다(batting.withInjuryPenalty).
  return battersOf(team).filter((p) => !inLineup.has(p.id));
}

/**
 * 온전한 상태인가.
 *
 * 부상은 더 이상 출전을 막지 않는다 — 능력치가 남은 경기 수에 비례해 깎일 뿐이다.
 * 그래서 이 함수는 "못 나간다"가 아니라 "자동 편성에서 뒤로 미룬다"의 기준으로만 쓴다.
 */
export function isAvailable(p: Player): boolean {
  return !p.injury;
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

/**
 * 경기를 시작하기 전에 확인해야 할 문제 목록. 비어 있으면 출전 가능.
 * 화면에는 이 문자열을 그대로 보여 준다.
 */
export function rosterIssues(team: Team): string[] {
  const issues: string[] = [];

  const sp = starters(team);
  if (sp.length !== ROTATION_SIZE) {
    issues.push(`선발 투수는 정확히 ${ROTATION_SIZE}명이어야 합니다 (현재 ${sp.length}명).`);
  }
  if (closers(team).length > MAX_CLOSERS) {
    issues.push(`마무리는 최대 ${MAX_CLOSERS}명입니다.`);
  }

  // 부상은 경기를 막지 않는다. 막아 버리면 회복이 경기 종료로만 진행되므로
  // (matchReward의 gamesLeft 감소) 부상 하나로 아무것도 못 하는 상태에 갇힌다.

  const lineup = team.lineup;
  if (lineup.length !== LINEUP_SIZE || new Set(lineup).size !== LINEUP_SIZE) {
    issues.push(`타순은 서로 다른 ${LINEUP_SIZE}명이어야 합니다.`);
  } else {
    const byId = new Map(team.players.map((p) => [p.id, p]));
    const pitchers = lineup.map((id) => byId.get(id)).filter((p) => p?.kind === 'PITCHER');
    if (pitchers.length) {
      issues.push(`투수는 타순에 넣을 수 없습니다: ${pitchers.map((p) => p!.name).join(', ')}`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 편집
// ---------------------------------------------------------------------------

export interface RosterEdit {
  ok: boolean;
  team: Team;
  message: string;
}

function replacePlayer(team: Team, next: Player): Team {
  return { ...team, players: team.players.map((p) => (p.id === next.id ? next : p)) };
}

/**
 * 투수 역할 변경.
 *
 * 선발 정원이 꽉 찬 상태에서 새 선발을 올리려면 기존 선발을 먼저 내려야 한다.
 * "자동으로 아무나 내려 준다"는 편할 것 같지만, 누가 빠졌는지 모른 채 경기에 들어가게 된다.
 */
export function setPitcherRole(team: Team, playerId: string, role: PitcherRole): RosterEdit {
  const player = team.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, team, message: '선수를 찾을 수 없습니다.' };
  if (player.kind !== 'PITCHER') return { ok: false, team, message: '투수가 아닙니다.' };
  if (player.role === role) return { ok: true, team, message: '' };

  if (role === 'SP' && starters(team).length >= ROTATION_SIZE) {
    return {
      ok: false,
      team,
      message: `선발은 ${ROTATION_SIZE}명까지입니다. 기존 선발 한 명을 먼저 내리세요.`,
    };
  }
  if (role === 'CP' && closers(team).length >= MAX_CLOSERS) {
    return { ok: false, team, message: '마무리는 한 명까지입니다.' };
  }

  const next = replacePlayer(team, { ...player, role });
  return {
    ok: true,
    team: { ...next, rotation: autoRotation(next), rotationIndex: 0 },
    message: `${player.name} → ${ROLE_KO[role]}`,
  };
}

/** 타자 포지션 변경. 같은 포지션이 겹쳐도 되며 수비 배치는 경기 시작 시 자동 정리된다. */
export function setBatterPosition(team: Team, playerId: string, pos: BatterPosition): RosterEdit {
  const player = team.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, team, message: '선수를 찾을 수 없습니다.' };
  if (player.kind !== 'BATTER') {
    return { ok: false, team, message: '투수는 야수 포지션을 맡을 수 없습니다.' };
  }
  if (player.position === pos) return { ok: true, team, message: '' };
  return {
    ok: true,
    team: replacePlayer(team, { ...player, position: pos }),
    message: `${player.name} → ${POSITION_KO[pos]}`,
  };
}

/** 로테이션 순서 바꾸기 (다음에 나갈 선발이 바뀐다) */
export function moveRotation(team: Team, index: number, dir: -1 | 1): Team {
  const next = team.rotation.slice();
  const j = index + dir;
  if (j < 0 || j >= next.length) return team;
  [next[index], next[j]] = [next[j], next[index]];
  return { ...team, rotation: next };
}

/** 타순 순서 바꾸기 */
export function moveLineup(team: Team, index: number, dir: -1 | 1): Team {
  const next = team.lineup.slice();
  const j = index + dir;
  if (j < 0 || j >= next.length) return team;
  [next[index], next[j]] = [next[j], next[index]];
  return { ...team, lineup: next };
}

/** 타순 한 칸을 벤치 선수와 맞바꾼다 */
export function swapIntoLineup(team: Team, slot: number, playerId: string): RosterEdit {
  const player = team.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, team, message: '선수를 찾을 수 없습니다.' };
  if (player.kind !== 'BATTER') return { ok: false, team, message: '타자만 타순에 넣을 수 있습니다.' };
  if (slot < 0 || slot >= team.lineup.length) return { ok: false, team, message: '잘못된 타순입니다.' };
  if (team.lineup.includes(playerId)) {
    return { ok: false, team, message: '이미 타순에 있는 선수입니다.' };
  }

  const lineup = team.lineup.slice();
  const outId = lineup[slot];
  lineup[slot] = playerId;
  const out = team.players.find((p) => p.id === outId);
  return {
    ok: true,
    team: { ...team, lineup },
    message: out ? `${slot + 1}번 ${out.name} → ${player.name}` : `${slot + 1}번 ${player.name}`,
  };
}

/** 타순·로테이션을 자동 편성으로 되돌린다 */
export function resetAssignments(team: Team): Team {
  const withRotation = { ...team, rotation: autoRotation(team), rotationIndex: 0 };
  return { ...withRotation, lineup: autoLineup(withRotation) };
}
