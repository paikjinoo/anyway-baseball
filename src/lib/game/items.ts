import { grantExp } from './progression';
import type { Inventory, ItemId, Player, Team } from './types';

/**
 * 아이템 시스템.
 *
 * 아이템은 **경기 보상으로 나오지 않는다.** 리그를 끝까지 마쳤을 때 1~3위에게만 차등 지급된다
 * (league.leagueFinishReward). 경기는 경험치와 골드만 준다.
 */

export interface ItemDef {
  id: ItemId;
  ko: string;
  desc: string;
  /** 사용 대상 제한 */
  target: 'ANY' | 'PITCHER';
  /** 경험치보충제일 때 지급량 */
  exp?: number;
  color: string;
}

export const ITEM_DEFS: Record<ItemId, ItemDef> = {
  EXP_S: {
    id: 'EXP_S',
    ko: '경험치보충제(소)',
    desc: '선수 한 명에게 경험치 60을 줍니다. (레벨 1 기준 약 2레벨)',
    target: 'ANY',
    exp: 60,
    color: '#4ade80',
  },
  EXP_M: {
    id: 'EXP_M',
    ko: '경험치보충제(중)',
    desc: '선수 한 명에게 경험치 200을 줍니다. (레벨 1 기준 약 4레벨)',
    target: 'ANY',
    exp: 200,
    color: '#22c55e',
  },
  EXP_L: {
    id: 'EXP_L',
    ko: '경험치보충제(대)',
    desc: '선수 한 명에게 경험치 550을 줍니다. (레벨 1 기준 약 8레벨)',
    target: 'ANY',
    exp: 550,
    color: '#16a34a',
  },
  EXP_XL: {
    id: 'EXP_XL',
    ko: '경험치보충제(특대)',
    desc: '선수 한 명에게 경험치 1,000을 줍니다. (레벨 1 기준 약 10레벨)',
    target: 'ANY',
    exp: 1000,
    color: '#15803d',
  },
  RESET_STATS: {
    id: 'RESET_STATS',
    ko: '능력치초기화권',
    desc: '이 선수에게 쓴 훈련 포인트와 구종 습득 골드를 전액 돌려받고 능력치를 처음 상태로 되돌립니다. 골드로 익힌 구종도 함께 사라집니다.',
    target: 'ANY',
    color: '#f87171',
  },
  CURE_INJURY: {
    id: 'CURE_INJURY',
    ko: '부상치료제',
    desc: '이 선수의 부상을 즉시 없앱니다.',
    target: 'ANY',
    color: '#fb923c',
  },
  STAMINA_TONIC: {
    id: 'STAMINA_TONIC',
    ko: '스테미나회복제',
    desc: '이 투수의 누적 피로를 완전히 없앱니다. 다음 경기를 완전히 회복한 상태로 시작합니다.',
    target: 'PITCHER',
    color: '#60a5fa',
  },
};

export const ITEM_ORDER: ItemId[] = [
  'EXP_S', 'EXP_M', 'EXP_L', 'EXP_XL', 'RESET_STATS', 'CURE_INJURY', 'STAMINA_TONIC',
];

export function itemCount(inv: Inventory, id: ItemId): number {
  return inv[id] ?? 0;
}

/** 인벤토리에 아이템을 더한다 (원본 불변) */
export function addItems(inv: Inventory, add: Inventory): Inventory {
  const next: Inventory = { ...inv };
  for (const [k, v] of Object.entries(add) as [ItemId, number][]) {
    next[k] = (next[k] ?? 0) + v;
  }
  return next;
}

export function totalItems(inv: Inventory): number {
  return Object.values(inv).reduce((a, b) => a + (b ?? 0), 0);
}

export interface UseItemResult {
  ok: boolean;
  team: Team;
  message: string;
}

/**
 * 능력치초기화. base 스냅샷으로 되돌리고 그동안 쓴 포인트를 전액 환급한다.
 *
 * 골드로 익힌 구종도 함께 사라진다 — base.arsenal로 되돌리기 때문이다. 그래서 습득에 쓴
 * 골드(spentGold)도 반드시 함께 환급해야 한다. 안 그러면 이 아이템이 구종만 지우고
 * 아무것도 돌려주지 않는 순수한 손해가 된다.
 *
 * 골드는 팀에 있으므로 환급액을 따로 돌려주고, 팀 갱신은 useItem이 한다.
 */
function resetStats(p: Player): { player: Player; goldRefund: number } {
  const next = structuredClone(p);
  next.batting = { ...p.base.batting };
  if (next.pitching) {
    next.pitching.stamina = p.base.stamina;
    next.pitching.arsenal = structuredClone(p.base.arsenal);
  }
  // 골드로 익힌 구종이 통째로 사라졌으니 그 습득 시점 기록도 남길 이유가 없다
  delete next.base.learned;
  next.trainingPoints += p.spentPoints;
  next.spentPoints = 0;
  const goldRefund = p.spentGold ?? 0;
  next.spentGold = 0;
  return { player: next, goldRefund };
}

/** 선수 한 명에게 아이템을 1개 사용한다. */
export function useItem(team: Team, playerId: string, id: ItemId): UseItemResult {
  const def = ITEM_DEFS[id];
  if (!def) return { ok: false, team, message: '알 수 없는 아이템입니다.' };
  if (itemCount(team.inventory, id) <= 0) {
    return { ok: false, team, message: `${def.ko}이(가) 없습니다.` };
  }

  const player = team.players.find((x) => x.id === playerId);
  if (!player) return { ok: false, team, message: '선수를 찾을 수 없습니다.' };
  if (def.target === 'PITCHER' && player.kind !== 'PITCHER') {
    return { ok: false, team, message: '투수에게만 사용할 수 있습니다.' };
  }

  let next: Player;
  let message: string;
  /** 능력치초기화권이 돌려주는 구종 습득 골드 */
  let goldRefund = 0;

  if (def.exp != null) {
    const gain = grantExp(player, def.exp);
    if (gain.wasted > 0 && gain.levelUps === 0) {
      return {
        ok: false,
        team,
        message: '이미 최대 레벨입니다. 티어를 강화한 뒤 사용하세요.',
      };
    }
    next = gain.player;
    // 최대 레벨에 막혀 버려진 분량은 숨기지 않는다. 모르면 같은 손해를 반복한다.
    const lost = gain.wasted > 0 ? ` (${gain.wasted.toLocaleString()} 버려짐)` : '';
    message =
      gain.levelUps > 0
        ? `${player.name} 경험치 +${def.exp.toLocaleString()}${lost} · ${gain.levelUps}레벨 상승 (훈련 P +${gain.pointsGained})`
        : `${player.name} 경험치 +${def.exp.toLocaleString()}${lost}`;
  } else if (id === 'RESET_STATS') {
    if (player.spentPoints <= 0 && (player.spentGold ?? 0) <= 0) {
      return { ok: false, team, message: '아직 훈련에 쓴 포인트도 골드도 없습니다.' };
    }
    const refund = player.spentPoints;
    const reset = resetStats(player);
    next = reset.player;
    goldRefund = reset.goldRefund;
    const parts = [];
    if (refund > 0) parts.push(`훈련 P ${refund}`);
    if (goldRefund > 0) parts.push(`${goldRefund.toLocaleString()}G`);
    message = `${player.name} 능력치 초기화 · ${parts.join(' · ')} 환급`;
  } else if (id === 'CURE_INJURY') {
    if (!player.injury) return { ok: false, team, message: '부상 상태가 아닙니다.' };
    next = structuredClone(player);
    delete next.injury;
    message = `${player.name} 부상 회복`;
  } else if (id === 'STAMINA_TONIC') {
    if (player.fatigue <= 0) return { ok: false, team, message: '이미 완전히 회복된 상태입니다.' };
    next = { ...structuredClone(player), fatigue: 0 };
    message = `${player.name} 스태미나 완전 회복`;
  } else {
    return { ok: false, team, message: '사용할 수 없는 아이템입니다.' };
  }

  return {
    ok: true,
    message,
    team: {
      ...team,
      gold: team.gold + goldRefund,
      inventory: { ...team.inventory, [id]: itemCount(team.inventory, id) - 1 },
      players: team.players.map((x) => (x.id === playerId ? next : x)),
    },
  };
}
