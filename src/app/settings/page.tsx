'use client';

import { useAppStore } from '@/lib/store/appStore';
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
        <h2 className="mb-4 font-bold">경기 규칙</h2>

        <div className="mb-5">
          <label className="field-label">정규 이닝</label>
          <div className="grid grid-cols-2 gap-2">
            {([7, 9] as const).map((n) => (
              <button
                key={n}
                onClick={() => update({ regulationInnings: n })}
                className={`rounded-xl border-2 px-3 py-3 font-semibold transition ${
                  settings.regulationInnings === n
                    ? 'border-lime-400 bg-lime-500/15 text-lime-200'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                }`}
              >
                {n}이닝제
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            동점이면 최대 3이닝까지 연장 후 무승부 처리됩니다.
          </p>
        </div>

        <label className="mb-4 flex items-center justify-between">
          <span>
            <span className="block text-sm font-semibold">콜드게임</span>
            <span className="text-[11px] text-slate-500">
              정해진 이닝 이후 점수차가 크면 경기를 끝냅니다
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.mercyRule}
            onChange={(e) => update({ mercyRule: e.target.checked })}
            className="h-5 w-5 accent-lime-500"
          />
        </label>

        <div className={settings.mercyRule ? 'mb-5 grid gap-4 sm:grid-cols-2' : 'hidden'}>
          <div>
            <label className="field-label">발동 이닝: {settings.mercyFromInning}회부터</label>
            <input
              type="range"
              min={3}
              max={settings.regulationInnings}
              value={Math.min(settings.mercyFromInning, settings.regulationInnings)}
              onChange={(e) => update({ mercyFromInning: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="field-label">점수차: {settings.mercyRunDiff}점</label>
            <input
              type="range"
              min={5}
              max={20}
              value={settings.mercyRunDiff}
              onChange={(e) => update({ mercyRunDiff: Number(e.target.value) })}
            />
          </div>
        </div>

        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-semibold">지명타자 (DH)</span>
            <span className="text-[11px] text-slate-500">끄면 투수가 타순에 들어갑니다</span>
          </span>
          <input
            type="checkbox"
            checked={settings.useDH}
            onChange={(e) => update({ useDH: e.target.checked })}
            className="h-5 w-5 accent-lime-500"
          />
        </label>
      </section>

      <section className="panel p-5">
        <h2 className="mb-4 font-bold">난이도 / 연출</h2>

        <div className="mb-5">
          <label className="field-label">
            투구 체감 속도 {Math.round(settings.pitchSpeedScale * 100)}%
          </label>
          <input
            type="range"
            min={25}
            max={100}
            value={Math.round(settings.pitchSpeedScale * 100)}
            onChange={(e) => update({ pitchSpeedScale: Number(e.target.value) / 100 })}
          />
          <p className="mt-1.5 text-[11px] text-slate-500">
            낮출수록 공이 천천히 날아와 타이밍 맞추기가 쉬워집니다. 100%는 실제 구속 그대로라
            매우 어렵습니다. (판정 자체는 동일하게 환산됩니다)
          </p>
        </div>

        <label className="flex items-center justify-between">
          <span className="text-sm font-semibold">카메라 흔들림</span>
          <input
            type="checkbox"
            checked={settings.cameraShake}
            onChange={(e) => update({ cameraShake: e.target.checked })}
            className="h-5 w-5 accent-lime-500"
          />
        </label>
      </section>

      <p className="text-center text-xs text-slate-600">
        설정은 이 브라우저에 저장되며 새 경기부터 적용됩니다.
      </p>
    </div>
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
