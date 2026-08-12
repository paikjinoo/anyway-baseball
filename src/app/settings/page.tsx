'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store/appStore';
import { RuleSettings } from '@/components/settings/RuleSettings';
import { DataBackup } from '@/components/settings/DataBackup';
import { NICKNAME_MAX, normalizeNickname } from '@/lib/firebase/store';
import {
  playBatCrack,
  playHomeRunCelebration,
  playUmpireCall,
  unlockAudio,
} from '@/lib/audio/sfx';

export default function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-black">게임 설정</h1>

      <ManagerProfile />

      <section className="panel p-5">
        <h2 className="mb-4 font-bold">사운드</h2>

        <div className="space-y-3">
          <SoundChannel
            title="효과음"
            description="투구 · 포구 · 타격 · 번트 · 헛스윙 · 심판 선언 · UI"
            enabled={settings.sfxEnabled}
            volume={settings.sfxVolume}
            onEnabled={(sfxEnabled) => update({ sfxEnabled })}
            onVolume={(sfxVolume) => update({ sfxVolume })}
            onTest={() => {
              playBatCrack(0.75);
              playUmpireCall('strike', 0.22);
            }}
          />

          <SoundChannel
            title="관중석"
            description="평상시 응원 · 안타 환호 · 홈런 축하"
            enabled={settings.crowdEnabled}
            volume={settings.crowdVolume}
            onEnabled={(crowdEnabled) => update({ crowdEnabled })}
            onVolume={(crowdVolume) => update({ crowdVolume })}
            onTest={() => playHomeRunCelebration()}
          />

          <SoundChannel
            title="배경음"
            description="메인 · 팀 · 선수 · 리그 · 설정 화면"
            enabled={settings.bgmEnabled}
            volume={settings.bgmVolume}
            onEnabled={(bgmEnabled) => update({ bgmEnabled })}
            onVolume={(bgmVolume) => update({ bgmVolume })}
          />

          <p className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            배경음 파일 위치: <code className="text-slate-300">public/audio/bgm/menu.mp3</code>
          </p>
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="mb-1 font-bold">경기 규칙</h2>
        <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
          CPU 대전과 리그에 적용되는 내 기본값입니다. 온라인 대전에서는{' '}
          <b className="text-slate-400">방을 만들 때 정한 규칙</b>이 우선합니다.
        </p>
        <RuleSettings value={settings} onChange={update} />
      </section>

      <section className="panel p-5">
        <h2 className="mb-4 font-bold">연출</h2>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-semibold">카메라 흔들림</span>
            <span className="block text-[11px] text-slate-500">
              배트에 잘 맞은 순간 화면이 짧게 흔들립니다. 타구가 셀수록 크게 흔들립니다.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.cameraShake}
            onChange={(e) => update({ cameraShake: e.target.checked })}
            className="h-5 w-5 shrink-0 accent-lime-500"
          />
        </label>
      </section>

      <DataBackup />

      <p className="text-center text-xs text-slate-600">
        설정은 이 브라우저에 저장되며 새 경기부터 적용됩니다.
      </p>
    </div>
  );
}

/**
 * 감독 닉네임.
 *
 * 온라인 대전에서 상대에게 보이는 이름이라 구글 계정 이름을 그대로 쓰면 실명이 노출된다.
 * 계정 이름 위에 덮어쓰고, 비우면 다시 계정 이름으로 돌아간다.
 */
function ManagerProfile() {
  const user = useAppStore((s) => s.user);
  const setNickname = useAppStore((s) => s.setNickname);
  const current = user?.nickname ?? '';
  const [draft, setDraft] = useState(current);

  // 저장 결과(공백 정리 포함)와 다른 기기에서 온 변경을 입력칸에 되비친다.
  useEffect(() => {
    setDraft(current);
  }, [user?.uid, current]);

  if (!user) return null;

  const trimmed = normalizeNickname(draft);
  const dirty = trimmed !== current;

  return (
    <section className="panel p-5" id="profile">
      <h2 className="mb-1 font-bold">감독 이름</h2>
      <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
        온라인 대전의 방 목록과 대기 화면에서 상대에게 보이는 이름입니다.
        {user.isGuest
          ? ' 게스트 이름은 이 브라우저에만 저장됩니다.'
          : ' 비워 두면 계정 이름을 그대로 씁니다.'}
      </p>

      <label className="field-label">닉네임</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          maxLength={NICKNAME_MAX}
          placeholder={user.accountName}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) setNickname(trimmed);
          }}
        />
        <button
          className="btn btn-primary shrink-0"
          disabled={!dirty}
          onClick={() => setNickname(trimmed)}
        >
          저장
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>
          현재 표시 이름 <b className="text-slate-300">{user.displayName}</b>
        </span>
        {user.nickname && (
          <>
            <span aria-hidden>·</span>
            <button
              className="underline transition hover:text-slate-300"
              onClick={() => setNickname(null)}
            >
              계정 이름({user.accountName})으로 되돌리기
            </button>
          </>
        )}
        <span className="ml-auto">
          {trimmed.length}/{NICKNAME_MAX}
        </span>
      </div>
    </section>
  );
}

function SoundChannel({
  title,
  description,
  enabled,
  volume,
  onEnabled,
  onVolume,
  onTest,
}: {
  title: string;
  description: string;
  enabled: boolean;
  volume: number;
  onEnabled: (enabled: boolean) => void;
  onVolume: (volume: number) => void;
  onTest?: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-[11px] text-slate-500">{description}</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            unlockAudio();
            onEnabled(e.target.checked);
          }}
          className="h-5 w-5 shrink-0 accent-lime-500"
        />
      </label>

      <div className={enabled ? 'mt-3 flex items-end gap-3' : 'pointer-events-none mt-3 flex items-end gap-3 opacity-35'}>
        <label className="min-w-0 flex-1">
          <span className="field-label">볼륨 {Math.round(volume * 100)}%</span>
          <input
            className="w-full"
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
          />
        </label>
        {onTest && (
          <button
            className="btn !min-h-8 !px-3 !py-1 !text-[11px]"
            onClick={() => {
              unlockAudio();
              onTest();
            }}
          >
            테스트
          </button>
        )}
      </div>
    </div>
  );
}
