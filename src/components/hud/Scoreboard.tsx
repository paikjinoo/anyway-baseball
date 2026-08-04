'use client';

import type { GameState } from '@/lib/game/types';

export function Scoreboard({ state }: { state: GameState }) {
  const innings = Math.max(state.settings.regulationInnings, state.lineScore.away.length);
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-center text-xs tabular">
          <thead>
            <tr className="bg-white/5 text-slate-400">
              <th className="px-2 py-1.5 text-left">팀</th>
              {Array.from({ length: innings }, (_, i) => (
                <th key={i} className="w-6 px-1 py-1.5">
                  {i + 1}
                </th>
              ))}
              <th className="w-7 px-1 py-1.5 font-bold text-slate-200">R</th>
              <th className="w-7 px-1 py-1.5">H</th>
              <th className="w-7 px-1 py-1.5">E</th>
            </tr>
          </thead>
          <tbody>
            {(['away', 'home'] as const).map((side) => {
              const t = state[side];
              const batting =
                state.phase !== 'GAME_OVER' &&
                ((side === 'away' && state.half === 'TOP') || (side === 'home' && state.half === 'BOTTOM'));
              return (
                <tr key={side} className={batting ? 'bg-lime-500/10' : ''}>
                  <td className="px-2 py-1.5 text-left">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ background: t.primaryColor }}
                      />
                      <span className="font-bold">{t.abbr}</span>
                      {batting && <span className="text-[9px] text-lime-400">●</span>}
                    </span>
                  </td>
                  {Array.from({ length: innings }, (_, i) => {
                    const played =
                      state.inning > i + 1 ||
                      (state.inning === i + 1 && (side === 'away' || state.half === 'BOTTOM'));
                    return (
                      <td key={i} className="px-1 py-1.5 text-slate-300">
                        {played ? (state.lineScore[side][i] ?? 0) : ''}
                      </td>
                    );
                  })}
                  <td className="px-1 py-1.5 text-base font-black text-white">{t.runs}</td>
                  <td className="px-1 py-1.5 text-slate-400">{t.hits}</td>
                  <td className="px-1 py-1.5 text-slate-400">{t.errors}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CountDisplay({ state }: { state: GameState }) {
  return (
    <div className="panel flex items-center gap-4 px-4 py-2.5">
      <div className="text-center">
        <div className="text-[10px] text-slate-500">이닝</div>
        <div className="text-sm font-black">
          {state.inning}
          <span className="ml-0.5 text-xs">{state.half === 'TOP' ? '초' : '말'}</span>
        </div>
      </div>

      <Dots label="B" count={state.balls} total={3} color="#4ade80" />
      <Dots label="S" count={state.strikes} total={2} color="#fbbf24" />
      <Dots label="O" count={state.outs} total={2} color="#f87171" />

      <Diamond bases={state.bases.map(Boolean)} />
    </div>
  );
}

function Dots({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-2 text-[11px] font-bold text-slate-400">{label}</span>
      <span className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="h-2.5 w-2.5 rounded-full border transition"
            style={{
              background: i < count ? color : 'transparent',
              borderColor: i < count ? color : 'rgba(148,163,184,0.35)',
            }}
          />
        ))}
      </span>
    </div>
  );
}

export function Diamond({ bases, size = 34 }: { bases: boolean[]; size?: number }) {
  const s = size;
  const b = s * 0.26;
  return (
    <svg width={s} height={s} viewBox="0 0 40 40" aria-label="주자 상황">
      {/* 2루 */}
      <rect
        x="15"
        y="3"
        width="10"
        height="10"
        transform="rotate(45 20 8)"
        fill={bases[1] ? '#fbbf24' : 'rgba(148,163,184,0.2)'}
        stroke="rgba(148,163,184,0.5)"
      />
      {/* 3루 */}
      <rect
        x="3"
        y="15"
        width="10"
        height="10"
        transform="rotate(45 8 20)"
        fill={bases[2] ? '#fbbf24' : 'rgba(148,163,184,0.2)'}
        stroke="rgba(148,163,184,0.5)"
      />
      {/* 1루 */}
      <rect
        x="27"
        y="15"
        width="10"
        height="10"
        transform="rotate(45 32 20)"
        fill={bases[0] ? '#fbbf24' : 'rgba(148,163,184,0.2)'}
        stroke="rgba(148,163,184,0.5)"
      />
      {/* 홈 */}
      <rect
        x="15"
        y="27"
        width="10"
        height="10"
        transform="rotate(45 20 32)"
        fill="rgba(226,232,240,0.35)"
        stroke="rgba(148,163,184,0.5)"
      />
    </svg>
  );
}
