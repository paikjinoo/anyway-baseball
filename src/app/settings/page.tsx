'use client';

import { useAppStore } from '@/lib/store/appStore';
import { playCheer, playClick, unlockAudio } from '@/lib/audio/sfx';

export default function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-black">게임 설정</h1>

      <section className="panel p-5">
        <h2 className="mb-4 font-bold">사운드</h2>

        <label className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold">사운드 사용</span>
          <input
            type="checkbox"
            checked={settings.soundEnabled}
            onChange={(e) => {
              unlockAudio();
              update({ soundEnabled: e.target.checked });
            }}
            className="h-5 w-5 accent-lime-500"
          />
        </label>

        <div className={settings.soundEnabled ? '' : 'pointer-events-none opacity-40'}>
          <div className="mb-4">
            <label className="field-label">
              효과음 볼륨 {Math.round(settings.sfxVolume * 100)}%
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(settings.sfxVolume * 100)}
              onChange={(e) => update({ sfxVolume: Number(e.target.value) / 100 })}
              onPointerUp={() => playClick()}
            />
          </div>
          <div className="mb-4">
            <label className="field-label">
              관중 소리 볼륨 {Math.round(settings.bgmVolume * 100)}%
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(settings.bgmVolume * 100)}
              onChange={(e) => update({ bgmVolume: Number(e.target.value) / 100 })}
            />
          </div>
          <button
            className="btn !py-1.5 !text-xs"
            onClick={() => {
              unlockAudio();
              playCheer(0.9, 1.6);
            }}
          >
            테스트 재생
          </button>
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
