'use client';

/**
 * 팀 로고. 외부 이미지 없이 SVG 패스로 그린다.
 * logoId는 generator.ts의 LOGO_IDS 값과 대응한다.
 */
export function TeamLogo({
  logoId,
  primary,
  secondary,
  size = 48,
}: {
  logoId: string;
  primary: string;
  secondary: string;
  size?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r="48" fill={primary} />
      <circle cx="50" cy="50" r="43" fill="none" stroke={secondary} strokeWidth="3" opacity="0.9" />
      <g fill={secondary}>{shapeFor(logoId)}</g>
    </svg>
  );
}

function shapeFor(id: string) {
  switch (id) {
    case 'star':
      return <path d="M50 20 L59 42 L83 43 L64 58 L71 81 L50 68 L29 81 L36 58 L17 43 L41 42 Z" />;
    case 'flame':
      return (
        <path d="M50 18c8 14-2 20 4 27 4 5 11 2 11-6 8 9 10 20 6 29-5 11-17 16-25 15-12-1-22-11-22-24 0-15 13-21 17-30 3-6 4-9 3-15 3 1 5 2 6 4z" />
      );
    case 'bolt':
      return <path d="M56 16 L30 55 L47 55 L42 84 L70 43 L52 43 Z" />;
    case 'crown':
      return <path d="M22 66 L28 34 L40 50 L50 28 L60 50 L72 34 L78 66 Z M22 70 h56 v8 h-56 Z" />;
    case 'shield':
      return <path d="M50 18 L80 28 v26c0 16-13 26-30 32-17-6-30-16-30-32V28z" />;
    case 'anchor':
      return (
        <path d="M46 22h8v10h10v8H54v28c9-2 15-8 16-16h8c-1 16-12 26-28 28-16-2-27-12-28-28h8c1 8 7 14 16 16V40H36v-8h10z" />
      );
    case 'diamond':
      return <path d="M50 16 L84 50 L50 84 L16 50 Z M50 30 L30 50 L50 70 L70 50 Z" />;
    case 'claw':
      return (
        <path d="M28 20c6 12 8 26 6 40l8 4c-1-16 1-30 6-42l8 2c-5 13-6 27-4 42l9 2c0-15 3-28 9-39l7 5c-7 13-9 27-7 42-6 9-16 14-26 12S25 78 24 66c-1-16 1-32 4-46z" />
      );
    case 'wing':
      return <path d="M14 56c14-16 32-24 52-24 8 0 14 2 20 6-10 2-18 6-24 12 6 0 11 1 15 4-10 2-18 6-24 12 5 1 9 2 12 4-14 6-30 5-51-14z" />;
    case 'gear':
      return (
        <path d="M50 22l6 8 10-3 2 10 10 3-5 9 7 8-9 5 1 10-10-1-5 9-8-7-8 7-5-9-10 1 1-10-9-5 7-8-5-9 10-3 2-10 10 3z M50 40a10 10 0 100 20 10 10 0 000-20z" />
      );
    case 'wave':
      return (
        <path d="M14 44c9-9 18-9 27 0s18 9 27 0 12-7 18-2v12c-6-5-9-7-18 2s-18 9-27 0-18-9-27 0z M14 66c9-9 18-9 27 0s18 9 27 0 12-7 18-2v10c-6-5-9-7-18 2s-18 9-27 0-18-9-27 0z" />
      );
    case 'peak':
      return <path d="M14 78 L38 34 L52 56 L62 40 L86 78 Z" />;
    default:
      // 기본: 야구공 실밥
      return (
        <>
          <circle cx="50" cy="50" r="26" />
          <path
            d="M34 30c8 12 8 28 0 40M66 30c-8 12-8 28 0 40"
            fill="none"
            stroke="#b91c1c"
            strokeWidth="3"
          />
        </>
      );
  }
}
