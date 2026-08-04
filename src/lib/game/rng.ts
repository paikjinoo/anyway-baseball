/**
 * 결정론적 난수 생성기 (mulberry32).
 *
 * 온라인 대전에서 호스트와 게스트가 같은 시드로 같은 결과를 재현할 수 있어야 하므로
 * Math.random()은 게임 로직에서 절대 쓰지 않는다. 상태(32비트 정수)는 GameState에
 * 그대로 실려 다니며, 매 투구마다 갱신된다.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  get state(): number {
    return this.s >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [min, max] 정수 */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** 확률 p로 true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 평균 0, 표준편차 1의 정규분포 (Box-Muller) */
  gauss(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 평균 mu, 표준편차 sigma의 정규분포. ±clamp 시그마로 자른다. */
  normal(mu: number, sigma: number, clampSigma = 3): number {
    const g = Math.max(-clampSigma, Math.min(clampSigma, this.gauss()));
    return mu + g * sigma;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/** 문자열을 32비트 시드로 (cyrb53 단순화) */
export function seedFromString(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)) >>> 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0~99 능력치를 0~1 비율로. 50이 평균. */
export function norm(stat: number): number {
  return clamp(stat, 0, 99) / 99;
}
