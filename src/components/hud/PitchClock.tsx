'use client';

import { useEffect, useState } from 'react';
import {
  PITCH_CLOCK_MS,
  PITCH_CLOCK_SEC,
  PITCH_CLOCK_WARN_SEC,
} from '@/lib/game/constants';
import { pitchClockRemaining, pitchClockSubject, useMatchStore } from '@/lib/store/matchStore';

const RADIUS = 16;
const CIRCUM = 2 * Math.PI * RADIUS;

/**
 * 피치 클락 표시. 시계가 돌지 않는 국면에서는 아무것도 그리지 않는다.
 *
 * 갱신용 타이머가 store.tick()도 함께 호출한다.
 * 3D 캔버스의 useFrame은 화면이 가려지면 멈추므로, 시계를 거기에만 맡기면
 * 정작 다른 창을 보는 동안 시간이 흐르지 않는다.
 */
export function PitchClock() {
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    const id = setInterval(() => {
      const t = performance.now();
      useMatchStore.getState().tick(t);
      setNow(t);
    }, 100);
    return () => clearInterval(id);
  }, []);

  const remaining = useMatchStore((s) => pitchClockRemaining(s, now));
  const subject = useMatchStore(pitchClockSubject);
  if (remaining === null || !subject) return null;

  const sec = remaining / 1000;
  const shown = Math.ceil(sec - 0.001);
  const danger = sec <= PITCH_CLOCK_WARN_SEC;
  const warn = !danger && sec <= PITCH_CLOCK_SEC / 2;
  const color = danger ? '#f87171' : warn ? '#fbbf24' : '#4ade80';

  return (
    <div className={`panel flex items-center gap-2.5 px-3 py-2 ${danger ? 'flash' : ''}`}>
      <div className="relative h-9 w-9">
        <svg width="36" height="36" viewBox="0 0 40 40" aria-label="피치 클락">
          <circle
            cx="20"
            cy="20"
            r={RADIUS}
            fill="none"
            stroke="rgba(148,163,184,0.25)"
            strokeWidth="3.5"
          />
          <circle
            cx="20"
            cy="20"
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={CIRCUM}
            strokeDashoffset={CIRCUM * (1 - remaining / PITCH_CLOCK_MS)}
            transform="rotate(-90 20 20)"
          />
        </svg>
        <span
          className="absolute inset-0 grid place-items-center text-sm font-black tabular"
          style={{ color }}
        >
          {shown}
        </span>
      </div>
      <div className="leading-tight">
        <div className="text-[10px] text-slate-500">피치 클락</div>
        <div className="text-[11px] font-bold" style={{ color }}>
          {subject === 'DEFENSE' ? '위반 시 볼' : '위반 시 스트라이크'}
        </div>
      </div>
    </div>
  );
}
