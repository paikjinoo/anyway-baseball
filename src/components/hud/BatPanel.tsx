'use client';

import { useEffect, useRef, useState } from 'react';
import { isRelayMode, useMatchStore } from '@/lib/store/matchStore';
import { SWING_DEFS, swingDisplayRadius } from '@/lib/game/constants';
import { playClick } from '@/lib/audio/sfx';
import type { GameState, Player, SwingType } from '@/lib/game/types';
import { baseballRate } from '@/lib/format';

const SWING_KEYS: Record<string, SwingType> = {
  Space: 'NORMAL',
  KeyA: 'POWER',
  KeyS: 'BUNT',
};

/**
 * 타격 조작.
 * - 마우스/터치로 존 위에서 조준점을 움직인다
 * - 클릭 / Space = 일반타격, Shift+클릭 / A = 강한타격, B / S = 번트
 * - 투구 전에는 주자별 도루 지시가 가능하다
 */
export function BatPanel({ state, batter }: { state: GameState; batter: Player }) {
  const phase = useMatchStore((s) => s.phase);
  const aim = useMatchStore((s) => s.aim);
  const setAim = useMatchStore((s) => s.setAim);
  const swingType = useMatchStore((s) => s.swingType);
  const setSwingType = useMatchStore((s) => s.setSwingType);
  const swing = useMatchStore((s) => s.swing);
  const stealOrders = useMatchStore((s) => s.stealOrders);
  const toggleSteal = useMatchStore((s) => s.toggleSteal);
  const requestPitch = useMatchStore((s) => s.requestPitch);
  const mode = useMatchStore((s) => s.mode);
  const relay = isRelayMode(mode);
  const zoneRef = useRef<HTMLDivElement>(null);
  // 투수가 공을 놓기 전(와인드업 중)에는 스윙 안내를 띄우지 않는다
  const [released, setReleased] = useState(false);

  useEffect(() => {
    if (phase !== 'FLIGHT') {
      setReleased(false);
      return;
    }
    const wait = useMatchStore.getState().pitchStartAt - performance.now();
    if (wait <= 0) {
      setReleased(true);
      return;
    }
    const id = setTimeout(() => setReleased(true), wait);
    return () => clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (relay && swingType === 'BUNT') setSwingType('NORMAL');
  }, [relay, setSwingType, swingType]);

  // 키보드 조작
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const t = SWING_KEYS[e.code];
      if (t) {
        if (relay && t === 'BUNT') return;
        e.preventDefault();
        // 투구 전이면 Space는 "투구 받기"로 동작한다
        if (useMatchStore.getState().phase === 'SETUP') {
          if (e.code === 'Space') requestPitch();
          else setSwingType(t);
          return;
        }
        setSwingType(t);
        swing(t);
        return;
      }
      // 방향키로 조준
      const step = 0.22;
      const a = useMatchStore.getState().aim;
      if (e.code === 'ArrowLeft') setAim(a.x - step, a.y);
      else if (e.code === 'ArrowRight') setAim(a.x + step, a.y);
      else if (e.code === 'ArrowUp') setAim(a.x, a.y + step);
      else if (e.code === 'ArrowDown') setAim(a.x, a.y - step);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [relay, swing, setAim, setSwingType, requestPitch]);

  function move(e: React.PointerEvent<HTMLDivElement>) {
    const el = zoneRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = (((e.clientX - r.left) / r.width) * 2 - 1) * 1.7;
    const ny = (1 - ((e.clientY - r.top) / r.height) * 2) * 1.7;
    setAim(nx, ny);
  }

  const runners = state.bases;
  const canSteal = phase === 'SETUP';

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] text-slate-500">타자</div>
          <div className="font-bold">
            {batter.name}
            <span className="ml-1.5 text-xs font-normal text-slate-400">
              컨택 {batter.batting.contact} · 파워 {batter.batting.power}
            </span>
          </div>
        </div>
        <div className="text-right text-[11px] text-slate-500">
          {batter.season.ab > 0
            ? `${baseballRate(batter.season.h / batter.season.ab)} · ${batter.season.hr}홈런`
            : '첫 타석'}
        </div>
      </div>

      {/* 조준 그리드 */}
      <div>
        <div className="field-label">
          조준 <span className="hide-on-touch">(마우스 이동 · 방향키)</span>
          <span className="touch-only">(끌어서 조준 · 손을 떼면 스윙)</span>
        </div>
        <div
          ref={zoneRef}
          onPointerMove={move}
          onPointerDown={(e) => {
            move(e);
            // 터치는 누르는 순간 스윙하지 않는다.
            //
            // 마우스는 커서를 옮겨 조준해 두고 클릭으로 치지만, 손가락은 화면에 닿는
            // 그 순간이 곧 조준이라 같은 동작에 스윙까지 묶으면 **조준 자체가 불가능**하다
            // (닿은 자리로 아무렇게나 휘두르게 된다). 그래서 터치는 끌어서 조준하고
            // 손을 뗄 때 친다 — 투수가 와인드업하는 동안 겨누고 공이 올 때 놓으면 된다.
            if (e.pointerType === 'touch') {
              e.currentTarget.setPointerCapture(e.pointerId);
              return;
            }
            if (phase === 'SETUP') return;
            const t: SwingType = e.shiftKey ? 'POWER' : !relay && swingType === 'BUNT' ? 'BUNT' : 'NORMAL';
            swing(t);
          }}
          onPointerUp={(e) => {
            if (e.pointerType !== 'touch' || phase === 'SETUP') return;
            // 터치에는 Shift가 없으므로 아래 토글로 고른 타격 방식을 그대로 쓴다.
            swing(swingType);
          }}
          className="relative mx-auto aspect-square w-full max-w-[190px] cursor-crosshair touch-none rounded-lg border border-white/10 bg-slate-950/70"
        >
          <div
            className="absolute border-2 border-amber-400/70"
            style={{
              left: `${((1 - 1 / 1.7) / 2) * 100}%`,
              top: `${((1 - 1 / 1.7) / 2) * 100}%`,
              width: `${(1 / 1.7) * 100}%`,
              height: `${(1 / 1.7) * 100}%`,
            }}
          >
            <div className="grid h-full w-full grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="border border-amber-400/20" />
              ))}
            </div>
          </div>
          {/* 배트 판정 범위 */}
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan-400 bg-cyan-400/15"
            style={{
              left: `${((aim.x / 1.7 + 1) / 2) * 100}%`,
              top: `${((1 - aim.y / 1.7) / 2) * 100}%`,
              width: `${(swingDisplayRadius(swingType, batter.batting.contact) / 1.7) * 100}%`,
              aspectRatio: '1',
            }}
          />
        </div>
      </div>

      {/* 타격 방식 */}
      <div className={`grid gap-1.5 ${relay ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {(['NORMAL', 'POWER', ...(relay ? [] : ['BUNT'])] as SwingType[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setSwingType(t);
              playClick();
            }}
            className={`rounded-lg border px-2 py-1.5 text-center transition ${
              swingType === t
                ? 'border-lime-400 bg-lime-500/20 text-lime-200'
                : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08]'
            }`}
          >
            <div className="text-xs font-bold">{SWING_DEFS[t].ko}</div>
            <div className="text-[10px] text-slate-500">
              {t === 'NORMAL' ? 'Space' : t === 'POWER' ? 'A / Shift' : 'S'}
            </div>
          </button>
        ))}
      </div>

      {/* 도루 */}
      {(runners[0] || runners[1] || runners[2]) && (
        <div>
          <div className="field-label">도루 지시 {canSteal ? '' : '(투구 전에만)'}</div>
          <div className="flex gap-1.5">
            {runners.map((r, i) => {
              if (!r) return null;
              const p = state[state.half === 'TOP' ? 'away' : 'home'].roster[r.playerId];
              const on = stealOrders.includes(i);
              const nextOccupied = i < 2 && runners[i + 1];
              return (
                <button
                  key={i}
                  disabled={!canSteal || !!nextOccupied}
                  onClick={() => {
                    toggleSteal(i);
                    playClick();
                  }}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition ${
                    on
                      ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                      : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08]'
                  }`}
                >
                  <div className="font-bold">{i + 1}루 주자</div>
                  <div className="truncate text-[10px] text-slate-500">
                    {p?.name} · 발 {p?.batting.speed ?? '-'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {phase === 'SETUP' &&
        (mode === 'CPU' ? (
          <button className="btn btn-warn w-full" onClick={() => requestPitch()}>
            타석에 들어서기 (Space)
          </button>
        ) : (
          <p className="text-center text-[11px] text-slate-500">상대의 투구를 기다리는 중…</p>
        ))}
      {phase === 'FLIGHT' &&
        (released ? (
          <p className="text-center text-[11px] font-bold text-cyan-300 flash">지금 스윙!</p>
        ) : (
          <p className="text-center text-[11px] text-slate-500">투수 와인드업…</p>
        ))}
    </div>
  );
}
