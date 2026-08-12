'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { saveTeam } from '@/lib/firebase/store';
import { TierBadge } from '@/components/ui/TierBadge';
import { BODY_BY_ID, POSITION_KO } from '@/lib/game/constants';
import { playerScore } from '@/lib/game/generator';
import { arsenalOf } from '@/lib/game/pitching';
import {
  TIER_COLOR,
  TIER_KO,
  TIER_MAX_LEVEL,
  pitchSlots,
  pitchSlotsUsed,
  statCap,
} from '@/lib/game/progression';
import { ROLE_KO } from '@/lib/game/roster';
import { seedFromString } from '@/lib/game/rng';
import {
  BANNERS,
  BANNER_ORDER,
  drawIssue,
  drawPlayer,
  releaseIssue,
  releasePlayer,
  releaseValue,
} from '@/lib/game/shop';
import { BATTING_KEYS, BATTING_KEY_KO } from '@/lib/game/training';
import {
  playBatCrack,
  playCheer,
  playClick,
  playHomeRunCelebration,
} from '@/lib/audio/sfx';
import type { BannerId } from '@/lib/game/shop';
import type { Player, PlayerKind, Team, Tier } from '@/lib/game/types';

type Tab = 'gacha' | 'release';
type Msg = { text: string; ok: boolean };

/**
 * 상점.
 *
 * 골드를 쓰는 화면이라 규칙이 두 가지 있다.
 *   - 확률은 반드시 BANNERS의 값을 그대로 보여 준다. 화면에 따로 적어 두면 언젠가 실제
 *     확률과 갈라지고, 그 순간 이 화면은 거짓말이 된다.
 *   - 골드 차감은 연출 **전에** 확정한다. 연출은 이미 끝난 결과 위의 연극일 뿐이라,
 *     도중에 창을 닫아도 구매가 사라지거나 다시 굴릴 수 있으면 안 된다.
 */
export default function ShopPage() {
  const team = useActiveTeam();
  const authReady = useAppStore((s) => s.authReady);
  const dataReady = useAppStore((s) => s.dataReady);
  const upsertTeam = useAppStore((s) => s.upsertTeam);

  const [tab, setTab] = useState<Tab>('gacha');
  const [msg, setMsg] = useState<Msg | null>(null);

  async function commit(next: Team, message?: string) {
    upsertTeam(next);
    await saveTeam(next);
    if (message) setMsg({ text: message, ok: true });
  }

  if (!authReady || !dataReady) {
    return (
      <div className="loading-state" aria-live="polite">
        <div className="loading-mark">A/B</div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <p className="mb-1 font-bold">아직 팀이 없습니다</p>
        <p className="mb-4 text-sm text-slate-400">
          상점은 팀 골드로 선수를 사고파는 곳입니다. 먼저 팀을 창단하세요.
        </p>
        <Link href="/team" className="btn btn-primary">
          팀 창단하러 가기
        </Link>
      </div>
    );
  }

  return (
    <div className="shop-page">
      <section className="shop-hero" aria-labelledby="shop-title">
        <div className="shop-hero-copy">
          <span className="shop-eyebrow">FRONT OFFICE · SCOUTING</span>
          <h1 id="shop-title">스카우트 마켓</h1>
          <p>
            다음 시즌의 판도를 바꿀 한 명을 찾으세요. 포지션을 선택하고 스카우팅 패키지를
            열면 선수 리포트가 공개됩니다.
          </p>
        </div>
        <dl className="shop-ledger" aria-label="구단 자산 현황">
          <div>
            <dt>AVAILABLE FUNDS</dt>
            <dd className="tabular">{team.gold.toLocaleString()} G</dd>
          </div>
          <div>
            <dt>ACTIVE ROSTER</dt>
            <dd className="tabular">{team.players.length} PLAYERS</dd>
          </div>
        </dl>
      </section>

      <div className="shop-tabs" role="tablist" aria-label="상점 메뉴">
        {(
          [
            ['gacha', '선수 영입', 'SCOUT MARKET'],
            ['release', '선수 방출', 'TRANSFER DESK'],
          ] as const
        ).map(([k, label, sub]) => (
          <button
            key={k}
            role="tab"
            onClick={() => {
              setTab(k);
              setMsg(null);
            }}
            aria-selected={tab === k}
            className={tab === k ? 'is-active' : ''}
          >
            <span>{label}</span>
            <small>{sub}</small>
          </button>
        ))}
      </div>

      {msg && (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-xl border px-4 py-2 text-sm ${
            msg.ok
              ? 'border-lime-500/30 bg-lime-500/10 text-lime-200'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {msg.text}
        </div>
      )}

      <div role="tabpanel" aria-label={tab === 'gacha' ? '선수 영입' : '선수 방출'}>
        {tab === 'gacha' && <GachaTab team={team} onCommit={commit} onMessage={setMsg} />}
        {tab === 'release' && <ReleaseTab team={team} onCommit={commit} onMessage={setMsg} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 뽑기
// ---------------------------------------------------------------------------

/**
 * 뽑기 진행 단계.
 *
 * 판별 유니온인 이유: 뽑힌 선수는 REVEAL부터만 존재한다. `phase: string + drawn: Player | null`로
 * 두면 "RESULT인데 drawn이 null"인 상태가 타입상 표현 가능해지고, 언젠가 실제로 그렇게 된다.
 */
type Phase =
  | { step: 'IDLE' }
  | { step: 'CONFIRM'; banner: BannerId }
  | { step: 'REVEAL'; banner: BannerId; player: Player }
  | { step: 'RESULT'; banner: BannerId; player: Player };

/** 등급별 연출 길이. 후광은 항상 700ms에 뜨고, 그 뒤로 버티는 시간이 등급이다. */
const HOLD_MS: Record<Tier, number> = { C: 1050, B: 1050, A: 1700, S: 2400 };
const CRACK: Record<Tier, number> = { C: 0.45, B: 0.6, A: 0.9, S: 1.0 };

function GachaTab({
  team,
  onCommit,
  onMessage,
}: {
  team: Team;
  onCommit: (next: Team, msg?: string) => Promise<void>;
  onMessage: (m: Msg) => void;
}) {
  // 뽑는 종류는 Phase 밖에 둔다 — 연속으로 돌릴 때 매번 다시 묻지 않는다.
  const [kind, setKind] = useState<PlayerKind>('BATTER');
  const [phase, setPhase] = useState<Phase>({ step: 'IDLE' });
  const busy = useRef(false);
  const openerRef = useRef<Record<string, HTMLButtonElement | null>>({});

  function startDraw(bannerId: BannerId) {
    // 같은 틱에 두 번 들어오면 둘 다 차감 전 골드를 읽어 이중 결제가 된다.
    if (busy.current) return;
    busy.current = true;
    playClick();

    // 시드에 로스터 상태를 섞는다 — Date.now()만 쓰면 같은 밀리초의 두 번째 클릭이
    // 첫 번째와 완전히 같은 선수를 만든다.
    const seed = seedFromString(`${team.id}-${team.players.length}-${Date.now()}`);
    const r = drawPlayer(team, bannerId, kind, seed);
    if (!r.ok) {
      onMessage({ text: r.message, ok: false });
      setPhase({ step: 'IDLE' });
      busy.current = false;
      return;
    }

    setPhase({ step: 'REVEAL', banner: bannerId, player: r.player });
    void onCommit(r.team).finally(() => {
      busy.current = false;
    });
  }

  return (
    <div className="shop-gacha">
      <section className="scout-briefing">
        <div className="scout-briefing-copy">
          <span className="shop-section-kicker">RECRUITMENT BRIEF</span>
          <h2>영입할 선수 유형</h2>
          <p>영입 포지션을 먼저 지정하면 두 패키지 모두 같은 조건으로 선수를 탐색합니다.</p>
        </div>
        <div className="shop-role-picker" role="group" aria-label="영입 선수 유형">
          {(
            [
              ['BATTER', '타자', 'BATTER'],
              ['PITCHER', '투수', 'PITCHER'],
            ] as const
          ).map(([k, label, sub]) => (
            <button
              key={k}
              onClick={() => {
                playClick();
                setKind(k);
              }}
              aria-pressed={kind === k}
              className={kind === k ? 'is-active' : ''}
            >
              <span>{label}</span>
              <small>{sub}</small>
            </button>
          ))}
        </div>
        <p className="scout-briefing-note">
          투수·타자 구분은 영입한 뒤에는 바꿀 수 없습니다. 영입한 투수는 중간계투로 들어오며,
          선발로 올리려면 선수단에서 기존 선발을 먼저 내려야 합니다.
        </p>
      </section>

      <div className="scout-package-grid">
        {BANNER_ORDER.map((id) => {
          const def = BANNERS[id];
          const issue = drawIssue(team, id);
          const short = def.gold - team.gold;
          const premium = id === 'PREMIUM';
          const packageStyle = {
            '--package': def.accent,
            '--package-soft': def.accent + '1f',
            '--package-line': def.accent + '66',
          } as React.CSSProperties;
          return (
            <section
              key={id}
              className={`scout-package ${premium ? 'scout-package-premium' : 'scout-package-normal'} ${
                issue ? 'is-unavailable' : ''
              }`}
              style={packageStyle}
            >
              <div className="scout-package-topline">
                <span>{premium ? 'ELITE ACCESS' : 'OPEN SCOUTING'}</span>
                <span>{premium ? 'S TIER AVAILABLE' : 'C · B · A POOL'}</span>
              </div>

              <div className="scout-package-heading">
                <div>
                  <span className="scout-package-index">{premium ? '02' : '01'}</span>
                  <h2>{premium ? '프리미엄 스카우팅' : '프로 스카우팅'}</h2>
                  <p>{def.ko}</p>
                </div>
                <div className="scout-package-seal" aria-hidden>
                  <span>A/B</span>
                </div>
              </div>

              <p className="scout-package-description">{def.desc}</p>

              <RateTable id={id} />

              <div className="scout-package-purchase">
                <div>
                  <span>CONTRACT FEE</span>
                  <strong className="tabular">{def.gold.toLocaleString()} G</strong>
                </div>
                <button
                  ref={(el) => {
                    openerRef.current[id] = el;
                  }}
                  className={`btn ${premium ? 'btn-warn' : 'btn-primary'}`}
                  disabled={!!issue}
                  onClick={() => {
                    playClick();
                    setPhase({ step: 'CONFIRM', banner: id });
                  }}
                >
                  {issue ? '골드가 부족합니다' : `${kind === 'PITCHER' ? '투수' : '타자'} 리포트 열기`}
                </button>
              </div>
              {issue && (
                <p className="scout-package-shortage tabular">
                  {short.toLocaleString()}G 더 필요합니다
                </p>
              )}
            </section>
          );
        })}
      </div>

      <p className="shop-funding-note">
        <span>CLUB FINANCE</span>
        골드는 경기 보상과 리그 순위 보상, 선수 방출로 모을 수 있습니다.{' '}
        <Link href="/play" className="text-lime-300 underline">
          경기 일정으로 이동 ›
        </Link>
      </p>

      {phase.step === 'CONFIRM' && (
        <ConfirmDialog
          team={team}
          banner={phase.banner}
          kind={kind}
          onCancel={() => {
            setPhase({ step: 'IDLE' });
            openerRef.current[phase.banner]?.focus();
          }}
          onConfirm={() => startDraw(phase.banner)}
        />
      )}

      {(phase.step === 'REVEAL' || phase.step === 'RESULT') && (
        <RevealOverlay
          team={team}
          phase={phase}
          onRevealed={() => setPhase({ ...phase, step: 'RESULT' })}
          onClose={() => {
            setPhase({ step: 'IDLE' });
            openerRef.current[phase.banner]?.focus();
          }}
          onAgain={() => setPhase({ step: 'CONFIRM', banner: phase.banner })}
        />
      )}
    </div>
  );
}

/** 확률표. 반드시 BANNERS의 값을 그대로 읽는다. */
function RateTable({ id }: { id: BannerId }) {
  const def = BANNERS[id];
  return (
    <div className="scout-rates">
      <div className="scout-rates-heading">
        <span>등급별 영입 확률</span>
        <span>ODDS</span>
      </div>
      <ul>
        {def.rates.map(({ tier, rate }) => (
          <li key={tier} aria-label={`${TIER_KO[tier]} 영입 확률 ${Math.round(rate * 100)}퍼센트`}>
            <span className="scout-rate-tier" style={{ color: TIER_COLOR[tier] }}>
              {tier}
              <small>{TIER_KO[tier]}</small>
            </span>
            <span className="scout-rate-track" aria-hidden>
              <span
                className="scout-rate-fill"
                style={{ width: `${rate * 100}%`, background: TIER_COLOR[tier] }}
              />
            </span>
            <span className="scout-rate-value tabular">
              {Math.round(rate * 100)}%
            </span>
          </li>
        ))}
      </ul>
      <p className="scout-rate-disclosure">
        각 영입은 독립 시행이며, 누적 시도 횟수에 따라 상위 등급 확률이 오르지 않습니다.
      </p>
    </div>
  );
}

function ConfirmDialog({
  team,
  banner,
  kind,
  onCancel,
  onConfirm,
}: {
  team: Team;
  banner: BannerId;
  kind: PlayerKind;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const def = BANNERS[banner];
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="shop-dialog-backdrop" onClick={onCancel}>
      <div
        className="shop-confirm pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="shop-section-kicker">FINAL AUTHORIZATION</span>
        <h2 id="shop-confirm-title">영입을 승인할까요?</h2>
        <p className="shop-confirm-summary">
          <b style={{ color: def.accent }}>{def.ko}</b> · {kind === 'PITCHER' ? '투수' : '타자'} 1명
        </p>

        <div className="shop-confirm-rates">
          <RateTable id={banner} />
        </div>

        <dl className="shop-confirm-balance tabular">
          <div>
            <dt>현재 보유</dt>
            <dd>{team.gold.toLocaleString()} G</dd>
          </div>
          <div>
            <dt>계약 비용</dt>
            <dd>- {def.gold.toLocaleString()} G</dd>
          </div>
          <div>
            <dt>계약 후 잔액</dt>
            <dd>{(team.gold - def.gold).toLocaleString()} G</dd>
          </div>
        </dl>

        <div className="shop-confirm-actions">
          <button className="btn flex-1" onClick={onCancel}>
            취소
          </button>
          <button ref={confirmRef} className="btn btn-primary flex-1" onClick={onConfirm}>
            영입 승인
          </button>
        </div>
      </div>
    </div>
  );
}

function RevealOverlay({
  team,
  phase,
  onRevealed,
  onClose,
  onAgain,
}: {
  team: Team;
  phase: Extract<Phase, { step: 'REVEAL' | 'RESULT' }>;
  onRevealed: () => void;
  onClose: () => void;
  onAgain: () => void;
}) {
  const revealing = phase.step === 'REVEAL';
  const tier = phase.player.tier;
  const hold = HOLD_MS[tier];
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const [show3d, setShow3d] = useState(false);

  // 카드는 스냅샷이 아니라 스토어에서 다시 읽는다 — 뒤늦은 갱신이 있어도 낡은 값이 남지 않는다.
  const shown = team.players.find((p) => p.id === phase.player.id) ?? phase.player;

  const finish = useMemo(
    () => (skipped: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      playBatCrack(CRACK[tier]);
      // 건너뛸 때는 관중 환호를 생략한다. 연속으로 돌리면 4초짜리 팡파르가 겹쳐 쌓인다.
      if (!skipped) {
        if (tier === 'S') playHomeRunCelebration();
        else if (tier === 'A') playCheer(0.8, 2.0);
        else if (tier === 'B') playCheer(0.5, 1.2);
      }
      onRevealed();
    },
    [tier, onRevealed],
  );

  useEffect(() => {
    if (!revealing) return;
    // 감속 모션에서 CSS는 전역 규칙이 죽이지만 JS 타이머는 그대로 남아 빈 화면을 붙잡는다.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timer.current = setTimeout(() => finish(false), reduced ? 0 : hold);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [revealing, hold, finish]);

  useEffect(() => {
    if (revealing) return;
    okRef.current?.focus();
  }, [revealing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (revealing) finish(true);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealing, finish, onClose]);

  const style = {
    '--hold': `${hold}ms`,
    '--tier': TIER_COLOR[tier],
    '--tier-glow': TIER_COLOR[tier] + '66',
  } as React.CSSProperties;

  const banner = BANNERS[phase.banner];
  const isP = shown.kind === 'PITCHER';
  const affordable = team.gold >= banner.gold;

  return (
    <div
      className="shop-reveal"
      style={style}
      onClick={() => (revealing ? finish(true) : onClose())}
      role={revealing ? undefined : 'dialog'}
      aria-modal={revealing ? undefined : true}
    >
      {/* 스크린리더에는 결과만 한 번 알린다. 연출 중에 또 갱신하면 첫 안내가 씹힌다. */}
      <div className="sr-only" role="status" aria-live="polite">
        {!revealing
          ? `${TIER_KO[tier]} ${isP ? '투수' : '타자'} ${shown.name} 영입. 종합 ${playerScore(
              shown,
            )}, 잠재력 ${shown.potential}. 남은 골드 ${team.gold.toLocaleString()}골드.`
          : ''}
      </div>

      {revealing ? (
        <div className="shop-reveal-stage">
          <div className="inning-break-kicker">LIVE SCOUT REPORT</div>
          <div className="shop-contract" aria-hidden>
            <span className="shop-contract-ring" />
            <span className="shop-contract-card">
              <i className="shop-contract-stripe" />
              <b>A/B</b>
              <i className="shop-contract-lines" />
            </span>
            <span className="shop-orb-halo" aria-hidden />
          </div>
          <h2 className="shop-reveal-title flash">선수 리포트 개봉 중</h2>
          <p className="shop-reveal-subtitle">계약 데이터와 메디컬 리포트를 확인하고 있습니다</p>
          <div className="inning-break-progress">
            <i style={{ animationDuration: `${hold}ms` }} />
          </div>
          <button className="inning-break-skip" onClick={() => finish(true)}>
            건너뛰기 ›
          </button>
        </div>
      ) : (
        <div
          className={`shop-result-card pop-in ${
            tier === 'S' ? 'shop-card-s' : ''
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {(tier === 'A' || tier === 'S') && <span className="shop-burst" aria-hidden />}

          <div className="shop-result-heading">
            <div>
              <div className="inning-break-kicker">SIGNING COMPLETE</div>
              <p>스카우팅 리포트가 구단에 등록되었습니다</p>
            </div>
            <div className="shop-result-tier" style={{ color: TIER_COLOR[tier] }}>
              <span>{TIER_KO[tier]}</span>
              {tier}
            </div>
          </div>

          <ResultCard player={shown} team={team} show3d={show3d} onToggle3d={() => setShow3d((v) => !v)} />

          <div className="mt-5 flex gap-2">
            <button ref={okRef} className="btn btn-primary flex-1" onClick={onClose}>
              확인
            </button>
            <button className="btn flex-1" disabled={!affordable} onClick={onAgain}>
              한 번 더 · {banner.gold.toLocaleString()}G
            </button>
          </div>
          <div className="mt-2 text-center">
            <Link href="/roster" className="text-[11px] text-lime-300 underline">
              선수단에서 보기 ›
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({
  player,
  team,
  show3d,
  onToggle3d,
}: {
  player: Player;
  team: Team;
  show3d: boolean;
  onToggle3d: () => void;
}) {
  const isP = player.kind === 'PITCHER';
  const cap = statCap(player);

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-3">
        <span
          className="grid h-14 w-14 shrink-0 place-items-center rounded-xl text-xl font-black"
          style={{ background: team.primaryColor, color: team.secondaryColor }}
        >
          {player.number}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <TierBadge player={player} />
            <span className="truncate text-2xl font-black">{player.name}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-400">
            {isP ? '투수' : '타자'} · {isP ? ROLE_KO[player.role ?? 'RP'] : POSITION_KO[player.position]}{' '}
            · 타석 {player.bats} / 투구 {player.throws}
          </div>
        </div>
      </div>

      {/* 상위 티어가 실제로 무엇을 산 것인지 — 능력치 숫자만 보면 값어치가 안 보인다. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="종합" value={playerScore(player)} />
        <Stat label="잠재력" value={player.potential} accent />
        <Stat label="최대 레벨" value={TIER_MAX_LEVEL[player.tier]} />
        {/* 구종 슬롯은 투수에게만 의미가 있다. 타자에게는 체형이 그 자리를 대신한다. */}
        {isP ? (
          <Stat label="구종" value={`${pitchSlotsUsed(player)} / ${pitchSlots(player)}`} />
        ) : (
          <Stat label="체형" value={BODY_BY_ID[player.body ?? 'NORMAL'].ko} />
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-slate-500">
        잠재력은 훈련으로 올릴 수 있는 이 선수만의 한계입니다. 실제 상한은{' '}
        <b className="text-slate-300">{cap}</b> ({TIER_KO[player.tier]} 상한{' '}
        {statCap({ ...player, potential: 99 })} · 잠재력 {player.potential} 중 낮은 쪽)입니다.
      </p>

      {show3d ? (
        <Preview3d player={player} team={team} />
      ) : isP ? (
        <div className="space-y-2">
          <MiniBar label="스태미나" value={player.pitching?.stamina ?? 0} />
          {arsenalOf(player).map(({ type, attr, def }) => (
            <div key={type} className="rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-[11px] font-bold"
                  style={{ background: def.color + '30', color: def.color }}
                >
                  {def.ko}
                </span>
                <span className="text-[11px] tabular text-slate-500">
                  {def.baseVelo + Math.round((def.veloRange * attr.velocity) / 99)}km/h
                </span>
              </div>
              <div className="mt-1 text-[11px] tabular text-slate-400">
                구속 {attr.velocity} · 제구 {attr.control} · 무브먼트 {attr.movement}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {BATTING_KEYS.map((k) => (
            <MiniBar key={k} label={BATTING_KEY_KO[k]} value={player.batting[k]} />
          ))}
        </div>
      )}

      <button className="btn w-full !py-1.5 !text-xs" onClick={onToggle3d}>
        {show3d ? '능력치 보기' : '3D로 보기'}
      </button>
    </div>
  );
}

/**
 * 결과 카드의 3D 미리보기.
 *
 * 연출 중에는 절대 띄우지 않는다 — WebGL 캔버스를 매 프레임 리렌더하므로, 뽑기를 연달아
 * 돌리면 컨텍스트를 그만큼 만들고 부순다. 셰이더 컴파일 지연도 정확히 한 방이 터져야 할
 * 순간에 구멍을 낸다. 사용자가 눌렀을 때만, 결과 화면에서만 마운트한다.
 */
function Preview3d({ player, team }: { player: Player; team: Team }) {
  const [Comp, setComp] = useState<React.ComponentType<{
    player: Player;
    uniform: {
      primary: string;
      secondary: string;
      accent: string;
      type: Team['uniformType'];
    };
    mode: 'BAT' | 'PITCH' | 'FIELD';
    height: number;
  }> | null>(null);

  useEffect(() => {
    let alive = true;
    void import('@/components/three/PlayerPreview').then((m) => {
      if (alive) setComp(() => m.PlayerPreview);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!Comp) {
    return <div className="grid h-[280px] place-items-center text-xs text-slate-500">불러오는 중…</div>;
  }
  return (
    <Comp
      key={player.id}
      player={player}
      uniform={{
        primary: team.primaryColor,
        secondary: team.secondaryColor,
        accent: team.accentColor,
        type: team.uniformType,
      }}
      mode={player.kind === 'PITCHER' ? 'PITCH' : 'BAT'}
      height={280}
    />
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-white/[0.04] px-3 py-2 text-center">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-xl font-black tabular ${accent ? 'text-amber-300' : 'text-slate-200'}`}>
        {value}
      </div>
    </div>
  );
}

/** 상점 전용 간이 스탯 막대. 훈련 화면의 Bar는 상한 눈금·체형 보정을 달고 있어 여기엔 과하다. */
function MiniBar({ label, value }: { label: string; value: number }) {
  const color =
    value >= 80 ? '#fb7185' : value >= 65 ? '#fbbf24' : value >= 50 ? '#38bdf8' : '#94a3b8';
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-slate-400">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.min(100, value)}%`, background: color }}
        />
      </span>
      <span className="w-7 text-right text-xs font-bold tabular text-slate-300">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 방출
// ---------------------------------------------------------------------------

type ReleaseSort = 'tier-asc' | 'tier-desc' | 'gold-desc' | 'number';
const TIER_RANK: Record<Tier, number> = { C: 0, B: 1, A: 2, S: 3 };

function ReleaseTab({
  team,
  onCommit,
  onMessage,
}: {
  team: Team;
  onCommit: (next: Team, msg?: string) => Promise<void>;
  onMessage: (m: Msg) => void;
}) {
  const [kindFilter, setKindFilter] = useState<'ALL' | PlayerKind>('ALL');
  const [sort, setSort] = useState<ReleaseSort>('tier-asc');
  const [hideBlocked, setHideBlocked] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // 확인을 켜 둔 채로 다른 선수를 고르고 확정하는 사고를 막는다.
  useEffect(() => setConfirming(false), [selectedId]);

  const rows = useMemo(() => {
    const list = team.players
      .filter((p) => kindFilter === 'ALL' || p.kind === kindFilter)
      .map((p) => ({ p, blocked: releaseIssue(team, p.id), gold: releaseValue(p) }))
      .filter((r) => !hideBlocked || !r.blocked);

    const cmp: Record<ReleaseSort, (a: typeof list[0], b: typeof list[0]) => number> = {
      'tier-asc': (a, b) =>
        TIER_RANK[a.p.tier] - TIER_RANK[b.p.tier] || a.p.level - b.p.level,
      'tier-desc': (a, b) =>
        TIER_RANK[b.p.tier] - TIER_RANK[a.p.tier] || b.p.level - a.p.level,
      'gold-desc': (a, b) => b.gold - a.gold,
      number: (a, b) => a.p.number - b.p.number,
    };
    return list.sort(cmp[sort]);
  }, [team, kindFilter, sort, hideBlocked]);

  const selected = rows.find((r) => r.p.id === selectedId) ?? null;

  function doRelease(playerId: string) {
    const r = releasePlayer(team, playerId);
    if (!r.ok) {
      onMessage({ text: r.message, ok: false });
      return;
    }
    playClick();
    setSelectedId(null);
    setConfirming(false);
    void onCommit(r.team, r.message);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="space-y-2">
        <div className="panel space-y-2 p-3">
          <div className="flex gap-1 rounded-lg bg-white/5 p-1">
            {(
              [
                ['ALL', '전체'],
                ['PITCHER', '투수'],
                ['BATTER', '타자'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                aria-pressed={kindFilter === k}
                className={`flex-1 rounded px-2 py-1 text-xs font-semibold transition ${
                  kindFilter === k ? 'bg-lime-500/25 text-lime-200' : 'text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            className="w-full rounded-lg bg-white/5 px-2 py-1.5 text-xs text-slate-300"
            value={sort}
            onChange={(e) => setSort(e.target.value as ReleaseSort)}
            aria-label="정렬 기준"
          >
            <option value="tier-asc">등급 낮은 순</option>
            <option value="tier-desc">등급 높은 순</option>
            <option value="gold-desc">환급액 높은 순</option>
            <option value="number">등번호 순</option>
          </select>
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={hideBlocked}
              onChange={(e) => setHideBlocked(e.target.checked)}
            />
            방출 불가 선수 숨기기
          </label>
        </div>

        <div className="panel max-h-[60vh] overflow-y-auto p-2">
          {rows.map(({ p, blocked, gold }) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition ${
                selectedId === p.id ? 'bg-lime-500/20' : 'hover:bg-white/5'
              } ${blocked ? 'opacity-60' : ''}`}
            >
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-xs font-black"
                style={{ background: team.primaryColor, color: team.secondaryColor }}
              >
                {p.number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <TierBadge player={p} />
                  <span className="truncate text-sm font-semibold">{p.name}</span>
                </span>
                {blocked ? (
                  <span className="block text-[11px] text-rose-300">{blocked}</span>
                ) : (
                  <span className="block text-[11px] text-slate-500">
                    {p.kind === 'PITCHER' ? ROLE_KO[p.role ?? 'RP'] : POSITION_KO[p.position]} · 종합{' '}
                    {playerScore(p)}
                  </span>
                )}
              </span>
              {!blocked && (
                <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold tabular text-amber-300">
                  +{gold.toLocaleString()}G
                </span>
              )}
            </button>
          ))}
          {rows.length === 0 && (
            <p className="p-4 text-center text-sm text-slate-500">해당하는 선수가 없습니다.</p>
          )}
        </div>
      </div>

      {!selected ? (
        <div className="panel grid place-items-center p-8 text-center text-sm text-slate-500">
          방출할 선수를 목록에서 고르세요.
        </div>
      ) : selected.blocked ? (
        <div className="panel space-y-3 p-6">
          <h2 className="text-lg font-black">{selected.p.name}</h2>
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {selected.blocked}
          </div>
          <Link href="/roster" className="btn">
            타순·로테이션 정리하러 가기
          </Link>
          <p className="text-[11px] text-slate-500">
            선수단 → «타순·로테이션» 탭에서 먼저 빼면 방출할 수 있습니다.
          </p>
        </div>
      ) : (
        <div className="panel space-y-4 p-6">
          <div className="flex items-center gap-3">
            <span
              className="grid h-12 w-12 shrink-0 place-items-center rounded-xl text-lg font-black"
              style={{ background: team.primaryColor, color: team.secondaryColor }}
            >
              {selected.p.number}
            </span>
            <div>
              <div className="flex items-center gap-1.5">
                <TierBadge player={selected.p} />
                <span className="text-xl font-black">{selected.p.name}</span>
              </div>
              <div className="text-xs text-slate-400">
                {selected.p.kind === 'PITCHER'
                  ? ROLE_KO[selected.p.role ?? 'RP']
                  : POSITION_KO[selected.p.position]}{' '}
                · 종합 {playerScore(selected.p)} · 잠재력 {selected.p.potential}
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-center">
            <div className="text-[11px] text-amber-200/70">환급 골드</div>
            <div className="text-3xl font-black tabular text-amber-300">
              +{selected.gold.toLocaleString()} G
            </div>
            <div className="mt-0.5 text-[11px] tabular text-slate-400">
              방출 후 보유 {(team.gold + selected.gold).toLocaleString()} G
            </div>
          </div>

          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[11px] leading-relaxed text-rose-200/90">
            방출한 선수는 되돌릴 수 없습니다. 능력치·레벨·훈련에 쓴 포인트와 구종 습득에 쓴 골드가
            모두 사라지고, 다시 뽑아도 같은 선수는 나오지 않습니다.
          </div>

          {!confirming ? (
            <button className="btn btn-danger w-full" onClick={() => setConfirming(true)}>
              방출하기
            </button>
          ) : (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3">
              <p className="mb-2 text-sm text-rose-200">
                정말 «{selected.p.name}» 선수를 방출할까요?
              </p>
              <div className="flex gap-2">
                <button
                  className="btn flex-1 !py-1.5 !text-xs"
                  onClick={() => setConfirming(false)}
                >
                  취소
                </button>
                <button
                  className="btn btn-danger flex-1 !py-1.5 !text-xs"
                  onClick={() => doRelease(selected.p.id)}
                >
                  방출 확정 · +{selected.gold.toLocaleString()}G
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
