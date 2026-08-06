'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { saveTeam } from '@/lib/firebase/store';
import {
  ACCESSORY_DEFS,
  BAT_DEFS,
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
import { arsenalOf } from '@/lib/game/pitching';
import { hitterScore, pitcherScore } from '@/lib/game/generator';
import {
  BATTING_KEYS,
  BATTING_KEY_DESC,
  BATTING_KEY_KO,
  PITCH_ATTR_DESC,
  PITCH_ATTR_KO,
  STAMINA_DESC,
  learnPitch,
  learnPitchCost,
  learnablePitchesFor,
  pitchUpgradeCost,
  statUpgradeCost,
  trainBatting,
  trainPitch,
  trainStamina,
} from '@/lib/game/training';
import type {
  BattingStance,
  Gear,
  PitchType,
  PitchingForm,
  Player,
  Team,
} from '@/lib/game/types';
import { baseballRate } from '@/lib/format';

export default function RosterPage() {
  const team = useActiveTeam();
  const upsertTeam = useAppStore((s) => s.upsertTeam);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<'stats' | 'train' | 'gear' | 'lineup'>('stats');

  useEffect(() => {
    if (team && (!selectedId || !team.players.some((p) => p.id === selectedId))) {
      setSelectedId(team.players[0]?.id ?? null);
    }
  }, [team, selectedId]);

  const selected = team?.players.find((p) => p.id === selectedId) ?? null;

  const sorted = useMemo(() => {
    if (!team) return [];
    return team.players.slice().sort((a, b) => {
      const order = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
      const d = order.indexOf(a.position) - order.indexOf(b.position);
      return d !== 0 ? d : a.number - b.number;
    });
  }, [team]);

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
    return <div className="py-20 text-center text-slate-500">먼저 팀을 만들어 주세요.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black">{team.name} 선수단</h1>
        <span className="rounded-lg bg-amber-500/15 px-3 py-1 text-sm font-bold text-amber-300">
          팀 훈련 P {team.players.reduce((a, p) => a + p.trainingPoints, 0)}
        </span>
      </div>

      {msg && (
        <div className="rounded-xl border border-lime-500/30 bg-lime-500/10 px-4 py-2 text-sm text-lime-200">
          {msg}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* 선수 목록 */}
        <div className="panel max-h-[70vh] overflow-y-auto p-2">
          {sorted.map((p) => {
            const isP = p.position === 'P';
            const score = Math.round(isP ? pitcherScore(p) / 2.9 : hitterScore(p) / 4.9);
            return (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
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
                  <span className="block truncate text-sm font-semibold">{p.name}</span>
                  <span className="block text-[11px] text-slate-500">
                    {POSITION_KO[p.position]} · {p.bats}/{p.throws}
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
              <div className="panel p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <div
                    className="grid h-16 w-16 place-items-center rounded-xl text-2xl font-black"
                    style={{ background: team.primaryColor, color: team.secondaryColor }}
                  >
                    {selected.number}
                  </div>
                  <div className="flex-1">
                    <input
                      type="text"
                      className="!w-auto !bg-transparent !border-transparent !px-0 !text-2xl !font-black"
                      value={selected.name}
                      maxLength={12}
                      onChange={(e) => updatePlayer({ ...selected, name: e.target.value })}
                    />
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <select
                        className="!w-auto !py-1 !text-xs"
                        value={selected.position}
                        onChange={(e) =>
                          updatePlayer({ ...selected, position: e.target.value as Player['position'] })
                        }
                      >
                        {Object.entries(POSITION_KO).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                      <span>타석 {selected.bats}</span>
                      <span>투구 {selected.throws}</span>
                      <span>잠재력 {selected.potential}</span>
                    </div>
                  </div>
                  <div className="rounded-xl bg-amber-500/15 px-4 py-2 text-center">
                    <div className="text-[11px] text-amber-200/70">훈련 포인트</div>
                    <div className="text-xl font-black text-amber-300">{selected.trainingPoints}</div>
                  </div>
                </div>
              </div>

              <div className="flex gap-1 rounded-xl bg-white/5 p-1">
                {(
                  [
                    ['stats', '능력치'],
                    ['train', '훈련'],
                    ['gear', '커스터마이징'],
                    ['lineup', '타순·로테이션'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
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
                  onChange={(p, m) => updatePlayer(p, m)}
                  onMessage={setMsg}
                />
              )}
              {tab === 'gear' && (
                <GearTab player={selected} team={team} onChange={(p) => updatePlayer(p)} />
              )}
              {tab === 'lineup' && <LineupTab team={team} onChange={(t) => void commit(t, '저장했습니다.')} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Bar({
  label,
  value,
  max = 99,
  marker,
}: {
  label: string;
  value: number;
  max?: number;
  /** 설명을 펼칠 수 있는 항목에 붙는 화살표 */
  marker?: string;
}) {
  const pct = Math.round((value / max) * 100);
  const color = value >= 80 ? '#f43f5e' : value >= 65 ? '#f59e0b' : value >= 50 ? '#38bdf8' : '#64748b';
  return (
    <div className="flex items-center gap-3">
      <span className="flex w-20 shrink-0 items-center gap-1 text-xs text-slate-400">
        {label}
        {marker && <span className="text-[11px] leading-none text-slate-500">{marker}</span>}
      </span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/8">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="w-8 shrink-0 text-right text-sm font-bold tabular">{value}</span>
    </div>
  );
}

function StatsTab({ player }: { player: Player }) {
  const arsenal = arsenalOf(player);
  const isP = player.position === 'P';
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="panel p-5">
        <h3 className="mb-3 font-bold">타자 능력치</h3>
        <div className="space-y-2.5">
          {BATTING_KEYS.map((k) => (
            <Bar key={k} label={BATTING_KEY_KO[k]} value={player.batting[k]} />
          ))}
        </div>
      </section>

      {(isP || arsenal.length > 1) && (
        <section className="panel p-5">
          <h3 className="mb-3 font-bold">
            투수 능력치
            <span className="ml-2 text-xs font-normal text-slate-500">
              스태미나 {player.pitching?.stamina ?? 0}
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
                  <Bar label="구속" value={attr.velocity} />
                  <Bar label="제구" value={attr.control} />
                  <Bar label="무브먼트" value={attr.movement} />
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
  open,
  onToggle,
  onTrain,
}: {
  label: string;
  value: number;
  desc: string;
  cost: number;
  points: number;
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
          <Bar label={label} value={value} marker={open ? '▲' : '▼'} />
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
  onChange,
  onMessage,
}: {
  player: Player;
  onChange: (p: Player, msg?: string) => void;
  onMessage: (m: string) => void;
}) {
  const arsenal = arsenalOf(player);
  const learnable = learnablePitchesFor(player);
  /** 설명을 펼친 항목. 같은 항목을 다시 누르면 접힌다. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (k: string) => setOpenKey((cur) => (cur === k ? null : k));

  return (
    <div className="space-y-4">
      <section className="panel p-5">
        <h3 className="mb-1 font-bold">타자 훈련</h3>
        <p className="mb-4 text-xs text-slate-500">
          능력치가 높을수록 1 올리는 비용이 급격히 커집니다. 잠재력({player.potential})이 상한입니다.
          <br />
          능력치 이름을 누르면 그 능력치가 높을 때 무엇이 좋아지는지 볼 수 있습니다.
        </p>
        <div className="space-y-1">
          {BATTING_KEYS.map((k) => (
            <TrainRow
              key={k}
              label={BATTING_KEY_KO[k]}
              value={player.batting[k]}
              desc={BATTING_KEY_DESC[k]}
              cost={statUpgradeCost(player.batting[k], player.potential)}
              points={player.trainingPoints}
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
                cost={statUpgradeCost(player.pitching.stamina, player.potential)}
                points={player.trainingPoints}
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
                        cost={pitchUpgradeCost(attr[key], player.potential, type as PitchType)}
                        points={player.trainingPoints}
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
            <h3 className="mb-1 font-bold">새 구종 습득</h3>
            <p className="mb-4 text-xs text-slate-500">
              직구는 모든 투수가 기본 보유합니다. 변화구는 훈련으로 익힐 수 있으며, 난이도가 높을수록
              비용이 큽니다. 습득 직후 능력치는 낮게 시작합니다.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {learnable.map((t) => {
                const def = PITCH_DEFS[t];
                const cost = learnPitchCost(t, player);
                const can = player.trainingPoints >= cost;
                return (
                  <button
                    key={t}
                    disabled={!can}
                    onClick={() => {
                      const r = learnPitch(player, t, Date.now() >>> 0);
                      if (r.ok) onChange(r.player, r.message);
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
                      <span className="text-xs font-bold text-amber-300">{cost}P</span>
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-slate-500">{def.desc}</div>
                  </button>
                );
              })}
              {learnable.length === 0 && (
                <p className="text-sm text-slate-500">모든 구종을 보유하고 있습니다.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** 마우스를 올린 항목을 실제로 적용하지 않고 미리보기에만 반영한다. */
interface HoverPatch {
  mode?: PreviewMode;
  stance?: BattingStance;
  form?: PitchingForm;
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
  const [mode, setMode] = useState<PreviewMode>(player.position === 'P' ? 'PITCH' : 'BAT');
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
            <PreviewRow label="타격 자세" value={STANCE_NAMES[shown.stance]} />
            <PreviewRow label="피칭 자세" value={FORM_NAMES[shown.form]} />
            <PreviewRow label="배트" value={bat.ko} swatch={shown.gear.batColor} />
            <PreviewRow label="글러브" value={glove.ko} swatch={shown.gear.gloveColor} />
            <PreviewRow label="액세서리" value={accessory.ko} />
          </dl>

          <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
            <Chip label="컨택" v={bat.contactMod} />
            <Chip label="파워" v={bat.powerMod} />
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

function LineupTab({ team, onChange }: { team: Team; onChange: (t: Team) => void }) {
  const byId = (id: string) => team.players.find((p) => p.id === id);

  function move(idx: number, dir: -1 | 1) {
    const next = team.lineup.slice();
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange({ ...team, lineup: next });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="panel p-5">
        <h3 className="mb-3 font-bold">타순</h3>
        <div className="space-y-1.5">
          {team.lineup.map((id, i) => {
            const p = byId(id);
            return (
              <div key={id} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
                <span className="w-5 text-sm font-black text-lime-400">{i + 1}</span>
                <span className="flex-1 truncate text-sm font-semibold">{p?.name ?? '—'}</span>
                <span className="text-[11px] text-slate-500">
                  {p ? POSITION_KO[p.position] : ''}
                </span>
                <div className="flex gap-1">
                  <button className="btn !px-2 !py-0.5 !text-xs" onClick={() => move(i, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button
                    className="btn !px-2 !py-0.5 !text-xs"
                    onClick={() => move(i, 1)}
                    disabled={i === team.lineup.length - 1}
                  >
                    ↓
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3">
          <label className="field-label">타순 교체</label>
          <select
            onChange={(e) => {
              const newId = e.target.value;
              if (!newId) return;
              const idx = Number(e.target.dataset.idx ?? -1);
              if (idx < 0) return;
            }}
            defaultValue=""
            className="hidden"
          >
            <option value="" />
          </select>
          <p className="text-[11px] text-slate-500">
            벤치 선수를 넣으려면 아래 목록에서 선택하세요.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {team.players
              .filter((p) => !team.lineup.includes(p.id) && p.position !== 'P')
              .map((p) => (
                <button
                  key={p.id}
                  className="btn !px-2 !py-1 !text-[11px]"
                  onClick={() => {
                    const worst = team.lineup[team.lineup.length - 1];
                    onChange({
                      ...team,
                      lineup: team.lineup.map((x) => (x === worst ? p.id : x)),
                    });
                  }}
                >
                  {p.name} 투입
                </button>
              ))}
          </div>
        </div>
      </section>

      <section className="panel p-5">
        <h3 className="mb-3 font-bold">선발 로테이션</h3>
        <div className="space-y-1.5">
          {team.rotation.map((id, i) => {
            const p = byId(id);
            return (
              <div key={id} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
                <span className="w-5 text-sm font-black text-amber-400">{i + 1}</span>
                <span className="flex-1 truncate text-sm font-semibold">{p?.name ?? '—'}</span>
                <span className="text-[11px] text-slate-500">
                  스태미나 {p?.pitching?.stamina ?? 0}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {team.players
            .filter((p) => p.position === 'P' && !team.rotation.includes(p.id))
            .map((p) => (
              <button
                key={p.id}
                className="btn !px-2 !py-1 !text-[11px]"
                onClick={() =>
                  onChange({ ...team, rotation: [...team.rotation.slice(0, 4), p.id] })
                }
              >
                {p.name} 선발 등록
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}
