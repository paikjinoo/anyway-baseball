'use client';

import { useMemo } from 'react';
import {
  PITCHERS_PER_SLOT,
  batterQuota,
  fieldersOf,
  lineupSlotsFor,
  pitchersOf,
  suggestPicks,
} from '@/lib/game/allstar';
import { hitterScore, pitcherScore } from '@/lib/game/generator';
import type { PartyPicks } from '@/lib/net/protocol';
import type { Player, Team } from '@/lib/game/types';
import { playClick } from '@/lib/audio/sfx';

/**
 * 올스타전 선수 선발 패널.
 * 내 팀에서 야수 N명 + 투수 2명을 골라 팀원의 픽과 합친다.
 * 고른 야수에는 실제로 서게 될 타순 번호를 바로 표시해 준다.
 */
export function DraftPanel({
  team,
  slot,
  picks,
  onChange,
  locked,
}: {
  team: Team;
  slot: 0 | 1;
  picks: PartyPicks;
  onChange: (p: PartyPicks) => void;
  locked: boolean;
}) {
  const need = batterQuota(slot);
  const orders = lineupSlotsFor(slot);

  const fielders = useMemo(
    () => fieldersOf(team).sort((a, b) => hitterScore(b) - hitterScore(a)),
    [team],
  );
  const pitchers = useMemo(
    () => pitchersOf(team).sort((a, b) => pitcherScore(b) - pitcherScore(a)),
    [team],
  );

  function toggle(kind: 'batters' | 'pitchers', id: string, max: number) {
    if (locked) return;
    playClick();
    const cur = picks[kind];
    if (cur.includes(id)) {
      onChange({ ...picks, [kind]: cur.filter((x) => x !== id) });
    } else if (cur.length < max) {
      onChange({ ...picks, [kind]: [...cur, id] });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold">내 선수 고르기</h3>
        <span className="text-xs text-slate-500">
          {team.name} · 타순 {orders.join('·')}번을 맡습니다
        </span>
        <div className="flex-1" />
        <button
          className="btn !py-1 !text-xs"
          disabled={locked}
          onClick={() => {
            playClick();
            onChange(suggestPicks(team, slot));
          }}
        >
          자동 추천
        </button>
      </div>

      <Section
        title="야수"
        count={picks.batters.length}
        need={need}
        hint="고른 순서대로 타순이 정해집니다"
      >
        {fielders.map((p) => {
          const idx = picks.batters.indexOf(p.id);
          return (
            <PickRow
              key={p.id}
              player={p}
              selected={idx >= 0}
              badge={idx >= 0 ? `${orders[idx]}번` : undefined}
              disabled={locked || (idx < 0 && picks.batters.length >= need)}
              onClick={() => toggle('batters', p.id, need)}
              detail={`컨택 ${p.batting.contact} · 파워 ${p.batting.power} · 발 ${p.batting.speed}`}
            />
          );
        })}
      </Section>

      <Section
        title="투수"
        count={picks.pitchers.length}
        need={PITCHERS_PER_SLOT}
        hint="선발은 양 팀원의 투수를 모두 섞어 무작위로 뽑습니다"
      >
        {pitchers.map((p) => {
          const on = picks.pitchers.includes(p.id);
          return (
            <PickRow
              key={p.id}
              player={p}
              selected={on}
              disabled={locked || (!on && picks.pitchers.length >= PITCHERS_PER_SLOT)}
              onClick={() => toggle('pitchers', p.id, PITCHERS_PER_SLOT)}
              detail={`구종 ${Object.keys(p.pitching?.arsenal ?? {}).length}개 · 스태미나 ${p.pitching?.stamina ?? 0}`}
            />
          );
        })}
      </Section>

      <p className="text-[11px] leading-relaxed text-slate-500">
        수비 포지션이 겹치거나 비면 능력치에 맞춰 자동으로 재배치됩니다.
      </p>
    </div>
  );
}

function Section({
  title,
  count,
  need,
  hint,
  children,
}: {
  title: string;
  count: number;
  need: number;
  hint: string;
  children: React.ReactNode;
}) {
  const done = count === need;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-sm font-bold">{title}</span>
        <span className={`text-xs font-bold ${done ? 'text-lime-300' : 'text-amber-300'}`}>
          {count}/{need}
        </span>
        <span className="truncate text-[11px] text-slate-500">{hint}</span>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto pr-1">{children}</div>
    </div>
  );
}

function PickRow({
  player,
  selected,
  badge,
  disabled,
  onClick,
  detail,
}: {
  player: Player;
  selected: boolean;
  badge?: string;
  disabled: boolean;
  onClick: () => void;
  detail: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled && !selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition disabled:opacity-35 ${
        selected
          ? 'border-lime-400 bg-lime-500/15'
          : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08]'
      }`}
    >
      <span
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-black ${
          selected ? 'bg-lime-400 text-slate-900' : 'bg-white/10 text-slate-400'
        }`}
      >
        {player.position}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {player.name}
          <span className="ml-1 text-[10px] font-normal text-slate-500">#{player.number}</span>
        </span>
        <span className="block truncate text-[10px] text-slate-500">{detail}</span>
      </span>
      {badge && (
        <span className="shrink-0 rounded-full bg-lime-400/20 px-2 py-0.5 text-[10px] font-bold text-lime-200">
          {badge}
        </span>
      )}
    </button>
  );
}
