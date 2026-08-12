'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { onlineRewardUsedToday, saveTeam } from '@/lib/firebase/store';
import { ONLINE_DAILY_EXP_CAP, ONLINE_DAILY_GOLD_CAP } from '@/lib/game/onlineCap';
import {
  ACCESSORY_DEFS,
  BAT_DEFS,
  BODY_BY_ID,
  BODY_DEFS,
  FORM_DESCS,
  FORM_NAMES,
  GLOVE_DEFS,
  PITCH_DEFS,
  POSITION_KO,
  STANCE_DESCS,
  STANCE_NAMES,
} from '@/lib/game/constants';
import {
  PREVIEW_MODES,
  PlayerPreview,
  type PreviewMode,
} from '@/components/three/PlayerPreview';
import { TierBadge } from '@/components/ui/TierBadge';
import { arsenalOf } from '@/lib/game/pitching';
import { ROTATION_SIZE, playerScore } from '@/lib/game/generator';
import { bodyMod, injuryPenalty } from '@/lib/game/batting';
import {
  TIER_COLOR,
  TIER_KO,
  TIER_MAX_LEVEL,
  TIER_STAT_CAP,
  canTierUp,
  expToNext,
  isMaxLevel,
  levelProgress,
  pitchSlots,
  pitchSlotsUsed,
  statCap,
  tierUpCost,
  upgradeTier,
} from '@/lib/game/progression';
import { ITEM_DEFS, ITEM_ORDER, itemCount, totalItems, useItem } from '@/lib/game/items';
import {
  ROLE_DESC,
  ROLE_KO,
  moveLineup,
  moveRotation,
  resetAssignments,
  rosterIssues,
  setBatterPosition,
  setPitcherRole,
  swapIntoLineup,
} from '@/lib/game/roster';
import {
  BATTING_KEYS,
  BATTING_KEY_DESC,
  BATTING_KEY_KO,
  PITCH_ATTR_DESC,
  PITCH_ATTR_KO,
  STAMINA_DESC,
  learnPitch,
  learnPitchGold,
  learnablePitchesFor,
  pitchUpgradeCost,
  statUpgradeCost,
  trainBatting,
  trainPitch,
  trainStamina,
} from '@/lib/game/training';
import type {
  BatterPosition,
  BattingStance,
  BodyType,
  Gear,
  ItemId,
  PitcherRole,
  PitchType,
  PitchingForm,
  Player,
  Team,
} from '@/lib/game/types';
import { BATTER_POSITIONS, PITCHER_ROLES } from '@/lib/game/types';
import { baseballRate } from '@/lib/format';

type Tab = 'stats' | 'train' | 'grow' | 'gear' | 'lineup';

export default function RosterPage() {
  const router = useRouter();
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);
  const upsertTeam = useAppStore((s) => s.upsertTeam);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('stats');

  useEffect(() => {
    if (team && (!selectedId || !team.players.some((p) => p.id === selectedId))) {
      setSelectedId(team.players[0]?.id ?? null);
    }
  }, [team, selectedId]);

  const selected = team?.players.find((p) => p.id === selectedId) ?? null;

  const sorted = useMemo(() => {
    if (!team) return [];
    const order = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
    const roleOrder: Record<string, number> = { SP: 0, RP: 1, CP: 2 };
    return team.players.slice().sort((a, b) => {
      const d = order.indexOf(a.position) - order.indexOf(b.position);
      if (d !== 0) return d;
      if (a.kind === 'PITCHER' && b.kind === 'PITCHER') {
        const r = (roleOrder[a.role ?? 'RP'] ?? 1) - (roleOrder[b.role ?? 'RP'] ?? 1);
        if (r !== 0) return r;
      }
      return a.number - b.number;
    });
  }, [team]);

  const issues = useMemo(
    () => (team ? rosterIssues(team, settings.useDH) : []),
    [team, settings.useDH],
  );

  async function commit(next: Team, message?: string) {
    upsertTeam(next);
    await saveTeam(next);
    if (message) setMsg(message);
  }

  function updatePlayer(p: Player, message?: string) {
    if (!team) return;
    const next: Team = { ...team, players: team.players.map((x) => (x.id === p.id ? p : x)) };
    void commit(next, message);
  }

  if (!team) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <p className="mb-1 font-bold">선수단이 없습니다</p>
        <p className="mb-4 text-sm text-slate-400">
          선수 티어·레벨 시스템이 도입되면서 예전 팀 데이터는 더 이상 불러오지 않습니다.
          새로 창단하면 C등급 1레벨 선수 23명으로 시작합니다.
        </p>
        <button className="btn btn-primary" onClick={() => router.push('/team')}>
          팀 창단하기
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black">{team.name} 선수단</h1>
        <span className="rounded-lg bg-amber-500/15 px-3 py-1 text-sm font-bold text-amber-300">
          {team.gold.toLocaleString()} G
        </span>
        <span className="rounded-lg bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">
          아이템 {totalItems(team.inventory)}개
        </span>
        <OnlineDailyChip uid={team.ownerUid} />
      </div>

      {msg && (
        <div className="rounded-xl border border-lime-500/30 bg-lime-500/10 px-4 py-2 text-sm text-lime-200">
          {msg}
        </div>
      )}

      {issues.length > 0 && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3">
          <p className="mb-1 text-sm font-bold text-rose-300">경기에 나가려면 정리해야 합니다</p>
          <ul className="space-y-0.5 text-xs text-rose-200/90">
            {issues.map((m) => (
              <li key={m}>· {m}</li>
            ))}
          </ul>
          <button
            className="btn mt-2 !py-1 !text-[11px]"
            onClick={() => void commit(resetAssignments(team, settings.useDH), '자동 편성했습니다.')}
          >
            자동 편성으로 정리
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* 선수 목록 */}
        <div className="panel max-h-[70vh] overflow-y-auto p-2">
          {sorted.map((p) => {
            const isP = p.kind === 'PITCHER';
            const score = playerScore(p);
            return (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition ${
                  selectedId === p.id ? 'bg-lime-500/20' : 'hover:bg-white/5'
                }`}
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
                    {p.injury && <span className="text-[11px] text-rose-400">🩹</span>}
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {isP ? ROLE_KO[p.role ?? 'RP'] : POSITION_KO[p.position]} · {p.bats}/{p.throws}
                  </span>
                </span>
                <span className="text-sm font-bold tabular text-slate-300">{score}</span>
                {p.trainingPoints > 0 && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                    {p.trainingPoints}P
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 상세 */}
        <div className="space-y-4">
          {selected && (
            <>
              <PlayerHeader
                player={selected}
                team={team}
                onRename={(name) => updatePlayer({ ...selected, name })}
                onCommit={commit}
                onMessage={setMsg}
              />

              <div className="flex gap-1 rounded-xl bg-white/5 p-1">
                {(
                  [
                    ['stats', '능력치'],
                    ['train', '훈련'],
                    ['grow', '성장'],
                    ['gear', '커스터마이징'],
                    ['lineup', '타순·로테이션'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    className={`flex-1 rounded-lg px-2 py-2 text-sm font-semibold transition ${
                      tab === k ? 'bg-lime-500/25 text-lime-200' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'stats' && <StatsTab player={selected} />}
              {tab === 'train' && (
                <TrainTab
                  player={selected}
                  team={team}
                  onChange={(p, m) => updatePlayer(p, m)}
                  onCommit={commit}
                  onMessage={setMsg}
                />
              )}
              {tab === 'grow' && (
                <GrowTab
                  player={selected}
                  team={team}
                  onCommit={commit}
                  onMessage={setMsg}
                />
              )}
              {tab === 'gear' && (
                <GearTab player={selected} team={team} onChange={(p) => updatePlayer(p)} />
              )}
              {tab === 'lineup' && (
                <LineupTab
                  team={team}
                  useDH={settings.useDH}
                  onChange={(t, m) => void commit(t, m)}
                  onMessage={setMsg}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * 선수 상세 머리말.
 *
 * 포지션 변경 범위가 선수 구분에 따라 갈린다 — 투수는 마운드 역할(선발/중간계투/마무리),
 * 타자는 야수 포지션 9개. 투수를 1루수로 보내는 일은 이제 불가능하다.
 */
function PlayerHeader({
  player,
  team,
  onRename,
  onCommit,
  onMessage,
}: {
  player: Player;
  team: Team;
  onRename: (name: string) => void;
  onCommit: (t: Team, msg?: string) => Promise<void>;
  onMessage: (m: string) => void;
}) {
  const isP = player.kind === 'PITCHER';
  const cap = statCap(player);

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-start gap-4">
        <div
          className="grid h-16 w-16 place-items-center rounded-xl text-2xl font-black"
          style={{ background: team.primaryColor, color: team.secondaryColor }}
        >
          {player.number}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <TierBadge player={player} />
            <input
              type="text"
              className="!w-auto !bg-transparent !border-transparent !px-0 !text-2xl !font-black"
              value={player.name}
              maxLength={12}
              onChange={(e) => onRename(e.target.value)}
            />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="rounded bg-white/5 px-2 py-1 font-semibold">
              {isP ? '투수' : '타자'}
            </span>
            {isP ? (
              <select
                className="!w-auto !py-1 !text-xs"
                value={player.role ?? 'RP'}
                onChange={(e) => {
                  const r = setPitcherRole(team, player.id, e.target.value as PitcherRole);
                  if (r.ok) void onCommit(r.team, r.message);
                  else onMessage(r.message);
                }}
              >
                {PITCHER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_KO[r]}
                  </option>
                ))}
              </select>
            ) : (
              <select
                className="!w-auto !py-1 !text-xs"
                value={player.position}
                onChange={(e) => {
                  const r = setBatterPosition(team, player.id, e.target.value as BatterPosition);
                  if (r.ok) void onCommit(r.team, r.message);
                  else onMessage(r.message);
                }}
              >
                {BATTER_POSITIONS.map((pos) => (
                  <option key={pos} value={pos}>
                    {POSITION_KO[pos]}
                  </option>
                ))}
              </select>
            )}
            <span>타석 {player.bats}</span>
            <span>투구 {player.throws}</span>
            <span title={`티어 상한 ${TIER_STAT_CAP[player.tier]} / 잠재력 ${player.potential}`}>
              능력치 상한 {cap}
            </span>
            {isP && <FatigueChip player={player} />}
          </div>
          {player.injury && (
            <p className="mt-2 rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">
              컨디션 난조 ({player.injury.reason}) · {player.injury.gamesLeft}경기 남음 — 출전은
              가능하지만 경기 중 <b>모든 능력치가 {Math.round(injuryPenalty(player) * 100)}% 낮아집니다</b>.
              회복이 가까워질수록 폭이 줄어듭니다. 부상치료제로 즉시 없앨 수 있습니다.
            </p>
          )}
        </div>
        <div className="rounded-xl bg-amber-500/15 px-4 py-2 text-center">
          <div className="text-[11px] text-amber-200/70">훈련 포인트</div>
          <div className="text-xl font-black text-amber-300">{player.trainingPoints}</div>
        </div>
      </div>

      <div className="mt-4">
        <ExpBar player={player} />
      </div>
    </div>
  );
}

function FatigueChip({ player }: { player: Player }) {
  const pct = Math.round((1 - (player.fatigue ?? 0)) * 100);
  const tone = pct >= 70 ? 'text-lime-300' : pct >= 35 ? 'text-amber-300' : 'text-rose-300';
  return (
    <span
      className={tone}
      title="경기 사이에 이월되는 스태미나입니다. 등판하지 않은 경기마다 1/3씩 회복해 3경기를 쉬면 가득 찹니다."
    >
      스태미나 {pct}%
    </span>
  );
}

function ExpBar({ player }: { player: Player }) {
  const max = isMaxLevel(player);
  const need = expToNext(player.level);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="text-slate-400">
          {TIER_KO[player.tier]} Lv.{player.level}
          <span className="ml-1 text-slate-600">/ {TIER_MAX_LEVEL[player.tier]}</span>
        </span>
        <span className="tabular text-slate-500">
          {max ? '최대 레벨 — 티어 강화가 필요합니다' : `${player.exp} / ${need} EXP`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/8">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${levelProgress(player) * 100}%`,
            background: TIER_COLOR[player.tier],
          }}
        />
      </div>
    </div>
  );
}

/**
 * 오늘 온라인 대전으로 받은 보상.
 * 원장이 localStorage에 있어 서버 렌더 결과와 어긋나므로 마운트 후에 읽는다.
 */
function OnlineDailyChip({ uid }: { uid: string }) {
  const [used, setUsed] = useState<{ gold: number; exp: number } | null>(null);
  useEffect(() => setUsed(onlineRewardUsedToday(uid)), [uid]);
  if (!used) return null;

  const full = used.gold >= ONLINE_DAILY_GOLD_CAP && used.exp >= ONLINE_DAILY_EXP_CAP;
  return (
    <span
      title="온라인 대전(1:1 · 2대2 · 릴레이)으로 하루에 받을 수 있는 보상입니다. 매일 자정에 다시 채워집니다."
      className={`rounded-lg px-3 py-1 text-xs font-semibold ${
        full ? 'bg-white/5 text-slate-500' : 'bg-sky-500/15 text-sky-300'
      }`}
    >
      온라인 오늘 {used.gold.toLocaleString()}/{ONLINE_DAILY_GOLD_CAP.toLocaleString()}G ·{' '}
      {used.exp.toLocaleString()}/{ONLINE_DAILY_EXP_CAP.toLocaleString()}EXP
    </span>
  );
}

function Bar({
  label,
  value,
  max = 99,
  marker,
  cap,
  mod,
}: {
  label: string;
  value: number;
  max?: number;
  /** 설명을 펼칠 수 있는 항목에 붙는 화살표 */
  marker?: string;
  /** 티어·잠재력 상한. 막대 위에 눈금으로 표시한다. */
  cap?: number;
  /** 체형 등으로 붙은 보정. 수치 옆에 함께 보여 준다. */
  mod?: { value: number; label: string };
}) {
  const pct = Math.round((value / max) * 100);
  const color = value >= 80 ? '#f43f5e' : value >= 65 ? '#f59e0b' : value >= 50 ? '#38bdf8' : '#64748b';
  const modTone = !mod ? '' : mod.value > 0 ? 'text-lime-300' : 'text-rose-300';
  return (
    <div className="flex items-center gap-3">
      <span className="flex w-20 shrink-0 items-center gap-1 text-xs text-slate-400">
        {label}
        {marker && <span className="text-[11px] leading-none text-slate-500">{marker}</span>}
      </span>
      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-white/8">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
        {cap != null && cap < max && (
          <span
            title={`성장 상한 ${cap}`}
            className="absolute top-0 h-full w-px bg-white/50"
            style={{ left: `${(cap / max) * 100}%` }}
          />
        )}
      </div>
      <span className="flex w-20 shrink-0 items-baseline justify-end gap-1">
        <span className="text-sm font-bold tabular">{value}</span>
        {mod && mod.value !== 0 && (
          <span className={`text-[10px] font-bold tabular ${modTone}`} title={mod.label}>
            {mod.value > 0 ? '+' : ''}
            {mod.value}
          </span>
        )}
      </span>
    </div>
  );
}

function StatsTab({ player }: { player: Player }) {
  const arsenal = arsenalOf(player);
  const isP = player.kind === 'PITCHER';
  const cap = statCap(player);
  const body = bodyMod(player);
  const bodyDef = BODY_BY_ID[player.body ?? 'NORMAL'];
  const modOf = (k: string) =>
    k === 'power' && body.power
      ? { value: body.power, label: `체형: ${bodyDef.ko}` }
      : k === 'speed' && body.speed
        ? { value: body.speed, label: `체형: ${bodyDef.ko}` }
        : undefined;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="panel p-5">
        <h3 className="mb-1 font-bold">타자 능력치</h3>
        <p className="mb-3 text-[11px] text-slate-500">
          막대 위 흰 눈금이 성장 상한({cap})입니다.
          {!isP && ` 체형 «${bodyDef.ko}» — ${bodyDef.desc}.`}
        </p>
        <div className="space-y-2.5">
          {BATTING_KEYS.map((k) => (
            <Bar
              key={k}
              label={BATTING_KEY_KO[k]}
              value={player.batting[k]}
              cap={cap}
              mod={modOf(k)}
            />
          ))}
        </div>
        {!isP && (body.power !== 0 || body.speed !== 0) && (
          <p className="mt-3 rounded-lg bg-white/5 px-2.5 py-2 text-[11px] leading-relaxed text-slate-400">
            표시된 숫자는 훈련으로 올린 기본값이고, 옆의 {body.power > 0 ? '+' : ''}
            {body.power}/{body.speed > 0 ? '+' : ''}
            {body.speed}가 체형 보정입니다. 실제 경기에는 둘을 더한 값이 쓰입니다 — 파워{' '}
            {player.batting.power + body.power}, 스피드 {player.batting.speed + body.speed}.
          </p>
        )}
      </section>

      {(isP || arsenal.length > 1) && (
        <section className="panel p-5">
          <h3 className="mb-3 font-bold">
            투수 능력치
            <span className="ml-2 text-xs font-normal text-slate-500">
              스태미나 {player.pitching?.stamina ?? 0} · 구종 {pitchSlotsUsed(player)}/
              {pitchSlots(player)}
            </span>
          </h3>
          <div className="space-y-4">
            {arsenal.map(({ type, attr, def }) => (
              <div key={type}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    className="rounded px-1.5 py-0.5 text-[11px] font-bold"
                    style={{ background: def.color + '30', color: def.color }}
                  >
                    {def.ko}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {def.baseVelo + Math.round((def.veloRange * attr.velocity) / 99)}km/h
                  </span>
                </div>
                <div className="space-y-1.5 pl-1">
                  <Bar label="구속" value={attr.velocity} cap={cap} />
                  <Bar label="제구" value={attr.control} cap={cap} />
                  <Bar label="무브먼트" value={attr.movement} cap={cap} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel p-5 md:col-span-2">
        <h3 className="mb-3 font-bold">시즌 성적</h3>
        <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
          <Mini label="경기" v={player.season.g} />
          <Mini label="타율" v={player.season.ab ? baseballRate(player.season.h / player.season.ab) : '-'} />
          <Mini label="안타" v={player.season.h} />
          <Mini label="홈런" v={player.season.hr} />
          <Mini label="타점" v={player.season.rbi} />
          <Mini label="도루" v={player.season.sb} />
          {isP && (
            <>
              <Mini label="이닝" v={(player.season.ip3 / 3).toFixed(1)} />
              <Mini label="탈삼진" v={player.season.pk} />
              <Mini label="투구수" v={player.season.np} />
              <Mini label="승" v={player.season.w} />
              <Mini label="패" v={player.season.l} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Mini({ label, v }: { label: string; v: string | number }) {
  return (
    <div className="rounded-lg bg-white/5 px-2 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="font-bold tabular">{v}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * 훈련 항목 한 줄.
 * 능력치 이름을 누르면 그 능력치가 높을 때 무엇이 좋아지는지 설명을 펼친다.
 */
function TrainRow({
  label,
  value,
  desc,
  cost,
  points,
  cap,
  open,
  onToggle,
  onTrain,
}: {
  label: string;
  value: number;
  desc: string;
  cost: number;
  points: number;
  cap: number;
  open: boolean;
  onToggle: () => void;
  onTrain: () => void;
}) {
  const maxed = !Number.isFinite(cost);
  const can = !maxed && points >= cost;
  return (
    <div className={`rounded-lg transition ${open ? 'bg-white/[0.05]' : ''}`}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          title={`${label} 설명 보기`}
          className="min-w-0 flex-1 rounded-lg px-1.5 py-1 transition hover:bg-white/[0.06]"
        >
          <Bar label={label} value={value} marker={open ? '▲' : '▼'} cap={cap} />
        </button>
        <button className="btn !py-1 !px-2.5 !text-xs" disabled={!can} onClick={onTrain}>
          +1 · {maxed ? 'MAX' : `${cost}P`}
        </button>
      </div>
      {open && (
        <p className="px-2.5 pb-2 text-[11px] leading-relaxed text-slate-300">{desc}</p>
      )}
    </div>
  );
}

function TrainTab({
  player,
  team,
  onChange,
  onCommit,
  onMessage,
}: {
  player: Player;
  team: Team;
  onChange: (p: Player, msg?: string) => void;
  /** 구종 습득은 팀 골드를 쓰므로 팀째로 커밋한다 */
  onCommit: (next: Team, msg?: string) => Promise<void>;
  onMessage: (m: string) => void;
}) {
  const arsenal = arsenalOf(player);
  const learnable = learnablePitchesFor(player);
  const cap = statCap(player);
  const slotsLeft = pitchSlots(player) - pitchSlotsUsed(player);
  /** 설명을 펼친 항목. 같은 항목을 다시 누르면 접힌다. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (k: string) => setOpenKey((cur) => (cur === k ? null : k));

  return (
    <div className="space-y-4">
      <section className="panel p-5">
        <h3 className="mb-1 font-bold">타자 훈련</h3>
        <p className="mb-4 text-xs text-slate-500">
          능력치가 높을수록 1 올리는 비용이 급격히 커집니다. 상한은 <b>{cap}</b>이며 (
          {TIER_KO[player.tier]} 상한 {TIER_STAT_CAP[player.tier]} · 잠재력 {player.potential} 중
          낮은 쪽), 여기서 막히면 티어를 강화해야 더 올라갑니다.
          <br />
          훈련 포인트는 레벨업으로만 들어옵니다.
        </p>
        <div className="space-y-1">
          {BATTING_KEYS.map((k) => (
            <TrainRow
              key={k}
              label={BATTING_KEY_KO[k]}
              value={player.batting[k]}
              desc={BATTING_KEY_DESC[k]}
              cost={statUpgradeCost(player.batting[k], cap)}
              points={player.trainingPoints}
              cap={cap}
              open={openKey === `bat:${k}`}
              onToggle={() => toggle(`bat:${k}`)}
              onTrain={() => {
                const r = trainBatting(player, k, 1);
                if (r.ok) onChange(r.player, r.message);
                else onMessage(r.message);
              }}
            />
          ))}
        </div>
      </section>

      {player.pitching && (
        <>
          <section className="panel p-5">
            <h3 className="mb-1 font-bold">투수 훈련</h3>
            <p className="mb-4 text-xs text-slate-500">
              항목 이름을 누르면 설명이 표시됩니다.
            </p>
            <div className="space-y-5">
              <TrainRow
                label="스태미나"
                value={player.pitching.stamina}
                desc={STAMINA_DESC}
                cost={statUpgradeCost(player.pitching.stamina, cap)}
                points={player.trainingPoints}
                cap={cap}
                open={openKey === 'stamina'}
                onToggle={() => toggle('stamina')}
                onTrain={() => {
                  const r = trainStamina(player, 1);
                  if (r.ok) onChange(r.player, r.message);
                  else onMessage(r.message);
                }}
              />
              {arsenal.map(({ type, attr, def }) => (
                <div key={type}>
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="rounded px-2 py-0.5 text-xs font-bold"
                      style={{ background: def.color + '30', color: def.color }}
                    >
                      {def.ko}
                    </span>
                    <span className="text-[11px] text-slate-500">{def.desc}</span>
                  </div>
                  <div className="space-y-1">
                    {(['velocity', 'control', 'movement'] as const).map((key) => (
                      <TrainRow
                        key={key}
                        label={PITCH_ATTR_KO[key]}
                        value={attr[key]}
                        desc={PITCH_ATTR_DESC[key]}
                        cost={pitchUpgradeCost(attr[key], cap, type as PitchType)}
                        points={player.trainingPoints}
                        cap={cap}
                        open={openKey === `${type}:${key}`}
                        onToggle={() => toggle(`${type}:${key}`)}
                        onTrain={() => {
                          const r = trainPitch(player, type as PitchType, key, 1);
                          if (r.ok) onChange(r.player, r.message);
                          else onMessage(r.message);
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel p-5">
            <h3 className="mb-1 flex items-center gap-2 font-bold">
              새 구종 습득
              <span
                className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                  slotsLeft > 0 ? 'bg-lime-500/20 text-lime-300' : 'bg-white/10 text-slate-400'
                }`}
              >
                슬롯 {pitchSlotsUsed(player)} / {pitchSlots(player)}
              </span>
            </h3>
            <p className="mb-4 text-xs text-slate-500">
              직구는 모든 투수가 기본 보유합니다. 보유할 수 있는 구종 수는 티어가 정합니다 (C 3 · B 4
              · A 5 · S 6). 습득 직후 능력치는 낮게 시작합니다.
              <br />
              <b>구종 습득에는 골드를 씁니다.</b> 훈련 포인트는 능력치에만 쓰입니다. (보유{' '}
              <span className="tabular text-amber-300">{team.gold.toLocaleString()}G</span>)
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {learnable.map((t) => {
                const def = PITCH_DEFS[t];
                const cost = learnPitchGold(t, player);
                const can = team.gold >= cost && slotsLeft > 0;
                return (
                  <button
                    key={t}
                    disabled={!can}
                    onClick={() => {
                      const r = learnPitch(team, player.id, t, Date.now() >>> 0);
                      if (r.ok) void onCommit(r.team, r.message);
                      else onMessage(r.message);
                    }}
                    className={`rounded-xl border p-3 text-left transition ${
                      can
                        ? 'border-white/10 bg-white/[0.03] hover:border-lime-400/60 hover:bg-lime-500/10'
                        : 'border-white/5 bg-white/[0.02] opacity-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold" style={{ color: def.color }}>
                        {def.ko}
                      </span>
                      <span className="text-xs font-bold tabular text-amber-300">
                        {cost.toLocaleString()}G
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-slate-500">{def.desc}</div>
                  </button>
                );
              })}
              {learnable.length === 0 && (
                <p className="text-sm text-slate-500">모든 구종을 보유하고 있습니다.</p>
              )}
            </div>
            {slotsLeft <= 0 && learnable.length > 0 && (
              <p className="mt-3 text-[11px] text-amber-300/80">
                {TIER_KO[player.tier]} 구종 슬롯이 가득 찼습니다. 티어를 강화하면 하나 더 익힐 수
                있습니다.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * 성장 탭. 레벨·티어 강화와 아이템 사용을 한 곳에 모은다.
 *
 * 티어 강화는 능력치를 건드리지 않는다 — 레벨만 1로 돌아가고 상한(최대 레벨·능력치 상한·구종
 * 슬롯)이 넓어진다. 그래서 "C 10레벨의 능력치 그대로 B 1레벨"이 된다.
 */
function GrowTab({
  player,
  team,
  onCommit,
  onMessage,
}: {
  player: Player;
  team: Team;
  onCommit: (t: Team, msg?: string) => Promise<void>;
  onMessage: (m: string) => void;
}) {
  const cost = tierUpCost(player);
  const ready = canTierUp(player);
  const affordable = cost != null && team.gold >= cost;

  return (
    <div className="space-y-4">
      <section className="panel p-5">
        <h3 className="mb-3 font-bold">티어 강화</h3>
        <div className="mb-3 grid grid-cols-4 gap-2">
          {(['C', 'B', 'A', 'S'] as const).map((t) => {
            const on = player.tier === t;
            return (
              <div
                key={t}
                className={`rounded-xl border-2 p-2 text-center transition ${
                  on ? 'border-current' : 'border-white/10 opacity-45'
                }`}
                style={{ color: on ? TIER_COLOR[t] : undefined }}
              >
                <div className="text-lg font-black">{t}</div>
                <div className="text-[10px] text-slate-400">
                  Lv.{TIER_MAX_LEVEL[t]} · 상한 {TIER_STAT_CAP[t]}
                </div>
                <div className="text-[10px] text-slate-500">구종 {pitchSlots({ ...player, tier: t })}</div>
              </div>
            );
          })}
        </div>

        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          최대 레벨에 도달하면 골드로 티어를 올릴 수 있습니다. <b>능력치는 그대로 유지</b>되고
          레벨만 1로 돌아가며, 최대 레벨·능력치 상한·구종 슬롯이 함께 넓어집니다.
        </p>

        {player.tier === 'S' ? (
          <p className="rounded-lg bg-white/5 px-3 py-2 text-sm text-slate-400">
            최고 티어입니다.
          </p>
        ) : (
          <button
            className="btn btn-primary w-full !py-2.5"
            disabled={!ready || !affordable}
            onClick={() => {
              const r = upgradeTier(team, player.id);
              if (r.ok) void onCommit(r.team, r.message);
              else onMessage(r.message);
            }}
          >
            {ready
              ? `${TIER_KO[player.tier]} → ${TIER_KO[(['C', 'B', 'A', 'S'] as const)[['C', 'B', 'A', 'S'].indexOf(player.tier) + 1]]} 강화 · ${cost?.toLocaleString()}G${affordable ? '' : ' (골드 부족)'}`
              : `최대 레벨(${TIER_MAX_LEVEL[player.tier]})에 도달해야 강화할 수 있습니다`}
          </button>
        )}
      </section>

      <section className="panel p-5">
        <h3 className="mb-1 font-bold">아이템 사용</h3>
        <p className="mb-4 text-xs text-slate-500">
          아이템은 경기 보상으로는 나오지 않습니다. 리그를 끝까지 마쳐 1~3위 안에 들면 받습니다.
        </p>
        <div className="space-y-2">
          {ITEM_ORDER.map((id) => {
            const def = ITEM_DEFS[id];
            const have = itemCount(team.inventory, id);
            const wrongTarget = def.target === 'PITCHER' && player.kind !== 'PITCHER';
            return (
              <div
                key={id}
                className={`flex items-start gap-3 rounded-xl border p-3 ${
                  have > 0 && !wrongTarget
                    ? 'border-white/10 bg-white/[0.03]'
                    : 'border-white/5 bg-white/[0.02] opacity-50'
                }`}
              >
                <span
                  className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: def.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">{def.ko}</span>
                    <span className="text-[11px] text-slate-500">×{have}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{def.desc}</p>
                </div>
                <button
                  className="btn !px-2.5 !py-1 !text-xs"
                  disabled={have <= 0 || wrongTarget}
                  onClick={() => {
                    const r = useItem(team, player.id, id);
                    if (r.ok) void onCommit(r.team, r.message);
                    else onMessage(r.message);
                  }}
                >
                  사용
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** 마우스를 올린 항목을 실제로 적용하지 않고 미리보기에만 반영한다. */
interface HoverPatch {
  mode?: PreviewMode;
  stance?: BattingStance;
  form?: PitchingForm;
  body?: BodyType;
  gear?: Partial<Gear>;
}

/** 색상 슬라이더를 끌 때마다 저장하지 않도록 커밋을 미루는 시간 (ms) */
const COLOR_COMMIT_MS = 240;

function GearTab({
  player,
  team,
  onChange,
}: {
  player: Player;
  team: Team;
  onChange: (p: Player) => void;
}) {
  const g = player.gear;
  const [mode, setMode] = useState<PreviewMode>(player.kind === 'PITCHER' ? 'PITCH' : 'BAT');
  const [hover, setHover] = useState<HoverPatch | null>(null);

  // 색상은 즉시 미리보기에 반영하고 저장만 미룬다
  const [colors, setColors] = useState({ bat: g.batColor, glove: g.gloveColor });
  const colorsRef = useRef(colors);
  const playerRef = useRef(player);
  playerRef.current = player;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = { bat: player.gear.batColor, glove: player.gear.gloveColor };
    colorsRef.current = next;
    setColors(next);
  }, [player.id, player.gear.batColor, player.gear.gloveColor]);

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  /** 어떤 변경이든 대기 중인 색상까지 함께 저장한다 */
  function commit(patch: Partial<Player>, gearPatch?: Partial<Gear>) {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = playerRef.current;
    onChange({
      ...p,
      ...patch,
      gear: {
        ...p.gear,
        batColor: colorsRef.current.bat,
        gloveColor: colorsRef.current.glove,
        ...gearPatch,
      },
    });
  }

  function setColor(key: 'bat' | 'glove', v: string) {
    const next = { ...colorsRef.current, [key]: v };
    colorsRef.current = next;
    setColors(next);
    if (timer.current) clearTimeout(timer.current);
    const targetId = playerRef.current.id;
    timer.current = setTimeout(() => {
      timer.current = null;
      const p = playerRef.current;
      // 커밋 전에 다른 선수로 넘어갔다면 그 선수에게 색을 덮어쓰지 않는다
      if (p.id !== targetId) return;
      onChange({ ...p, gear: { ...p.gear, batColor: next.bat, gloveColor: next.glove } });
    }, COLOR_COMMIT_MS);
  }

  // 미리보기에 그릴 선수 (선택값 + 마우스 오버 중인 항목)
  const shown: Player = {
    ...player,
    stance: hover?.stance ?? player.stance,
    form: hover?.form ?? player.form,
    body: hover?.body ?? player.body,
    gear: { ...g, batColor: colors.bat, gloveColor: colors.glove, ...hover?.gear },
  };
  const shownMode = hover?.mode ?? mode;

  const uniform = {
    primary: team.primaryColor,
    secondary: team.secondaryColor,
    accent: team.accentColor,
    type: team.uniformType,
  };

  const bat = BAT_DEFS.find((b) => b.id === shown.gear.bat)!;
  const glove = GLOVE_DEFS.find((b) => b.id === shown.gear.glove)!;
  const accessory = ACCESSORY_DEFS.find((a) => a.id === shown.gear.accessory)!;

  const clear = () => setHover(null);
  /** 선택 버튼 공통 클래스 */
  const pick = (on: boolean) =>
    `rounded-lg border text-left transition ${
      on
        ? 'border-lime-400 bg-lime-500/15 text-lime-100'
        : 'border-white/10 bg-white/[0.03] hover:border-lime-400/40 hover:bg-white/[0.07]'
    }`;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* 항목 밖으로 나가면 미리보기를 되돌린다 (개별 버튼의 leave를 놓치는 경우 대비) */}
      <div className="grid gap-4 sm:grid-cols-2" onMouseLeave={() => setHover(null)}>
        {player.kind === 'BATTER' && (
          <section className="panel p-5 sm:col-span-2">
            <h3 className="mb-3 font-bold">체형</h3>
            <div className="grid grid-cols-3 gap-2">
              {BODY_DEFS.map((b) => (
                <button
                  key={b.id}
                  title={b.desc}
                  onMouseEnter={() => setHover({ body: b.id, mode: 'BAT' })}
                  onMouseLeave={clear}
                  onClick={() => {
                    setMode('BAT');
                    commit({ body: b.id });
                  }}
                  className={`${pick(player.body === b.id)} px-2 py-2.5 text-center`}
                >
                  <div className="text-sm font-bold">{b.ko}</div>
                  <div className="mt-0.5 text-[11px] tabular">
                    <span className={b.powerMod > 0 ? 'text-lime-300' : b.powerMod < 0 ? 'text-rose-300' : 'text-slate-500'}>
                      파워 {b.powerMod > 0 ? '+' : ''}{b.powerMod}
                    </span>
                    <span className="mx-1 text-slate-600">·</span>
                    <span className={b.speedMod > 0 ? 'text-lime-300' : b.speedMod < 0 ? 'text-rose-300' : 'text-slate-500'}>
                      스피드 {b.speedMod > 0 ? '+' : ''}{b.speedMod}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              {BODY_BY_ID[shown.body ?? 'NORMAL'].desc}. 체형은 능력치 수치 자체를 바꾸지 않고
              경기에 쓰이는 값에만 더해집니다 — 능력치 탭에서 «파워 62 +5»처럼 함께 표시됩니다.
              키와 머리 크기는 달라지지 않고 몸의 두께만 바뀝니다.
            </p>
          </section>
        )}

        <section className="panel p-5">
          <h3 className="mb-3 font-bold">타격 자세</h3>
          <div className="grid grid-cols-3 gap-2">
            {STANCE_NAMES.map((n, i) => (
              <button
                key={n}
                title={STANCE_DESCS[i]}
                onMouseEnter={() => setHover({ stance: i as BattingStance, mode: 'BAT' })}
                onMouseLeave={clear}
                onClick={() => {
                  setMode('BAT');
                  commit({ stance: i as BattingStance });
                }}
                className={`${pick(player.stance === i)} px-2 py-2 text-center text-xs font-semibold`}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            {STANCE_DESCS[shown.stance]} · 자세에 따라 컨택·파워·선구안이 소폭 달라집니다. (레그킥:
            파워↑ 컨택↓ / 크라우칭: 컨택·선구안↑ 파워↓)
          </p>
        </section>

        <section className="panel p-5">
          <h3 className="mb-3 font-bold">피칭 자세</h3>
          <div className="grid grid-cols-3 gap-2">
            {FORM_NAMES.map((n, i) => (
              <button
                key={n}
                title={FORM_DESCS[i]}
                onMouseEnter={() => setHover({ form: i as PitchingForm, mode: 'PITCH' })}
                onMouseLeave={clear}
                onClick={() => {
                  setMode('PITCH');
                  commit({ form: i as PitchingForm });
                }}
                className={`${pick(player.form === i)} px-2 py-2 text-center text-xs font-semibold`}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            {FORM_DESCS[shown.form]} · 릴리스 포인트가 달라져 타자가 보는 궤적이 바뀝니다.
          </p>
        </section>

        <section className="panel p-5">
          <h3 className="mb-3 font-bold">배트</h3>
          <div className="space-y-2">
            {BAT_DEFS.map((b) => (
              <button
                key={b.id}
                onMouseEnter={() => setHover({ gear: { bat: b.id }, mode: 'BAT' })}
                onMouseLeave={clear}
                onClick={() => {
                  setMode('BAT');
                  commit({}, { bat: b.id });
                }}
                className={`${pick(g.bat === b.id)} flex w-full items-center justify-between px-3 py-2 text-sm`}
              >
                <span className="font-semibold">{b.ko}</span>
                <span className="text-xs text-slate-400">
                  컨택 {b.contactMod >= 0 ? '+' : ''}
                  {b.contactMod} · 파워 {b.powerMod >= 0 ? '+' : ''}
                  {b.powerMod}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-3">
            <label className="field-label">배트 색상</label>
            <input
              type="color"
              value={colors.bat}
              onChange={(e) => setColor('bat', e.target.value)}
              className="h-10 w-full cursor-pointer rounded-lg border border-white/10 bg-transparent"
            />
          </div>
        </section>

        <section className="panel p-5">
          <h3 className="mb-3 font-bold">글러브</h3>
          <div className="space-y-2">
            {GLOVE_DEFS.map((b) => (
              <button
                key={b.id}
                onMouseEnter={() => setHover({ gear: { glove: b.id }, mode: 'FIELD' })}
                onMouseLeave={clear}
                onClick={() => {
                  setMode('FIELD');
                  commit({}, { glove: b.id });
                }}
                className={`${pick(g.glove === b.id)} flex w-full items-center justify-between px-3 py-2 text-sm`}
              >
                <span className="font-semibold">{b.ko}</span>
                <span className="text-xs text-slate-400">수비 +{b.fieldMod}</span>
              </button>
            ))}
          </div>
          <div className="mt-3">
            <label className="field-label">글러브 색상</label>
            <input
              type="color"
              value={colors.glove}
              onChange={(e) => setColor('glove', e.target.value)}
              className="h-10 w-full cursor-pointer rounded-lg border border-white/10 bg-transparent"
            />
          </div>
        </section>

        <section className="panel p-5 sm:col-span-2">
          <h3 className="mb-3 font-bold">액세서리</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {ACCESSORY_DEFS.map((a) => (
              <button
                key={a.id}
                onMouseEnter={() => setHover({ gear: { accessory: a.id } })}
                onMouseLeave={clear}
                onClick={() => commit({}, { accessory: a.id })}
                className={`${pick(g.accessory === a.id)} px-3 py-2`}
              >
                <div className="text-sm font-semibold">{a.ko}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{a.desc}</div>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* ---- 미리보기 ---- */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <section className="panel p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-bold">미리보기</h3>
            <div className="flex gap-0.5 rounded-lg bg-white/5 p-0.5">
              {PREVIEW_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-bold transition ${
                    shownMode === m.id
                      ? 'bg-lime-500/25 text-lime-200'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m.ko}
                </button>
              ))}
            </div>
          </div>

          <PlayerPreview player={shown} uniform={uniform} mode={shownMode} />

          <dl className="mt-3 space-y-1 text-[11px]">
            {shown.kind === 'BATTER' && (
              <PreviewRow label="체형" value={BODY_BY_ID[shown.body ?? 'NORMAL'].ko} />
            )}
            <PreviewRow label="타격 자세" value={STANCE_NAMES[shown.stance]} />
            <PreviewRow label="피칭 자세" value={FORM_NAMES[shown.form]} />
            <PreviewRow label="배트" value={bat.ko} swatch={shown.gear.batColor} />
            <PreviewRow label="글러브" value={glove.ko} swatch={shown.gear.gloveColor} />
            <PreviewRow label="액세서리" value={accessory.ko} />
          </dl>

          <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
            <Chip label="컨택" v={bat.contactMod} />
            <Chip label="파워" v={bat.powerMod + bodyMod(shown).power} />
            <Chip label="스피드" v={bodyMod(shown).speed} />
            <Chip label="수비" v={glove.fieldMod} />
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            항목에 마우스를 올리면 적용 전에 미리 볼 수 있습니다.
          </p>
        </section>
      </aside>
    </div>
  );
}

function PreviewRow({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-white/[0.04] px-2.5 py-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="flex items-center gap-1.5 font-semibold text-slate-200">
        {swatch && (
          <span
            className="h-3 w-3 rounded-full border border-white/20"
            style={{ background: swatch }}
          />
        )}
        {value}
      </dd>
    </div>
  );
}

function Chip({ label, v }: { label: string; v: number }) {
  const tone = v > 0 ? 'text-lime-300' : v < 0 ? 'text-rose-300' : 'text-slate-400';
  return (
    <div className="rounded-lg bg-white/5 py-1.5">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-sm font-black tabular ${tone}`}>
        {v > 0 ? '+' : ''}
        {v}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * 타순 · 선발 로테이션.
 *
 * 타순에는 타자만 들어간다 (DH 미사용이면 투수 한 자리가 생기지만 그건 엔진이 채운다).
 * 선발은 정확히 4명이며, 로테이션 순서대로 경기마다 한 명씩 돌아가며 등판한다.
 */
function LineupTab({
  team,
  useDH,
  onChange,
  onMessage,
}: {
  team: Team;
  useDH: boolean;
  onChange: (t: Team, msg?: string) => void;
  onMessage: (m: string) => void;
}) {
  const byId = (id: string) => team.players.find((p) => p.id === id);
  const [swapSlot, setSwapSlot] = useState<number | null>(null);

  const bench = team.players.filter(
    (p) => p.kind === 'BATTER' && !team.lineup.includes(p.id),
  );
  const bullpen = team.players.filter(
    (p) => p.kind === 'PITCHER' && !team.rotation.includes(p.id),
  );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="panel p-5">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="font-bold">타순</h3>
          <div className="flex-1" />
          <button
            className="btn !px-2 !py-1 !text-[11px]"
            onClick={() => onChange(resetAssignments(team, useDH), '자동 편성했습니다.')}
          >
            자동 편성
          </button>
        </div>
        <div className="space-y-1.5">
          {team.lineup.map((id, i) => {
            const p = byId(id);
            const picking = swapSlot === i;
            return (
              <div key={`${id}-${i}`}>
                <div
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
                    picking ? 'bg-lime-500/20' : 'bg-white/5'
                  }`}
                >
                  <span className="w-5 text-sm font-black text-lime-400">{i + 1}</span>
                  {p && <TierBadge player={p} />}
                  <span className="flex-1 truncate text-sm font-semibold">
                    {p?.name ?? '—'}
                    {p?.injury && <span className="ml-1 text-[11px] text-rose-400">🩹</span>}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {p ? POSITION_KO[p.position] : ''}
                  </span>
                  <div className="flex gap-1">
                    <button
                      className="btn !px-2 !py-0.5 !text-xs"
                      onClick={() => onChange(moveLineup(team, i, -1))}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      className="btn !px-2 !py-0.5 !text-xs"
                      onClick={() => onChange(moveLineup(team, i, 1))}
                      disabled={i === team.lineup.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className="btn !px-2 !py-0.5 !text-xs"
                      onClick={() => setSwapSlot(picking ? null : i)}
                    >
                      {picking ? '취소' : '교체'}
                    </button>
                  </div>
                </div>

                {picking && (
                  <div className="mt-1 flex flex-wrap gap-1.5 rounded-lg bg-white/[0.03] p-2">
                    {bench.length === 0 && (
                      <span className="text-[11px] text-slate-500">벤치에 남은 타자가 없습니다.</span>
                    )}
                    {bench.map((b) => (
                      <button
                        key={b.id}
                        className="btn !px-2 !py-1 !text-[11px]"
                        onClick={() => {
                          const r = swapIntoLineup(team, i, b.id);
                          setSwapSlot(null);
                          if (r.ok) onChange(r.team, r.message);
                          else onMessage(r.message);
                        }}
                      >
                        {b.name} · {POSITION_KO[b.position]}
                        {b.injury && (
                          <span className="ml-1 text-rose-300">
                            (−{Math.round(injuryPenalty(b) * 100)}%)
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          «교체»를 누르고 벤치 선수를 고르면 그 자리와 맞바뀝니다. 경기 중 대타·대주자·대수비는
          여기 들어가지 않은 벤치 선수 중에서 고릅니다.
        </p>
      </section>

      <section className="panel p-5">
        <h3 className="mb-1 font-bold">
          선발 로테이션
          <span className="ml-2 text-xs font-normal text-slate-500">
            {team.rotation.length} / {ROTATION_SIZE}명
          </span>
        </h3>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          경기마다 위에서부터 한 명씩 돌아가며 등판합니다. 스태미나는 경기 사이에 이월되므로
          한 명으로 전 경기를 끌 수 없습니다. 선발을 바꾸려면 각 투수의 역할을 조정하세요.
        </p>
        <div className="space-y-1.5">
          {team.rotation.map((id, i) => {
            const p = byId(id);
            const next = i === team.rotationIndex % Math.max(1, team.rotation.length);
            return (
              <div
                key={id}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
                  next ? 'bg-amber-500/15' : 'bg-white/5'
                }`}
              >
                <span className="w-5 text-sm font-black text-amber-400">{i + 1}</span>
                {p && <TierBadge player={p} />}
                <span className="flex-1 truncate text-sm font-semibold">
                  {p?.name ?? '—'}
                  {next && <span className="ml-1.5 text-[10px] text-amber-300">다음 등판</span>}
                  {p?.injury && <span className="ml-1 text-[11px] text-rose-400">🩹</span>}
                </span>
                <span className="text-[11px] text-slate-500">
                  스태미나 {Math.round((1 - (p?.fatigue ?? 0)) * 100)}%
                </span>
                <div className="flex gap-1">
                  <button
                    className="btn !px-2 !py-0.5 !text-xs"
                    onClick={() => onChange(moveRotation(team, i, -1))}
                    disabled={i === 0}
                  >
                    ↑
                  </button>
                  <button
                    className="btn !px-2 !py-0.5 !text-xs"
                    onClick={() => onChange(moveRotation(team, i, 1))}
                    disabled={i === team.rotation.length - 1}
                  >
                    ↓
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <h4 className="mb-2 mt-4 text-sm font-bold text-slate-300">불펜</h4>
        <div className="space-y-1">
          {bullpen.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5">
              <TierBadge player={p} />
              <span className="flex-1 truncate text-sm">{p.name}</span>
              <select
                className="!w-auto !py-0.5 !text-[11px]"
                value={p.role ?? 'RP'}
                onChange={(e) => {
                  const r = setPitcherRole(team, p.id, e.target.value as PitcherRole);
                  if (r.ok) onChange(r.team, r.message);
                  else onMessage(r.message);
                }}
              >
                {PITCHER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_KO[role]}
                  </option>
                ))}
              </select>
              <span className="w-10 text-right text-[11px] text-slate-500">
                {Math.round((1 - (p.fatigue ?? 0)) * 100)}%
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          {ROLE_KO.RP}: {ROLE_DESC.RP}
          <br />
          {ROLE_KO.CP}: {ROLE_DESC.CP}
        </p>
      </section>
    </div>
  );
}
