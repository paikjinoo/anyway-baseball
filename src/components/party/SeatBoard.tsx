'use client';

import { TeamLogo } from '@/components/ui/TeamLogo';
import { lineupSlotsFor } from '@/lib/game/allstar';
import type { PartySeat } from '@/lib/net/protocol';
import type { Side } from '@/lib/game/types';

/**
 * 2대2 방의 좌석 현황.
 * 원정/홈 각각 두 자리이고, slot 0이 1·3·5·7·9번, slot 1이 2·4·6·8번 타순을 맡는다.
 */
export function SeatBoard({
  seats,
  myUid,
  hostUid,
  onSwapSide,
}: {
  seats: PartySeat[];
  myUid: string;
  hostUid: string;
  /** 호스트만 전달. 그 사람의 편을 반대로 옮긴다. */
  onSwapSide?: (uid: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(['away', 'home'] as Side[]).map((side) => (
        <div key={side} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-300">
              {side === 'away' ? '원정 (선공)' : '홈 (후공)'}
            </span>
            <span className="text-[11px] text-slate-500">
              {seats.filter((s) => s.side === side).length}/2
            </span>
          </div>
          <div className="space-y-1.5">
            {([0, 1] as const).map((slot) => {
              const seat = seats.find((s) => s.side === side && s.slot === slot);
              return (
                <SeatRow
                  key={slot}
                  seat={seat}
                  slot={slot}
                  myUid={myUid}
                  hostUid={hostUid}
                  onSwapSide={onSwapSide}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SeatRow({
  seat,
  slot,
  myUid,
  hostUid,
  onSwapSide,
}: {
  seat?: PartySeat;
  slot: 0 | 1;
  myUid: string;
  hostUid: string;
  onSwapSide?: (uid: string) => void;
}) {
  const orders = lineupSlotsFor(slot).join('·');

  if (!seat) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-white/10 px-3 py-2 text-[11px] text-slate-600">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-white/5">?</span>
        <span>빈 자리 · 타순 {orders}번</span>
      </div>
    );
  }

  const isMe = seat.uid === myUid;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
        seat.ready ? 'border-lime-400/50 bg-lime-500/10' : 'border-white/10 bg-white/5'
      } ${seat.connected ? '' : 'opacity-45'}`}
    >
      <TeamLogo logoId={seat.logoId} primary={seat.primaryColor} secondary={seat.secondaryColor} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{seat.name}</span>
          {isMe && <span className="rounded bg-white/10 px-1 text-[9px] text-slate-300">나</span>}
          {seat.uid === hostUid && (
            <span className="rounded bg-amber-400/20 px-1 text-[9px] text-amber-200">방장</span>
          )}
        </div>
        <div className="truncate text-[10px] text-slate-500">
          {seat.teamName} · 타순 {orders}번
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={`text-[10px] font-bold ${seat.ready ? 'text-lime-300' : 'text-slate-500'}`}>
          {!seat.connected ? '연결 끊김' : seat.ready ? '준비 완료' : '선수 고르는 중'}
        </div>
        {onSwapSide && seat.uid !== hostUid && (
          <button
            className="mt-0.5 text-[10px] text-slate-400 underline hover:text-slate-200"
            onClick={() => onSwapSide(seat.uid)}
          >
            팀 옮기기
          </button>
        )}
      </div>
    </div>
  );
}
