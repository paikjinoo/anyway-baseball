'use client';

import { useMemo, useState } from 'react';
import { TeamLogo } from '@/components/ui/TeamLogo';
import { hitterScore, pitcherScore } from '@/lib/game/generator';
import {
  isValidRelayRoundCount,
  validRelayRoundCounts,
  type RelayLobbyPlayer,
  type RelayPick,
  type RelayRoomRules,
} from '@/lib/game/relay';
import type { Team } from '@/lib/game/types';
import type { ConnState } from '@/lib/net/webrtc';

const CONN_LABEL: Record<ConnState, string> = {
  idle: '준비 중…',
  creating: '방을 만드는 중…',
  waiting: '참가자를 기다리는 중…',
  connecting: '연결 중…',
  connected: '연결됨',
  failed: '연결 실패',
  closed: '연결 종료',
};

export function RelayRoomView({
  roomId,
  conn,
  players,
  myUid,
  hostUid,
  myTeam,
  pick,
  onPickChange,
  ready,
  onReadyChange,
  rules,
  onRulesChange,
  error,
  isHost,
  onStart,
  onLeave,
}: {
  roomId: string | null;
  conn: ConnState;
  players: RelayLobbyPlayer[];
  myUid: string;
  hostUid: string;
  myTeam: Team;
  pick: RelayPick;
  onPickChange: (pick: RelayPick) => void;
  ready: boolean;
  onReadyChange: (ready: boolean) => void;
  rules: RelayRoomRules;
  onRulesChange?: (rules: RelayRoomRules) => void;
  error: string | null;
  isHost: boolean;
  onStart?: () => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const connected = players.filter((p) => p.connected);
  const validRounds = validRelayRoundCounts(connected.length);
  const roundValid = isValidRelayRoundCount(connected.length, rules.roundCount);
  const allReady = connected.length >= 2 && connected.every((p) => p.ready) && roundValid;
  const pickComplete = !!pick.batterId && !!pick.pitcherId;

  return (
    <div className="mx-auto max-w-3xl space-y-4 py-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-black">릴레이 타격 대결</h1>
        <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-slate-300">
          {connected.length}/7명
        </span>
      </div>

      <section className="panel p-5">
        <div className="mb-3 flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              conn === 'connected'
                ? 'bg-emerald-400'
                : conn === 'failed'
                  ? 'bg-rose-400'
                  : 'bg-amber-400 flash'
            }`}
          />
          <span className="text-sm font-semibold">{CONN_LABEL[conn]}</span>
        </div>
        {roomId && isHost && (
          <>
            <label className="field-label">방 코드 (최대 6명에게 전달)</label>
            <div className="flex gap-2">
              <input type="text" readOnly value={roomId} onFocus={(e) => e.currentTarget.select()} />
              <button
                className="btn shrink-0"
                onClick={() => {
                  void navigator.clipboard.writeText(roomId);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? '복사됨' : '복사'}
              </button>
            </div>
          </>
        )}
        {!isHost && roomId && <p className="text-xs text-slate-500">방 코드: {roomId}</p>}
        {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 font-bold">참가자</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {players.map((player, index) => (
            <div
              key={player.uid}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                player.ready ? 'border-lime-400/40 bg-lime-500/10' : 'border-white/10 bg-white/[0.03]'
              } ${player.connected ? '' : 'opacity-45'}`}
            >
              <span className="w-5 text-center text-xs font-black text-slate-500">{index + 1}</span>
              <TeamLogo
                logoId={player.logoId}
                primary={player.primaryColor}
                secondary={player.secondaryColor}
                size={30}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <b className="truncate text-sm">{player.name}</b>
                  {player.uid === myUid && <span className="rounded bg-white/10 px-1 text-[9px]">나</span>}
                  {player.uid === hostUid && <span className="rounded bg-amber-400/20 px-1 text-[9px] text-amber-200">방장</span>}
                </div>
                <div className="truncate text-[10px] text-slate-500">
                  {player.teamName} · 타자 {player.pickedBatter || '-'} · 투수 {player.pickedPitcher || '-'}
                </div>
              </div>
              <span className={`text-[10px] font-bold ${player.ready ? 'text-lime-300' : 'text-slate-500'}`}>
                {!player.connected ? '이탈' : player.ready ? '준비' : '선택 중'}
              </span>
            </div>
          ))}
          {Array.from({ length: Math.max(0, 2 - players.length) }, (_, i) => (
            <div key={`empty-${i}`} className="rounded-xl border border-dashed border-white/10 px-4 py-3 text-xs text-slate-600">
              참가자 대기 중…
            </div>
          ))}
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="mb-1 font-bold">경기 규칙</h2>
        <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
          한 라운드에 한 명이 투수, 나머지가 각 1타석을 진행합니다. 모두의 기회를 맞추기 위해 현재 인원수의 배수만 선택할 수 있습니다.
        </p>
        {isHost && onRulesChange ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className="field-label">라운드 수</span>
              <select
                value={rules.roundCount ?? ''}
                disabled={validRounds.length === 0}
                onChange={(e) => onRulesChange({ ...rules, roundCount: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">선택해 주세요</option>
                {validRounds.map((round) => <option key={round} value={round}>{round}라운드</option>)}
              </select>
            </label>
            <label>
              <span className="field-label">투구 체감 속도 {Math.round(rules.pitchSpeedScale * 100)}%</span>
              <input
                type="range"
                min="0.25"
                max="1"
                step="0.05"
                value={rules.pitchSpeedScale}
                onChange={(e) => onRulesChange({ ...rules, pitchSpeedScale: Number(e.target.value) })}
              />
            </label>
          </div>
        ) : (
          <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-300">
            {rules.roundCount ? `${rules.roundCount}라운드` : '라운드 미정'} · 구속 체감 {Math.round(rules.pitchSpeedScale * 100)}%
          </div>
        )}
        {!roundValid && connected.length >= 2 && (
          <p className="mt-2 text-xs text-amber-300">현재 {connected.length}명에 맞는 라운드를 방장이 선택해야 합니다.</p>
        )}
      </section>

      <section className="panel p-5">
        <RelayPickPanel team={myTeam} pick={pick} locked={ready} onChange={onPickChange} />
        <button
          className={`btn mt-4 w-full ${ready ? '' : 'btn-primary'}`}
          disabled={!pickComplete && !ready}
          onClick={() => onReadyChange(!ready)}
        >
          {ready ? '선택 수정하기' : pickComplete ? '준비 완료' : '타자와 투수를 선택해 주세요'}
        </button>
      </section>

      {isHost && onStart && (
        <button className="btn btn-primary w-full !py-3" disabled={!allReady} onClick={onStart}>
          {allReady ? '경기 시작' : connected.length < 2 ? '2명 이상 필요합니다' : '전원 준비와 라운드 선택이 필요합니다'}
        </button>
      )}
      {!isHost && <p className="text-center text-sm text-slate-500">전원이 준비되면 방장이 시작합니다.</p>}
      <button className="btn w-full" onClick={onLeave}>나가기</button>
    </div>
  );
}

function RelayPickPanel({
  team,
  pick,
  locked,
  onChange,
}: {
  team: Team;
  pick: RelayPick;
  locked: boolean;
  onChange: (pick: RelayPick) => void;
}) {
  const batters = useMemo(
    () => team.players.filter((p) => p.position !== 'P').sort((a, b) => hitterScore(b) - hitterScore(a)),
    [team],
  );
  const pitchers = useMemo(
    () => team.players.filter((p) => p.position === 'P' && p.pitching).sort((a, b) => pitcherScore(b) - pitcherScore(a)),
    [team],
  );
  return (
    <div>
      <h2 className="mb-3 font-bold">사용 선수</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="field-label">타자 1명</span>
          <select value={pick.batterId} disabled={locked} onChange={(e) => onChange({ ...pick, batterId: e.target.value })}>
            <option value="">타자 선택</option>
            {batters.map((p) => <option key={p.id} value={p.id}>{p.name} · 컨택 {p.batting.contact} · 파워 {p.batting.power}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">투수 1명</span>
          <select value={pick.pitcherId} disabled={locked} onChange={(e) => onChange({ ...pick, pitcherId: e.target.value })}>
            <option value="">투수 선택</option>
            {pitchers.map((p) => <option key={p.id} value={p.id}>{p.name} · 구종 {Object.keys(p.pitching?.arsenal ?? {}).length} · 체력 {p.pitching?.stamina ?? 0}</option>)}
          </select>
        </label>
      </div>
      <p className="mt-3 text-[11px] text-slate-500">번트·도루·투수 교체는 사용할 수 없습니다.</p>
    </div>
  );
}
