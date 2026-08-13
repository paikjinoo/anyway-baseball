'use client';

import { useRef, useState } from 'react';
import { useAppStore } from '@/lib/store/appStore';
import {
  exportSnapshot,
  importSnapshot,
  takenIds,
  type ImportResult,
} from '@/lib/firebase/store';
import {
  BACKUP_MAX_BYTES,
  backupFileName,
  buildBackup,
  parseBackup,
  retargetBackup,
  type BackupSummary,
} from '@/lib/game/backup';

/** package.json의 값. 재현 문의 때 어느 빌드에서 나온 백업인지 알려면 필요하다. */
const APP_VERSION = '0.1.0';

/**
 * 세이브 데이터 백업.
 *
 * 기록·클립·설정은 이 브라우저에만 있고, 게스트에게는 팀과 리그도 로컬이 전부다.
 * 브라우저를 바꾸면 통산 기록이 통째로 사라지는데 되돌릴 방법이 없었다.
 *
 * 가져오기는 되돌릴 수 없으므로 **누르기 직전에 지금 상태를 자동으로 한 번 내려받는다.**
 * 그게 이 기능의 유일한 안전망이다.
 */
export function DataBackup() {
  const user = useAppStore((s) => s.user);
  const setTeams = useAppStore((s) => s.setTeams);
  const setLeagues = useAppStore((s) => s.setLeagues);
  const setActiveTeam = useAppStore((s) => s.setActiveTeam);
  const setNickname = useAppStore((s) => s.setNickname);
  const hydrateSettings = useAppStore((s) => s.hydrateSettings);

  const fileRef = useRef<HTMLInputElement>(null);
  const [includeClips, setIncludeClips] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; summary: BackupSummary } | null>(null);

  function download(json: string, name: string) {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    // 안 지우면 클립을 담은 수 MB짜리 Blob이 탭 수명 내내 메모리에 남는다.
    URL.revokeObjectURL(url);
  }

  function snapshotJson(uid: string, clips: boolean): string {
    return JSON.stringify(
      buildBackup({
        uid,
        payload: exportSnapshot(uid, { includeClips: clips }),
        appVersion: APP_VERSION,
        exportedAt: Date.now(),
      }),
    );
  }

  function doExport() {
    if (!user) return;
    const json = snapshotJson(user.uid, includeClips);
    download(json, backupFileName(Date.now()));
    setMsg(`내보냈습니다 (${(new Blob([json]).size / 1024).toFixed(0)}KB).`);
  }

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !user) return;
    if (f.size > BACKUP_MAX_BYTES) {
      setMsg('파일이 너무 큽니다 (20MB 초과).');
      return;
    }
    const text = await f.text();
    const parsed = parseBackup(text, user.uid);
    if (!parsed.ok) {
      setMsg(parsed.message);
      setPending(null);
      return;
    }
    if (parsed.summary.fromFuture) {
      setMsg('더 새로운 버전에서 만든 백업입니다. 앱을 새로고침한 뒤 다시 시도해 주세요.');
      setPending(null);
      return;
    }
    setMsg(null);
    setPending({ text, summary: parsed.summary });
  }

  async function confirmImport() {
    if (!user || !pending) return;
    const parsed = parseBackup(pending.text, user.uid);
    if (!parsed.ok) return;
    if (
      !confirm(
        '현재 계정의 팀과 리그가 백업 내용으로 완전히 대체됩니다. 되돌릴 수 없습니다.\n\n계속하기 전에 지금 상태를 자동으로 한 번 내려받습니다.',
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      // 되돌릴 수 없는 작업의 유일한 안전망.
      download(snapshotJson(user.uid, false), backupFileName(Date.now(), '-before-import'));

      const taken = takenIds(user.uid);
      const { payload } = retargetBackup(
        parsed.file.data,
        user.uid,
        parsed.file.uid,
        (id) => taken.has(id),
      );
      const res: ImportResult = await importSnapshot(payload, user.uid);

      // **setUser는 부르지 않는다.** dataReady가 false로 돌아가는데 AppShell의 로드
      // 이펙트는 uid가 그대로라 재실행되지 않아 화면이 로딩에서 멈춘다.
      setTeams(res.teams);
      setActiveTeam(res.activeTeamId);
      setLeagues(res.leagues);
      hydrateSettings();
      if (payload.nickname) setNickname(payload.nickname);

      const notes = [
        `팀 ${res.teams.length}개`,
        `리그 ${res.leagues.length}개`,
        `기록 ${res.recordCount}경기`,
      ];
      if (res.migrated) notes.push(`${res.migrated}개 업그레이드`);
      if (res.skipped.length) notes.push(`팀 ${res.skipped.length}개는 열 수 없어 제외`);
      setMsg(`가져왔습니다 — ${notes.join(' · ')}.`);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <section className="panel p-5">
      <h2 className="mb-1 font-bold">데이터 백업</h2>
      <p className="mb-4 text-[11px] text-slate-500">
        팀 · 리그 · 경기 기록 · 설정을 JSON 파일 하나로 저장합니다. 브라우저를 바꾸거나
        게스트에서 로그인 계정으로 옮길 때 씁니다.
      </p>

      <label className="mb-3 flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm font-semibold">다시 보기 클립 포함</span>
          <span className="block text-[11px] text-slate-500">
            클립 하나가 경기 상태를 통째로 품고 있어 파일이 수 MB로 커집니다.
          </span>
        </span>
        <input
          type="checkbox"
          checked={includeClips}
          onChange={(e) => setIncludeClips(e.target.checked)}
          className="h-5 w-5 shrink-0 accent-lime-500"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={doExport} disabled={busy}>
          내보내기
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          가져오기…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={pickFile}
          className="hidden"
        />
      </div>

      {pending && (
        <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3">
          <p className="text-sm font-bold text-amber-200">가져올 내용</p>
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-100/70">
            <li>· 팀 {pending.summary.teamNames.join(', ') || '없음'}</li>
            <li>
              · 선수 {pending.summary.playerCount}명 · 리그 {pending.summary.leagueCount}개 · 기록{' '}
              {pending.summary.recordCount}경기
              {pending.summary.clipCount > 0 && ` (클립 ${pending.summary.clipCount}개)`}
            </li>
            <li>
              · {new Date(pending.summary.exportedAt).toLocaleString('ko-KR')} 저장 ·{' '}
              {pending.summary.sameAccount ? '같은 계정' : '다른 계정 — 이 계정으로 옮깁니다'}
            </li>
          </ul>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary !py-1 !text-xs" onClick={confirmImport} disabled={busy}>
              {busy ? '가져오는 중…' : '이 내용으로 대체'}
            </button>
            <button className="btn !py-1 !text-xs" onClick={() => setPending(null)} disabled={busy}>
              취소
            </button>
          </div>
        </div>
      )}

      {msg && <p className="mt-3 text-xs text-slate-400">{msg}</p>}
      {user.isGuest && (
        <p className="mt-2 text-[11px] text-slate-600">
          게스트 데이터는 이 브라우저에만 저장됩니다. 내보내기로 옮겨 두는 편이 안전합니다.
        </p>
      )}
    </section>
  );
}
