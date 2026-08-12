'use client';

import { useAppStore } from '@/lib/store/appStore';
import { SKIP_REASON_KO } from '@/lib/game/migrate';

/**
 * 불러오지 못한 저장 데이터를 알린다.
 *
 * 스키마가 안 맞는 팀은 예전부터 조용히 목록에서 빠졌고, 화면에서는 창단 온보딩으로
 * 떨어질 뿐이라 **데이터가 그냥 사라진 것처럼 보였다.** 원본은 브라우저에 그대로 남아
 * 있으므로, 최소한 무엇이 왜 안 보이는지는 말해 준다.
 *
 * "더 새로운 버전에서 저장되었습니다"(TOO_NEW)는 특히 중요하다 — 새로고침하면 해결되는
 * 상황이고, 그 사이 재창단을 눌러 버리면 멀쩡한 팀을 잃는다.
 */
export function DataNotice() {
  const issues = useAppStore((s) => s.dataIssues);
  if (!issues.length) return null;

  return (
    <div className="panel mb-4 border-amber-400/30 bg-amber-400/5 p-4" role="status">
      <p className="text-sm font-bold text-amber-200">
        불러오지 못한 저장 데이터 {issues.length}개
      </p>
      <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-100/70">
        {issues.map((it, i) => (
          <li key={`${it.id ?? 'unknown'}-${i}`}>
            · {it.name ?? '이름 없는 팀'}
            {it.version !== null && ` (형식 v${it.version})`} — {SKIP_REASON_KO[it.reason]}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-amber-100/50">
        원본은 이 브라우저에 그대로 남아 있습니다. 더 새로운 버전에서 저장된 데이터라면
        새로고침 후 다시 열어 주세요.
      </p>
    </div>
  );
}
