'use client';

import type { UniformType } from '@/lib/game/types';

/** 유니폼 상의 미리보기 (SVG) */
export function UniformPreview({
  type,
  primary,
  secondary,
  accent,
  width = 80,
}: {
  type: UniformType;
  primary: string;
  secondary: string;
  accent: string;
  width?: number;
}) {
  const id = `u-${type}-${primary}-${secondary}`.replace(/[^a-zA-Z0-9-]/g, '');
  const body = type === 'VEST' ? secondary : primary;

  return (
    <svg width={width} height={width * 1.15} viewBox="0 0 100 115" aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={primary} />
          <stop offset="100%" stopColor={accent} />
        </linearGradient>
        <clipPath id={`${id}-c`}>
          <path d="M30 12 L50 20 L70 12 L88 24 L80 44 L72 40 V104 H28 V40 L20 44 L12 24 Z" />
        </clipPath>
      </defs>

      {/* 몸통 */}
      <path
        d="M30 12 L50 20 L70 12 L88 24 L80 44 L72 40 V104 H28 V40 L20 44 L12 24 Z"
        fill={type === 'GRADIENT' ? `url(#${id}-g)` : body}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="1.5"
      />

      <g clipPath={`url(#${id}-c)`}>
        {type === 'PINSTRIPE' &&
          Array.from({ length: 9 }, (_, i) => (
            <rect key={i} x={12 + i * 9} y="0" width="2" height="115" fill={secondary} opacity="0.85" />
          ))}
        {type === 'SASH' && (
          <path d="M-10 100 L110 -5 L110 20 L-10 125 Z" fill={accent} opacity="0.95" />
        )}
        {type === 'RAGLAN' && (
          <>
            <path d="M30 12 L12 24 L20 44 L28 40 V12 Z" fill={secondary} />
            <path d="M70 12 L88 24 L80 44 L72 40 V12 Z" fill={secondary} />
          </>
        )}
        {type === 'VEST' && <rect x="30" y="0" width="40" height="115" fill={primary} />}
      </g>

      {/* 목선 */}
      <path d="M38 13 Q50 26 62 13" fill="none" stroke={accent} strokeWidth="3.5" />
      {/* 단추 라인 */}
      <line x1="50" y1="22" x2="50" y2="100" stroke="rgba(0,0,0,0.28)" strokeWidth="1.2" />
      {/* 벨트 */}
      <rect x="28" y="98" width="44" height="7" fill={accent} />
    </svg>
  );
}
