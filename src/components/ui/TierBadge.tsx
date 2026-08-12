'use client';

import { TIER_COLOR } from '@/lib/game/progression';
import type { Player } from '@/lib/game/types';

/**
 * 티어 + 레벨 배지. 선수단 목록과 상점에서 같은 모양으로 쓴다.
 *
 * 색을 hex에 알파 접미사로 붙인다 — TIER_COLOR에 티어가 추가돼도 여기만 따라오면 되고,
 * 화면마다 배지를 따로 만들면 그때 한쪽만 조용히 어긋난다.
 */
export function TierBadge({ player }: { player: Player }) {
  return (
    <span
      className="shrink-0 rounded px-1 py-0.5 text-[10px] font-black leading-none"
      style={{ background: TIER_COLOR[player.tier] + '30', color: TIER_COLOR[player.tier] }}
    >
      {player.tier}
      <span className="ml-0.5 font-bold opacity-80">{player.level}</span>
    </span>
  );
}
