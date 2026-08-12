import { Rng } from './rng';
import { ROTATION_SIZE, freeJerseyNumber, generatePlayer, snapshotBase } from './generator';
import {
  TIER_COLOR,
  TIER_KO,
  TIER_MAX_LEVEL,
  TIER_ORDER,
  TP_PER_LEVEL,
  naturalTierGold,
  naturalTrainingPoints,
} from './progression';
import { autoInvest } from './training';
import { LINEUP_SIZE, battersOf, pitchersOf } from './roster';
import type { BatterPosition, Player, PlayerKind, Team, Tier } from './types';

/**
 * 상점. 골드로 선수를 영입하고(뽑기), 선수를 내보내 골드를 회수한다(방출).
 *
 * 이 게임에서 티어는 능력치를 주지 않는다 — 최대 레벨·능력치 상한·구종 슬롯만 넓힌다
 * (progression 헤더 참고). 그래서 "그 티어 1레벨 수준의 능력치"라는 기준이 따로 없었고,
 * 여기서 **자연 성장 등가**로 정의한다: 그 티어의 1레벨까지 직접 키웠다면 받았을 훈련
 * 포인트를 실제 훈련 곡선으로 미리 써 준 상태. 덕분에 뽑은 선수와 키운 선수가 어긋나지 않는다.
 *
 * 상위 티어의 진짜 차별점은 능력치 총량이 아니라 **잠재력**이다. 창단 선수의 잠재력은 평균
 * 82라 C부터 갈아 올려도 S 상한을 다 쓰지 못한다. 뽑기로 나온 S는 96 근처라 그 천장에 닿는다.
 */

// ---------------------------------------------------------------------------
// 배너
// ---------------------------------------------------------------------------

export type BannerId = 'NORMAL' | 'PREMIUM';

export interface Banner {
  id: BannerId;
  ko: string;
  desc: string;
  gold: number;
  /**
   * 티어 확률. 합은 정확히 1이어야 한다.
   *
   * 배열인 이유: 추첨이 이 순서대로 누적한다. 객체 키 순서에 기대면 나중에 표를 재배치하는
   * 것만으로 같은 시드가 다른 등급을 내놓는다. 화면도 같은 배열을 그대로 나열하므로
   * 표시 확률과 실제 확률이 갈라질 수 없다.
   */
  rates: { tier: Tier; rate: number }[];
  /** 배너 강조색 */
  accent: string;
}

export const BANNERS: Record<BannerId, Banner> = {
  NORMAL: {
    id: 'NORMAL',
    ko: '일반 뽑기',
    desc: 'C~A등급 선수를 한 명 영입합니다. 등급이 낮아도 잠재력은 최대 99까지 나올 수 있습니다.',
    gold: 5_000,
    rates: [
      { tier: 'C', rate: 0.5 },
      { tier: 'B', rate: 0.4 },
      { tier: 'A', rate: 0.1 },
    ],
    accent: TIER_COLOR.B,
  },
  PREMIUM: {
    id: 'PREMIUM',
    ko: '프리미엄 뽑기',
    desc: 'B~S등급 선수를 한 명 영입합니다. 상위 등급일수록 잠재력과 구종 슬롯이 함께 올라갑니다.',
    gold: 45_000,
    rates: [
      { tier: 'B', rate: 0.5 },
      { tier: 'A', rate: 0.4 },
      { tier: 'S', rate: 0.1 },
    ],
    accent: TIER_COLOR.S,
  },
};

/** 화면에 나열하는 순서 */
export const BANNER_ORDER: BannerId[] = ['NORMAL', 'PREMIUM'];

/**
 * 배너 확률표에서 티어 하나를 뽑는다.
 *
 * rng.next()를 **정확히 한 번, 뽑기의 가장 첫 소비로** 쓴다. 그래야 나온 등급이 로스터
 * 상태와 무관하게 시드만으로 정해지고, 확률 검증과 재현이 성립한다.
 */
export function rollTier(rng: Rng, banner: Banner): Tier {
  const roll = rng.next();
  let acc = 0;
  for (const { tier, rate } of banner.rates) {
    acc += rate;
    if (roll < acc) return tier;
  }
  // 0.5 + 0.4 + 0.1이 1에 미세하게 못 미쳐 흘러나온 경우의 안전망
  return banner.rates[banner.rates.length - 1].tier;
}

// ---------------------------------------------------------------------------
// 선수 생성
// ---------------------------------------------------------------------------

/**
 * 타자 뽑기의 포지션 분포. 창단 로스터(generator.ROSTER_PLAN)의 야수 구성과 같은 비율이라
 * 뽑기로 팀을 불려도 포지션이 한쪽으로 쏠리지 않는다. 포지션은 선수단 화면에서 바꿀 수 있으므로
 * 실질적으로는 '어떤 가중치로 능력치가 배분되는가'를 정하는 값이다.
 */
const DRAW_BATTER_POSITIONS: BatterPosition[] = [
  'C', 'C', '1B', '1B', '2B', '3B', 'SS', 'SS', 'LF', 'CF', 'CF', 'RF', 'DH',
];

export interface DrawnPlayerOptions {
  tier: Tier;
  kind: PlayerKind;
  number: number;
  teamColor?: string;
  accentColor?: string;
}

/**
 * 티어가 정해진 뒤의 선수 생성. 테스트와 미리보기에서 단독으로 쓴다.
 *
 * 투수는 **선발 기준으로 만든 뒤 중간계투로 등록한다.** 능력치는 선발급(긴 스태미나, 꽉 찬
 * 구종)이어야 값어치가 있지만, 역할까지 선발로 넣으면 선발이 5명이 되어 roster.rosterIssues가
 * 즉시 경기 편성을 막는다. 선발로 올리는 건 사용자가 기존 선발을 내리고 직접 할 일이다.
 */
export function createDrawnPlayer(rng: Rng, opt: DrawnPlayerOptions): Player {
  const isPitcher = opt.kind === 'PITCHER';

  let p = generatePlayer(rng, {
    position: isPitcher ? 'P' : rng.pick(DRAW_BATTER_POSITIONS),
    role: isPitcher ? 'SP' : undefined,
    number: opt.number,
    teamColor: opt.teamColor,
    accentColor: opt.accentColor,
    tier: opt.tier,
  });

  // 티어 구간별로 나눠 투자한다. 자연 성장은 C 상한 65 → B 78 → A 89를 차례로 겪으므로,
  // 한 번에 최종 상한으로 투자하면 C 구간에서 막혔어야 할 능력치가 안 막힌 채 자란다.
  let spent = 0;
  for (const t of TIER_ORDER) {
    if (t === opt.tier) break;
    const seg = autoInvest({ ...p, tier: t }, (TIER_MAX_LEVEL[t] - 1) * TP_PER_LEVEL[t]);
    spent += seg.spent;
    p = seg.player;
  }

  const drawn: Player = {
    ...p,
    tier: opt.tier,
    level: 1,
    exp: 0,
    // 자투리는 그대로 넘겨 준다. spent + trainingPoints가 그 티어의 자연 누적 TP와 정확히 같아진다.
    trainingPoints: naturalTrainingPoints(opt.tier) - spent,
    // 뽑은 선수의 능력치는 훈련 결과가 아니라 타고난 것이다. 훈련 포인트를 쓴 적이 없으므로
    // spentPoints는 0이고, base는 지금 이 상태를 찍는다 — 능력치초기화권이 여기로 되돌린다.
    spentPoints: 0,
    spentGold: 0,
  };
  if (isPitcher) drawn.role = 'RP';
  drawn.base = snapshotBase(drawn);

  return drawn;
}

// ---------------------------------------------------------------------------
// 영입 (뽑기)
// ---------------------------------------------------------------------------

export type DrawResult =
  | { ok: true; team: Team; message: string; player: Player; tier: Tier }
  | { ok: false; team: Team; message: string; player?: undefined; tier?: undefined };

/** 지금 이 배너를 돌릴 수 없는 이유. 없으면 null. 화면은 이 문자열을 그대로 보여 준다. */
export function drawIssue(team: Team, bannerId: BannerId): string | null {
  const banner = BANNERS[bannerId];
  if (!banner) return '알 수 없는 뽑기입니다.';
  if (team.gold < banner.gold) {
    return `골드가 부족합니다. (필요: ${banner.gold.toLocaleString()}G)`;
  }
  return null;
}

/** 뽑기 1회. 검증 → 티어 추첨 → 선수 생성 → 로스터 편입. */
export function drawPlayer(
  team: Team,
  bannerId: BannerId,
  kind: PlayerKind,
  seed: number,
): DrawResult {
  const banner = BANNERS[bannerId];
  const issue = drawIssue(team, bannerId);
  if (issue) return { ok: false, team, message: issue };

  const rng = new Rng(seed >>> 0);
  const tier = rollTier(rng, banner);
  const number = freeJerseyNumber(team, rng);
  let player = createDrawnPlayer(rng, {
    tier,
    kind,
    number,
    teamColor: team.primaryColor,
    accentColor: team.accentColor,
  });

  // 시드에 Date.now()가 들어가므로 같은 밀리초에 두 번 누르면 id까지 똑같은 선수가 나온다.
  // id가 겹치면 팀 안의 map(id 일치) 갱신이 두 명을 동시에 건드린다.
  const used = new Set(team.players.map((x) => x.id));
  for (let guard = 0; used.has(player.id) && guard < 8; guard++) {
    player = {
      ...player,
      id: `p_${rng.int(0, 0xffffff).toString(36)}${rng.int(0, 0xffffff).toString(36)}`,
    };
  }

  return {
    ok: true,
    tier,
    player,
    team: {
      ...team,
      gold: team.gold - banner.gold,
      // 타순과 로테이션은 손대지 않는다. 새로 온 선수가 말없이 주전을 밀어내면 안 된다.
      players: [...team.players, player],
    },
    message: `${TIER_KO[tier]} ${player.name} 영입! (${banner.gold.toLocaleString()}G 사용)`,
  };
}

// ---------------------------------------------------------------------------
// 방출
// ---------------------------------------------------------------------------

export const RELEASE_BASE_GOLD = 200;

/** 그 티어까지 쌓인 강화 골드 중 돌려주는 비율 */
export const RELEASE_REFUND_RATE = 0.4;

/**
 * 레벨 1당 추가 환급. 레벨은 골드가 아니라 시간으로 사는 것이라 값을 작게 매긴다 —
 * 크게 매기면 "키워서 파는" 것이 경기를 뛰는 것보다 이득이 되어 버린다.
 */
export const RELEASE_PER_LEVEL: Record<Tier, number> = { C: 10, B: 25, A: 60, S: 120 };

/** 방출 후에도 남아 있어야 하는 최소 인원 */
export const MIN_BATTERS = LINEUP_SIZE;
export const MIN_PITCHERS = ROTATION_SIZE + 2;

/**
 * 방출 환급액.
 *
 * 어떤 배너에서 무엇이 나오든 **즉시 되팔면 반드시 손해**여야 한다. 기댓값이 아니라 티어별
 * 최댓값으로 성립해야 운 좋은 뽑기를 되파는 전략이 생기지 않는다.
 * (일반 최대 A Lv.1 4,200 < 5,000 · 프리미엄 최대 S Lv.1 14,200 < 45,000)
 *
 * 구종 습득에 쓴 골드(spentGold)는 돌려주지 않는다. 화면에 그렇게 적는다.
 */
export function releaseValue(player: Player): number {
  return Math.round(
    RELEASE_BASE_GOLD +
      naturalTierGold(player.tier) * RELEASE_REFUND_RATE +
      RELEASE_PER_LEVEL[player.tier] * Math.max(0, player.level - 1),
  );
}

/** 방출할 수 없는 이유. 가능하면 null. 화면은 이 문자열을 그대로 보여 준다. */
export function releaseIssue(team: Team, playerId: string): string | null {
  const p = team.players.find((x) => x.id === playerId);
  if (!p) return '선수를 찾을 수 없습니다.';
  if (team.lineup.includes(playerId)) {
    return '타순에 등록된 선수입니다. 먼저 타순에서 빼세요.';
  }
  if (team.rotation.includes(playerId)) {
    return '선발 로테이션에 등록된 선수입니다. 먼저 로테이션에서 빼세요.';
  }

  if (p.kind === 'PITCHER') {
    // 선발은 정확히 ROTATION_SIZE명이어야 한다(roster.rosterIssues). 하나만 빠져도 경기 편성 불가다.
    if (p.role === 'SP') return '선발 투수는 방출할 수 없습니다. 먼저 중간계투로 내리세요.';
    if (pitchersOf(team).length <= MIN_PITCHERS) {
      return `투수는 최소 ${MIN_PITCHERS}명이 필요합니다 (선발 ${ROTATION_SIZE} + 불펜 2).`;
    }
    // 부상자를 빼고 세지 않는다 — 부상이 겹쳤을 때, 즉 정리하고 싶은 바로 그 순간에 잠긴다.
  } else if (battersOf(team).length <= MIN_BATTERS) {
    return `타자는 최소 ${MIN_BATTERS}명이 필요합니다 (타순 ${LINEUP_SIZE}명).`;
  }

  return null;
}

export interface ReleaseResult {
  ok: boolean;
  team: Team;
  message: string;
  /** 실제로 환급된 골드. 실패하면 0. */
  gold: number;
}

/** 선수를 방출하고 골드를 환급한다. 되돌릴 수 없다. */
export function releasePlayer(team: Team, playerId: string): ReleaseResult {
  const issue = releaseIssue(team, playerId);
  if (issue) return { ok: false, team, message: issue, gold: 0 };

  const player = team.players.find((x) => x.id === playerId)!;
  const gold = releaseValue(player);

  return {
    ok: true,
    gold,
    // 타순·로테이션에 든 선수는 위에서 걸러졌으므로 두 배열은 그대로 유효하다.
    team: {
      ...team,
      gold: team.gold + gold,
      players: team.players.filter((x) => x.id !== playerId),
    },
    message: `${player.name} 방출 · ${gold.toLocaleString()}G 환급`,
  };
}
