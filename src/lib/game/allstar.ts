/**
 * 2대2(올스타전) 팀 구성.
 *
 * 한 편은 사람 2명이고, 각자 **자기 팀에서** 야수와 투수를 골라 온다.
 * 두 사람의 픽을 합쳐 하나의 올스타 팀을 만들고, 타순은 번갈아 배치한다.
 *
 *   slot 0 → 1·3·5·7·9번 타자 (5명)
 *   slot 1 → 2·4·6·8번 타자   (4명)
 *
 * 이렇게 하면 두 사람이 한 타석씩 번갈아 조작하게 되어 대기 시간이 가장 짧다.
 * 선발 투수는 두 사람이 낸 투수를 모두 섞어 무작위로 뽑는다(요청 사양).
 */

import { Rng } from './rng';
import { hitterScore, pitcherScore } from './generator';
import type { OwnerMap, PartyPicks } from '../net/protocol';
import { TEAM_SCHEMA_VERSION } from './types';
import type { Player, Position, Side, Team } from './types';

/** slot별로 골라야 하는 야수 수. 합쳐서 9명. */
export const BATTERS_PER_SLOT: [number, number] = [5, 4];
/** slot별로 골라야 하는 투수 수. 한 편에 4명. */
export const PITCHERS_PER_SLOT = 2;

export function batterQuota(slot: 0 | 1): number {
  return BATTERS_PER_SLOT[slot];
}

/** slot이 맡는 타순 번호(1-base). slot 0 → [1,3,5,7,9], slot 1 → [2,4,6,8] */
export function lineupSlotsFor(slot: 0 | 1): number[] {
  return Array.from({ length: batterQuota(slot) }, (_, i) => i * 2 + 1 + slot);
}

export interface AllStarEntry {
  uid: string;
  slot: 0 | 1;
  team: Team;
  picks: PartyPicks;
}

/** 팀에서 투수가 아닌 선수 */
export function fieldersOf(team: Team): Player[] {
  return team.players.filter((p) => p.position !== 'P');
}

export function pitchersOf(team: Team): Player[] {
  return team.players.filter((p) => p.position === 'P' && p.pitching);
}

/**
 * 기본 추천 픽.
 * 야수는 포지션이 겹치지 않게 우선 고르고(수비 배치가 자연스럽도록),
 * 남는 자리는 타격 점수가 높은 순으로 채운다.
 */
export function suggestPicks(team: Team, slot: 0 | 1): PartyPicks {
  const need = batterQuota(slot);
  const pool = fieldersOf(team).sort((a, b) => hitterScore(b) - hitterScore(a));

  // slot 0은 내야 중심, slot 1은 외야 중심으로 나눠 잡아 두 사람의 픽이
  // 자연스럽게 서로 다른 포지션을 덮게 한다.
  const priority: Position[] =
    slot === 0 ? ['C', 'SS', '1B', '3B', '2B'] : ['CF', 'LF', 'RF', '2B', 'DH'];

  const batters: Player[] = [];
  const taken = new Set<string>();
  for (const pos of priority) {
    if (batters.length >= need) break;
    const p = pool.find((x) => !taken.has(x.id) && x.position === pos);
    if (p) {
      batters.push(p);
      taken.add(p.id);
    }
  }
  for (const p of pool) {
    if (batters.length >= need) break;
    if (taken.has(p.id)) continue;
    batters.push(p);
    taken.add(p.id);
  }

  const pitchers = pitchersOf(team)
    .sort((a, b) => pitcherScore(b) - pitcherScore(a))
    .slice(0, PITCHERS_PER_SLOT);

  return { batters: batters.map((p) => p.id), pitchers: pitchers.map((p) => p.id) };
}

/** 픽이 규격에 맞는지 */
export function picksComplete(picks: PartyPicks, slot: 0 | 1): boolean {
  return picks.batters.length === batterQuota(slot) && picks.pitchers.length === PITCHERS_PER_SLOT;
}

/** 호스트가 게스트의 픽 메시지를 신뢰하기 전에 수행하는 런타임 검증. */
export function validatePartyPicks(
  team: Team,
  picks: PartyPicks,
  slot: 0 | 1,
  requireComplete = false,
): string | null {
  if (!picks || !Array.isArray(picks.batters) || !Array.isArray(picks.pitchers)) {
    return '선수 선택 형식이 올바르지 않습니다.';
  }

  const batterNeed = batterQuota(slot);
  if (picks.batters.length > batterNeed || picks.pitchers.length > PITCHERS_PER_SLOT) {
    return '선수 선택 인원이 허용 범위를 넘었습니다.';
  }
  if (
    requireComplete &&
    (picks.batters.length !== batterNeed || picks.pitchers.length !== PITCHERS_PER_SLOT)
  ) {
    return '필요한 선수 선택이 끝나지 않았습니다.';
  }

  const ids = [...picks.batters, ...picks.pitchers];
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    return '같은 선수를 중복 선택할 수 없습니다.';
  }

  const roster = new Map(team.players.map((p) => [p.id, p]));
  if (picks.batters.some((id) => !roster.has(id) || roster.get(id)?.position === 'P')) {
    return '야수 선택에 소속 팀 야수가 아닌 선수가 포함되어 있습니다.';
  }
  if (
    picks.pitchers.some((id) => {
      const p = roster.get(id);
      return !p || p.position !== 'P' || !p.pitching;
    })
  ) {
    return '투수 선택에 소속 팀 투수가 아닌 선수가 포함되어 있습니다.';
  }
  return null;
}

// ---------------------------------------------------------------------------

/** 두 사람의 선수 id가 우연히 겹쳐도 섞이지 않도록 붙이는 접두사 */
function prefixOf(side: Side, slot: 0 | 1): string {
  return `${side === 'away' ? 'a' : 'h'}${slot}~`;
}

function takePlayers(entry: AllStarEntry, ids: string[], side: Side): Player[] {
  const byId = new Map(entry.team.players.map((p) => [p.id, p]));
  const prefix = prefixOf(side, entry.slot);
  const out: Player[] = [];
  for (const id of ids) {
    const src = byId.get(id);
    if (!src) continue;
    const copy = structuredClone(src);
    copy.id = prefix + src.id;
    out.push(copy);
  }
  return out;
}

export interface AllStarResult {
  team: Team;
  /** 선수 id -> 그 선수를 조작하는 사람의 uid */
  owners: OwnerMap;
}

/**
 * 두 사람의 픽을 합쳐 한 팀을 만든다.
 *
 * @param seed 선발 투수 추첨에 쓰는 시드. 같은 시드면 같은 선발이 나온다.
 */
export function buildAllStarTeam(
  entries: [AllStarEntry, AllStarEntry],
  side: Side,
  seed: number,
): AllStarResult {
  const bySlot = [...entries].sort((a, b) => a.slot - b.slot) as [AllStarEntry, AllStarEntry];
  const [first, second] = bySlot;

  const owners: OwnerMap = {};
  const players: Player[] = [];

  const batters: Player[][] = [];
  const pitchers: Player[][] = [];

  for (const entry of bySlot) {
    const b = takePlayers(entry, entry.picks.batters, side).slice(0, batterQuota(entry.slot));
    const p = takePlayers(entry, entry.picks.pitchers, side).slice(0, PITCHERS_PER_SLOT);
    batters[entry.slot] = b;
    pitchers[entry.slot] = p;
    for (const x of [...b, ...p]) {
      owners[x.id] = entry.uid;
      players.push(x);
    }
  }

  // 타순: slot 0 → 1·3·5·7·9번, slot 1 → 2·4·6·8번
  const lineup: string[] = [];
  for (let i = 0; i < BATTERS_PER_SLOT[0]; i++) {
    if (batters[0][i]) lineup.push(batters[0][i].id);
    if (batters[1][i]) lineup.push(batters[1][i].id);
  }
  // 픽이 모자란 비정상 상황 대비: 남은 야수 → 투수 순으로 9명을 채운다
  if (lineup.length < 9) {
    const inLineup = new Set(lineup);
    for (const p of players) {
      if (lineup.length >= 9) break;
      if (!inLineup.has(p.id) && p.kind === 'BATTER') {
        lineup.push(p.id);
        inLineup.add(p.id);
      }
    }
  }

  // 선발 투수는 두 사람의 투수를 모두 섞어 무작위로 뽑는다
  const rng = new Rng(seed);
  const rotation = rng.shuffle([...(pitchers[0] ?? []), ...(pitchers[1] ?? [])]).map((p) => p.id);

  const now = Date.now();
  const team: Team = {
    id: `allstar-${side}`,
    schemaVersion: TEAM_SCHEMA_VERSION,
    ownerUid: first.uid,
    name: `${first.team.name} · ${second.team.name}`,
    abbr: first.team.abbr,
    logoId: first.team.logoId,
    // 유니폼은 slot 0의 색을 쓰되, 포인트 색만 slot 1의 팀 색으로 둬서 둘 다 드러나게 한다
    primaryColor: first.team.primaryColor,
    secondaryColor: first.team.secondaryColor,
    accentColor: second.team.primaryColor,
    uniformType: first.team.uniformType,
    players,
    lineup: lineup.slice(0, 9),
    rotation,
    rotationIndex: 0,
    // 올스타 팀은 즉석에서 만들어지는 임시 팀이라 재화를 갖지 않는다.
    gold: 0,
    inventory: {},
    createdAt: now,
    updatedAt: now,
  };

  return { team, owners };
}

/** 원정/홈 약칭이 겹치면 스코어보드에서 구분이 안 되므로 한쪽을 살짝 바꾼다 */
export function disambiguateAbbr(away: Team, home: Team) {
  if (away.abbr !== home.abbr) return;
  home.abbr = `${home.abbr.slice(0, 2)}H`;
  away.abbr = `${away.abbr.slice(0, 2)}A`;
}
