'use client';

import { useState } from 'react';
import { SeatBoard } from './SeatBoard';
import { DraftPanel } from './DraftPanel';
import { picksComplete } from '@/lib/game/allstar';
import { RuleSettings } from '@/components/settings/RuleSettings';
import type { ConnState } from '@/lib/net/webrtc';
import type { PartyPicks, PartySeat } from '@/lib/net/protocol';
import { describeRules, type MatchRules, type Team } from '@/lib/game/types';

const CONN_LABEL: Record<ConnState, string> = {
  idle: '준비 중…',
  creating: '방을 만드는 중…',
  waiting: '상대를 기다리는 중…',
  connecting: '연결 중…',
  connected: '연결됨',
  failed: '연결 실패',
  closed: '연결 종료',
};

/** 2대2 대기실 화면. 호스트/게스트 페이지가 공유한다. */
export function PartyRoomView({
  roomId,
  conn,
  seats,
  myUid,
  hostUid,
  myTeam,
  picks,
  onPicksChange,
  ready,
  onReadyChange,
  error,
  rules,
  onRulesChange,
  isHost,
  onSwapSide,
  onShuffle,
  onStart,
  onLeave,
}: {
  roomId: string | null;
  conn: ConnState;
  seats: PartySeat[];
  myUid: string;
  hostUid: string;
  myTeam: Team;
  picks: PartyPicks;
  onPicksChange: (p: PartyPicks) => void;
  ready: boolean;
  onReadyChange: (v: boolean) => void;
  error: string | null;
  /** 이 방의 경기 규칙. 게스트는 방장이 보내 주기 전까지 null이다. */
  rules: MatchRules | null;
  /** 방장만 넘긴다 */
  onRulesChange?: (patch: Partial<MatchRules>) => void;
  isHost: boolean;
  onSwapSide?: (uid: string) => void;
  onShuffle?: () => void;
  onStart?: () => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const mySeat = seats.find((s) => s.uid === myUid);
  const slot = mySeat?.slot ?? 0;
  const complete = picksComplete(picks, slot);
  const filled = seats.filter((s) => s.connected).length;
  const allReady = filled === 4 && seats.every((s) => s.ready && s.connected);

  return (
    <div className="mx-auto max-w-3xl space-y-4 py-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-black">2대2 올스타전</h1>
        <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-slate-300">
          {filled}/4명
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

        {isHost && roomId && (
          <>
            <label className="field-label">방 코드 (팀원·상대 3명에게 전달)</label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={roomId}
                onFocus={(e) => e.currentTarget.select()}
              />
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

        {error && (
          <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="mb-1 font-bold">이 경기의 규칙</h2>
        {isHost && rules && onRulesChange ? (
          <>
            <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
              방장이 정한 규칙이 이 경기에만 적용됩니다. 올스타전은 야수 9명으로 타순을 짜므로
              지명타자는 항상 켜집니다.
            </p>
            <RuleSettings value={rules} onChange={onRulesChange} hideDH compact />
          </>
        ) : (
          <p className="mt-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-300">
            {describeRules(rules ?? undefined)}
          </p>
        )}
      </section>

      <section className="panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-bold">자리</h2>
          {isHost && onShuffle && (
            <button className="btn !py-1 !text-xs" onClick={onShuffle}>
              자리 섞기
            </button>
          )}
        </div>
        <SeatBoard seats={seats} myUid={myUid} hostUid={hostUid} onSwapSide={onSwapSide} />
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          같은 편 두 사람이 각자 자기 팀에서 선수를 골라 한 팀을 만듭니다. 타석에 내 선수가 서면 그때만
          조작하고, 팀원의 선수일 때는 관전합니다. 선발 투수는 두 사람의 투수를 섞어 무작위로 뽑습니다.
        </p>
      </section>

      <section className="panel p-5">
        <DraftPanel
          team={myTeam}
          slot={slot}
          picks={picks}
          onChange={(p) => {
            onPicksChange(p);
            if (ready) onReadyChange(false);
          }}
          locked={ready}
        />
        <button
          className={`btn mt-4 w-full ${ready ? '' : 'btn-primary'}`}
          disabled={!complete && !ready}
          onClick={() => onReadyChange(!ready)}
        >
          {ready ? '선택 수정하기' : complete ? '준비 완료' : '선수를 더 골라주세요'}
        </button>
      </section>

      {isHost && onStart && (
        <button className="btn btn-primary w-full !py-3" disabled={!allReady} onClick={onStart}>
          {allReady ? '경기 시작' : `모두 준비되면 시작할 수 있습니다 (${filled}/4명)`}
        </button>
      )}
      {!isHost && (
        <p className="text-center text-sm text-slate-500">
          {allReady ? '방장이 경기를 시작하기를 기다리는 중…' : '모두 준비되면 방장이 시작합니다.'}
        </p>
      )}

      <button className="btn w-full" onClick={onLeave}>
        나가기
      </button>
    </div>
  );
}
