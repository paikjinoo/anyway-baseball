'use client';

import { useAppStore } from '@/lib/store/appStore';
import { SKIP_REASON_KO } from '@/lib/game/migrate';
import type { SkippedDoc } from '@/lib/firebase/store';

/**
 * 저장 데이터에 관해 **사용자가 알아야 할 것만** 말한다.
 *
 * 이전 버전은 못 읽은 문서를 한 덩어리로 묶어 "불러오지 못한 저장 데이터 N개 — 데이터가
 * 손상되었습니다"라고 띄웠다. 그런데 그 대다수는 손상이 아니라 티어/레벨이 들어오기 전에
 * 만들어진 **옛 팀**이었고, 해당 유저는 이미 재창단을 마치고 멀쩡히 플레이 중이었다.
 * 결과적으로 아무 문제 없는 사람에게 조치할 수도 없는 경고를 영구히 띄우고 있었다.
 *
 * 그래서 지금은 넷을 구분한다.
 *
 * 1. **옛 팀**은 로드할 때 자동으로 정리하고(@see firebase/store.purgeUnreadableTeams),
 *    여기서는 왜 없어졌는지 한 번만 알린다. 이미 새 팀이 있는지에 따라 할 말이 다르다.
 * 2. **최신 버전에서 저장된 팀**(TOO_NEW)은 새로고침이면 열리므로 할 일을 알려 준다.
 *    모르고 재창단을 눌러 버리면 멀쩡한 팀을 잃으므로, 경고 톤은 여기에만 쓴다.
 * 3. **서명이 맞지 않은 팀**(@see game/integrity)은 골드를 되돌렸다고 알린다. 골드가
 *    말없이 사라지면 조작한 사람보다 안 한 사람이 더 오래 헤맨다. 그래서 되돌렸다는 사실과
 *    복구 방법을 같이 적고, "조작"이나 "치트" 같은 단어로 단정하지는 않는다 — 판정이 틀릴
 *    수 있고, 정말 손댄 사람은 어차피 무슨 일이 일어났는지 안다.
 * 4. **나머지**는 담담하게 사실만 적고 원본이 남아 있다는 것을 알린다.
 *
 * 문구에 개발자 용어를 넣지 않는다 — "형식 v2" 같은 표기는 읽는 사람이 할 수 있는 일을
 * 하나도 늘려 주지 못하면서 불안만 키운다.
 */
export function DataNotice() {
  const issues = useAppStore((s) => s.dataIssues);
  const cleaned = useAppStore((s) => s.dataCleaned);
  const tampered = useAppStore((s) => s.dataTampered);
  const hasTeam = useAppStore((s) => s.teams.length > 0);

  if (!cleaned && !issues.length && !tampered.length) return null;

  const pending = issues.filter((i) => i.reason === 'TOO_NEW');
  const others = issues.filter((i) => i.reason !== 'TOO_NEW');

  return (
    <div className="mb-4 space-y-3">
      {tampered.length > 0 && (
        <div className="panel border-amber-400/30 bg-amber-400/5 p-4" role="alert">
          <p className="text-sm font-bold text-amber-200">골드를 되돌렸어요</p>
          <p className="mt-1.5 text-xs leading-relaxed text-amber-100/80">
            {tampered.join(', ')} — 저장된 팀 정보가 게임 밖에서 바뀐 흔적이 있어 골드를 0으로
            되돌렸어요. 선수와 기록은 그대로예요.
          </p>
          <p className="mt-2 text-[11px] text-amber-100/60">
            손댄 적이 없는데 이 안내가 보인다면 로그인한 채로 새로고침해 주세요. 다른 기기나
            서버에 저장된 팀이 있으면 그쪽으로 복구됩니다. 백업 파일이 있다면 설정 화면에서
            가져오기로도 되돌릴 수 있어요.
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <div className="panel border-amber-400/30 bg-amber-400/5 p-4" role="alert">
          <p className="text-sm font-bold text-amber-200">아직 열지 못한 팀이 있어요</p>
          <p className="mt-1.5 text-xs leading-relaxed text-amber-100/80">
            {teamNames(pending)} — 다른 기기에서 더 최신 버전으로 저장한 팀이에요. 페이지를
            새로고침하면 열릴 수 있어요.
          </p>
          <p className="mt-2 text-[11px] text-amber-100/60">
            그전에 팀을 새로 만들면 이 팀을 잃을 수 있으니 잠시만 기다려 주세요.
          </p>
        </div>
      )}

      {cleaned > 0 && (
        <div className="panel p-4" role="status">
          {hasTeam ? (
            <>
              <p className="text-sm font-bold">예전에 쓰던 팀 {cleaned}개를 정리했어요</p>
              <p className="mt-1.5 text-xs leading-relaxed text-white/60">
                업데이트 전에 만들어져 이제는 열 수 없는 팀이에요. 지금 쓰고 계신 팀과 기록은
                그대로 있으니 안심하세요.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-bold">예전에 만든 팀은 더 이상 열 수 없어요</p>
              <p className="mt-1.5 text-xs leading-relaxed text-white/60">
                선수 육성 시스템이 새로 들어오면서 예전 팀의 선수 정보를 그대로 이어받을 수 없게
                됐어요. 번거롭지만 팀을 새로 만들어 주세요. 참가 중이던 리그 성적은 새 팀으로
                이어집니다.
              </p>
            </>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="panel p-4" role="status">
          <p className="text-sm font-bold">열지 못한 팀 {others.length}개가 있어요</p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-white/60">
            {others.map((it, i) => (
              <li key={`${it.id ?? 'unknown'}-${i}`}>
                · {teamName(it)} — {SKIP_REASON_KO[it.reason]}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-white/40">
            원본은 이 브라우저에 그대로 남아 있어요. 설정 화면의 데이터 백업에서 파일로 내보내
            둘 수 있습니다.
          </p>
        </div>
      )}
    </div>
  );
}

function teamName(doc: SkippedDoc): string {
  return doc.name ?? '이름 없는 팀';
}

function teamNames(docs: SkippedDoc[]): string {
  return docs.map(teamName).join(' · ');
}
