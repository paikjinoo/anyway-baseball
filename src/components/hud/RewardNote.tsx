'use client';

import type { MatchRewardSummary } from '@/lib/store/matchReward';

/**
 * 경기 종료 화면의 보상 안내.
 *
 * 한도에 걸려 깎였다면 그 사실을 숨기지 않고 그대로 보여 준다 —
 * "분명 이겼는데 아무것도 안 늘었다"가 가장 나쁜 경험이다.
 */
export function RewardNote({ reward }: { reward: MatchRewardSummary }) {
  const top = reward.lines.filter((l) => l.exp > 0).slice(0, 5);
  const rest = reward.lines.filter((l) => l.exp > 0).length - top.length;
  const injured = reward.lines.filter((l) => l.injured);

  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] text-slate-400">경기 보상 · {reward.reason}</span>
        <span className="text-lg font-black tabular text-amber-300">
          +{reward.gold.toLocaleString()}G
        </span>
      </div>

      {reward.capped && (
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          하루 한도에 걸려 {reward.earnedGold.toLocaleString()}G 중{' '}
          {reward.gold.toLocaleString()}G만 지급되었습니다.
        </p>
      )}

      {top.length > 0 ? (
        <div className="mt-2 space-y-1">
          <div className="flex items-baseline justify-between text-[11px] text-slate-400">
            <span>선수 경험치</span>
            <span className="tabular">
              총 {reward.totalExp.toLocaleString()} EXP
              {reward.levelUps > 0 && ` · ${reward.levelUps}레벨업`}
            </span>
          </div>
          {top.map((l) => (
            <div key={l.playerId} className="flex items-center gap-2 text-[11px]">
              <span className="flex-1 truncate text-slate-300">{l.name}</span>
              <span className="tabular text-slate-400">+{l.exp}</span>
              {l.levelUps > 0 && (
                <span className="rounded bg-lime-500/20 px-1.5 py-0.5 text-[10px] font-bold text-lime-300">
                  Lv +{l.levelUps} · 훈련P +{l.tp}
                </span>
              )}
            </div>
          ))}
          {rest > 0 && <p className="text-[10px] text-slate-500">외 {rest}명</p>}
        </div>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          출전한 선수가 없어 경험치는 지급되지 않았습니다.
        </p>
      )}

      {injured.length > 0 && (
        <p className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300">
          컨디션 난조: {injured.map((l) => `${l.name}(${l.injured})`).join(', ')} — 다음 경기부터
          회복될 때까지 능력치가 조금 낮아집니다.
        </p>
      )}

      {reward.daily && (
        <div className="mt-2 space-y-1">
          <DailyBar
            label="오늘 골드"
            used={reward.daily.goldUsed}
            cap={reward.daily.goldCap}
          />
          <DailyBar label="오늘 경험치" used={reward.daily.expUsed} cap={reward.daily.expCap} />
        </div>
      )}
    </div>
  );
}

function DailyBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] text-slate-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-amber-400/80 transition-all"
          style={{ width: `${Math.min(100, (used / Math.max(1, cap)) * 100)}%` }}
        />
      </div>
      <span className="shrink-0 text-[10px] tabular text-slate-500">
        {used.toLocaleString()} / {cap.toLocaleString()}
      </span>
    </div>
  );
}
