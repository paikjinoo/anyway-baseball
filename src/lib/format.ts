/**
 * 야구식 소수 표기. 0.276 -> ".276", 1.000 -> "1.000"
 * 단순히 slice(1)만 하면 1.000이 ".000"이 되어 완봉/전승이 0으로 보인다.
 */
export function baseballRate(value: number | null | undefined, fallback = '-'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  const s = value.toFixed(3);
  return value < 1 && s.startsWith('0') ? s.slice(1) : s;
}

/** 방어율 등 소수 2자리 */
export function toFixed2(value: number | null | undefined, fallback = '-'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  return value.toFixed(2);
}
