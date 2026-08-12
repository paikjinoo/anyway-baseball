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

/** 코스별 약점 히트맵에서 색이 완전히 차갑거나 뜨거워지는 타율 */
const HEAT_COLD_RATE = 0.15;
const HEAT_HOT_RATE = 0.35;

/**
 * 코스별 타율 -> 히트맵 색. 파랑(못 침) → 붉은 주황(잘 침).
 *
 * 선수단 화면과 경기 중 오버레이가 **같은 색 눈금**을 써야 한다. 따로 두면 같은 칸이
 * 두 화면에서 다른 색으로 보여, 보는 사람이 둘 중 어느 쪽을 믿어야 할지 알 수 없다.
 * 다만 진하기는 다르다 — 경기 중에는 조준선과 존 테두리 위에 얹히므로 훨씬 옅어야 한다.
 *
 * @param rate 축소추정된 코스 타율 (원시 타율을 그대로 넣으면 표본 적은 칸이 타오른다)
 * @param strength 최대 불투명도 배율. 1이 선수단 화면, 0.35 언저리가 경기 중 오버레이.
 */
export function zoneHeatColor(rate: number, strength = 1): string {
  const t = Math.max(0, Math.min(1, (rate - HEAT_COLD_RATE) / (HEAT_HOT_RATE - HEAT_COLD_RATE)));
  const cold = [70, 130, 220];
  const hot = [235, 90, 65];
  const [r, g, b] = cold.map((v, i) => Math.round(v + (hot[i] - v) * t));
  // 한가운데(평범한 칸)는 옅게, 양 끝(약점·강점)은 진하게. 눈이 극단부터 잡는다.
  const alpha = (0.14 + 0.44 * Math.abs(t - 0.5) * 2) * strength;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
