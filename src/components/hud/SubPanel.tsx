'use client';

import { useMemo, useState } from 'react';
import { benchCandidates } from '@/lib/game/engine';
import { POSITION_KO } from '@/lib/game/constants';
import { effSpeed } from '@/lib/game/batting';
import { hitterScore } from '@/lib/game/generator';
import { useMatchStore } from '@/lib/store/matchStore';
import type { GameState, Position, Side } from '@/lib/game/types';

/**
 * 대타 / 대주자 / 대수비 패널.
 *
 * 투수 교체와 같은 규칙이다 — 한 번 빠진 선수는 돌아오지 못하므로, 벤치 목록에서
 * 이미 쓴 선수는 아예 사라진다. 아직 CPU·리그 전용이라 온라인에서는 이 패널을 띄우지 않는다.
 */
export function SubPanel({
  state,
  playerSide,
  batting,
}: {
  state: GameState;
  playerSide: Side;
  batting: boolean;
}) {
  const substituteFielder = useMatchStore((s) => s.substituteFielder);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<{ kind: 'HIT' } | { kind: 'RUN'; base: number } | { kind: 'FIELD'; pos: Position } | null>(null);

  const bench = useMemo(() => benchCandidates(state, playerSide), [state, playerSide]);
  const mine = state[playerSide];

  const runners = state.bases
    .map((r, i) => ({ runner: r, base: i }))
    .filter((x) => x.runner) as { runner: NonNullable<GameState['bases'][0]>; base: number }[];

  const fieldSpots = (['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'] as Position[])
    .map((pos) => ({ pos, id: mine.defense[pos] }))
    .filter((x) => x.id);

  if (!bench.length) {
    return (
      <p className="mt-2 text-center text-[11px] text-slate-500">
        교체할 수 있는 벤치 선수가 없습니다.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        className="btn w-full !py-1.5 !text-xs"
        onClick={() => {
          setOpen((v) => !v);
          setTarget(null);
        }}
      >
        {open ? '교체 닫기' : `선수 교체 (벤치 ${bench.length}명)`}
      </button>

      {open && (
        <div className="mt-2 space-y-2 rounded-lg bg-white/5 p-2">
          {/* 1단계: 누구를 뺄지 */}
          {!target && (
            <>
              {batting ? (
                <>
                  <Row label="대타" hint={`${currentBatterName(state, playerSide)} 대신`}>
                    <button className="btn !px-2 !py-1 !text-[11px]" onClick={() => setTarget({ kind: 'HIT' })}>
                      선택
                    </button>
                  </Row>
                  {runners.map(({ runner, base }) => (
                    <Row
                      key={base}
                      label="대주자"
                      hint={`${base + 1}루 ${mine.roster[runner.playerId]?.name ?? ''}`}
                    >
                      <button
                        className="btn !px-2 !py-1 !text-[11px]"
                        onClick={() => setTarget({ kind: 'RUN', base })}
                      >
                        선택
                      </button>
                    </Row>
                  ))}
                </>
              ) : (
                <div className="grid grid-cols-2 gap-1">
                  {fieldSpots.map(({ pos, id }) => (
                    <button
                      key={pos}
                      className="btn !px-2 !py-1 !text-[11px]"
                      onClick={() => setTarget({ kind: 'FIELD', pos })}
                    >
                      {POSITION_KO[pos]} {mine.roster[id!]?.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* 2단계: 누구를 넣을지 */}
          {target && (
            <>
              <div className="flex items-center gap-2 px-1 text-[11px] text-slate-400">
                <span>
                  {target.kind === 'HIT'
                    ? '대타로 넣을 선수'
                    : target.kind === 'RUN'
                      ? `${target.base + 1}루 대주자`
                      : `${POSITION_KO[target.pos]} 대수비`}
                </span>
                <div className="flex-1" />
                <button className="underline" onClick={() => setTarget(null)}>
                  뒤로
                </button>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {bench.map((p) => (
                  <button
                    key={p.id}
                    className="flex w-full items-center gap-2 rounded-md bg-white/5 px-2 py-1.5 text-left text-[11px] hover:bg-white/10"
                    onClick={() => {
                      substituteFielder(
                        target.kind,
                        p.id,
                        target.kind === 'RUN' ? target.base : target.kind === 'FIELD' ? target.pos : undefined,
                      );
                      setTarget(null);
                      setOpen(false);
                    }}
                  >
                    <span className="flex-1 truncate font-semibold">{p.name}</span>
                    <span className="text-slate-500">{POSITION_KO[p.position]}</span>
                    <span className="tabular text-slate-400">
                      {target.kind === 'RUN'
                        ? `발 ${effSpeed(p)}`
                        : `종합 ${Math.round(hitterScore(p) / 4.9)}`}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="px-1 text-[10px] leading-relaxed text-slate-500">
            교체돼 나간 선수는 이 경기에 다시 나올 수 없습니다.
          </p>
        </div>
      )}
    </div>
  );
}

function currentBatterName(state: GameState, side: Side): string {
  const t = state[side];
  return t.roster[t.lineup[t.atBatIndex % t.lineup.length]]?.name ?? '';
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-white/5 px-2 py-1.5">
      <span className="text-[11px] font-bold text-lime-300">{label}</span>
      <span className="flex-1 truncate text-[11px] text-slate-400">{hint}</span>
      {children}
    </div>
  );
}
