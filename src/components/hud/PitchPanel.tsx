'use client';

import { useEffect, useRef, useState } from 'react';
import { PITCH_DEFS } from '@/lib/game/constants';
import {
  ZONE_CELL_KO,
  arsenalOf,
  screenCellToZoneCell,
  staminaRemaining,
} from '@/lib/game/pitching';
import { effectiveBatSide } from '@/lib/game/batting';
import { battingSide } from '@/lib/game/engine';
import { bullpenCandidates } from '@/lib/game/engine';
import { isPartyMode, isRelayMode, useMatchStore } from '@/lib/store/matchStore';
import { playClick } from '@/lib/audio/sfx';
import { zoneHeatColor } from '@/lib/format';
import type { GameState, PitchType, Player, Side } from '@/lib/game/types';

/** 코스별 약점 오버레이를 띄우기 시작하는 상대 타자의 통산 타수 */
const HEAT_MIN_AB = 30;
/** 칸 하나를 칠하기 시작하는 타수 */
const HEAT_MIN_CELL_AB = 5;
/** 표본이 적은 칸을 전체 타율 쪽으로 끌어당기는 세기 (선수단 화면과 같은 값) */
const HEAT_PRIOR_AB = 8;
/**
 * 경기 중 오버레이의 진하기. 선수단 화면의 1/3 수준이다 —
 * 조준 마커와 존 테두리를 덮어 버리면 코스를 찍기 어려워진다.
 */
const HEAT_STRENGTH = 0.35;

/**
 * 투구 조작 패널.
 * 1) 구종 선택 -> 2) 코스(존 그리드) 클릭 -> 3) 투구
 *
 * mirrored: 지금 카메라에서 존의 좌우가 뒤집혀 보이는가(zoneFlippedOnScreen).
 * 기본 카메라인 투수 시점은 마운드 뒤에서 잡으므로 화면 오른쪽이 3루 쪽인데,
 * 존 좌표 +x는 포수 뒤에서 본 오른쪽(1루 쪽)이다. 그대로 두면 오른쪽을 찍었는데
 * 공은 화면 왼쪽으로 간다.
 */
export function PitchPanel({
  state,
  pitcher,
  batter,
  playerSide,
  mirrored,
}: {
  state: GameState;
  pitcher: Player;
  /** 지금 타석의 타자. 코스별 약점 오버레이에만 쓴다. */
  batter: Player;
  playerSide: Side;
  mirrored: boolean;
}) {
  const throwPitch = useMatchStore((s) => s.throwPitch);
  const setPitchPreview = useMatchStore((s) => s.setPitchPreview);
  const substitutePitcher = useMatchStore((s) => s.substitutePitcher);
  const waiting = useMatchStore((s) => s.waitingRemote);
  const mode = useMatchStore((s) => s.mode);
  const party = isPartyMode(mode);
  const relay = isRelayMode(mode);
  const owners = useMatchStore((s) => s.owners);
  const myUid = useMatchStore((s) => s.myUid);

  const arsenal = arsenalOf(pitcher);
  const [type, setType] = useState<PitchType>(arsenal[0]?.type ?? 'FOURSEAM');
  const [target, setTarget] = useState({ x: 0, y: 0 });
  const [quick, setQuick] = useState(false);
  const [showBullpen, setShowBullpen] = useState(false);
  const [showHeat, setShowHeat] = useState(true);
  const zoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!arsenal.some((a) => a.type === type)) setType(arsenal[0]?.type ?? 'FOURSEAM');
  }, [arsenal, type]);

  // 고르는 대로 3D 화면(스트라이크존)에 예상 궤적을 그린다.
  // 패널이 사라지면(투구·교대·관전 전환) 같이 지운다.
  useEffect(() => {
    setPitchPreview({ type, targetX: target.x, targetY: target.y, quickPitch: quick });
  }, [setPitchPreview, type, target.x, target.y, quick]);
  useEffect(() => () => setPitchPreview(null), [setPitchPreview]);

  const pitches = state[playerSide].pitcherPitches;
  const stam = staminaRemaining(pitcher, pitches);
  const runnersOn = state.bases.some(Boolean);

  // 패널의 좌우를 화면과 같은 방향으로 맞추는 부호. 존 좌표 <-> 패널 좌표 양쪽에
  // 똑같이 곱하므로(±1) 찍은 자리에 마커가 그대로 남는다.
  const sx = mirrored ? -1 : 1;

  function pickFromEvent(e: React.PointerEvent<HTMLDivElement>) {
    const el = zoneRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 패널은 존의 1.7배 범위를 보여준다 (존 밖 유인구 가능)
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = 1 - ((e.clientY - r.top) / r.height) * 2;
    setTarget({ x: sx * nx * 1.7, y: ny * 1.7 });
  }

  const attr = pitcher.pitching?.arsenal[type];

  // 상대 타자의 통산 코스별 기록. roster의 zoneSplits는 이번 경기 델타라 쓸 수 없어서,
  // 경기 시작 시점 스냅샷을 따로 들고 다닌다 (@see engine.toTeamInGame).
  // 온라인에서도 START가 GameState를 통째로 보내므로 프로토콜 추가 없이 그대로 온다.
  const heat = state[battingSide(state)].scoutZones?.[batter.id];
  const heatAb = heat ? heat.ab.reduce((a, b) => a + b, 0) : 0;
  const heatBase = heat && heatAb ? heat.h.reduce((a, b) => a + b, 0) / heatAb : 0;
  // 표본이 얇으면 토글 자체를 감춘다 — 신생 팀 상대에서는 지금과 완전히 같은 화면이 된다.
  const canShowHeat = !!heat && heatAb >= HEAT_MIN_AB;
  const batSide = effectiveBatSide(batter, pitcher);

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] text-slate-500">투수</div>
          <div className="font-bold">{pitcher.name}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-slate-500">투구 수 {pitches}</div>
          <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.round(stam * 100)}%`,
                background: stam > 0.5 ? '#4ade80' : stam > 0.2 ? '#fbbf24' : '#f87171',
              }}
            />
          </div>
        </div>
      </div>

      {/* 구종 */}
      <div>
        <div className="field-label">구종</div>
        <div className="grid grid-cols-3 gap-1.5">
          {arsenal.map(({ type: t, attr: a, def }) => (
            <button
              key={t}
              onClick={() => {
                setType(t as PitchType);
                playClick();
              }}
              className={`rounded-lg border px-2 py-1.5 text-left transition ${
                type === t ? 'border-2' : 'border border-white/10 bg-white/[0.03] hover:bg-white/[0.08]'
              }`}
              style={type === t ? { borderColor: def.color, background: def.color + '22' } : undefined}
            >
              <div className="text-xs font-bold" style={{ color: def.color }}>
                {def.ko}
              </div>
              <div className="text-[10px] text-slate-500">
                {def.baseVelo + Math.round((def.veloRange * a.velocity) / 99)}km/h · 제구{a.control}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 코스 */}
      <div>
        <div className="flex items-center justify-between">
          <div className="field-label">코스 (클릭)</div>
          {canShowHeat && (
            <button
              type="button"
              onClick={() => setShowHeat((v) => !v)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                showHeat ? 'bg-lime-400/15 text-lime-300' : 'text-slate-500'
              }`}
            >
              약점 {showHeat ? '표시' : '숨김'}
            </button>
          )}
        </div>
        <div
          ref={zoneRef}
          onPointerDown={pickFromEvent}
          className="relative mx-auto aspect-square w-full max-w-[190px] cursor-crosshair rounded-lg border border-white/10 bg-slate-950/70"
        >
          {/* 스트라이크존 (전체의 1/1.7) */}
          <div
            className="absolute border-2 border-amber-400/70"
            style={{
              left: `${((1 - 1 / 1.7) / 2) * 100}%`,
              top: `${((1 - 1 / 1.7) / 2) * 100}%`,
              width: `${(1 / 1.7) * 100}%`,
              height: `${(1 / 1.7) * 100}%`,
            }}
          >
            <div className="grid h-full w-full grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }, (_, i) => {
                const cell = screenCellToZoneCell(i, batSide, mirrored);
                const ab = heat?.ab[cell] ?? 0;
                const paint = canShowHeat && showHeat && ab >= HEAT_MIN_CELL_AB;
                return (
                  <div
                    key={i}
                    className="border border-amber-400/20"
                    style={
                      paint
                        ? {
                            background: zoneHeatColor(
                              (heat!.h[cell] + heatBase * HEAT_PRIOR_AB) / (ab + HEAT_PRIOR_AB),
                              HEAT_STRENGTH,
                            ),
                          }
                        : undefined
                    }
                    title={paint ? `${ZONE_CELL_KO[cell]} ${heat!.h[cell]}/${ab}` : undefined}
                  />
                );
              })}
            </div>
          </div>
          {/* 목표 마커 */}
          <div
            className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-lime-400 bg-lime-400/25"
            style={{
              left: `${(((sx * target.x) / 1.7 + 1) / 2) * 100}%`,
              top: `${((1 - target.y / 1.7) / 2) * 100}%`,
            }}
          />
        </div>
        {/* 어느 쪽이 어느 베이스인지. 카메라를 바꾸면 패널도 같이 뒤집히므로 표시해 둔다. */}
        <div className="mx-auto mt-1 flex w-full max-w-[190px] justify-between text-[9px] text-slate-600">
          <span>{mirrored ? '1루' : '3루'}</span>
          <span>{mirrored ? '3루' : '1루'}</span>
        </div>
        {attr && (
          <p className="mt-1.5 text-center text-[10px] leading-relaxed text-slate-500">
            예상 궤적은 화면 중앙 존에 표시됩니다
            <br />
            제구 {attr.control} — 공은 그 원 안쪽으로 흩어집니다
          </p>
        )}
      </div>

      {runnersOn && (
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={quick}
            onChange={(e) => setQuick(e.target.checked)}
            className="h-4 w-4 accent-lime-500"
          />
          퀵모션 (도루 저지 유리, 제구 불리)
        </label>
      )}

      <button
        className="btn btn-primary w-full"
        disabled={waiting}
        onClick={() => {
          playClick();
          throwPitch({ type, targetX: target.x, targetY: target.y, quickPitch: quick });
        }}
      >
        {waiting ? '상대 대기 중…' : '투구!'}
      </button>

      {!relay && (
        <>
          <button className="btn w-full !py-1.5 !text-xs" onClick={() => setShowBullpen((v) => !v)}>
            투수 교체 {showBullpen ? '닫기' : party ? '(내 투수만)' : '열기'}
          </button>
          {showBullpen && (
            <div className="max-h-40 space-y-1 overflow-y-auto">
          {/* 2대2에서는 자기 투수만 올릴 수 있다 */}
          {bullpenCandidates(state, playerSide)
            .filter((p) => !party || owners[p.id] === myUid)
            .map((p) => (
              <button
                key={p.id}
                className="flex w-full items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                onClick={() => {
                  substitutePitcher(p.id);
                  setShowBullpen(false);
                }}
              >
                <span className="font-semibold">{p.name}</span>
                <span className="text-slate-500">스태미나 {p.pitching?.stamina ?? 0}</span>
              </button>
            ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
