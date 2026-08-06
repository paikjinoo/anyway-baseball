'use client';

import type { MatchRules } from '@/lib/game/types';

/**
 * 경기 규칙 편집 UI.
 *
 * 설정 화면(내 기본값)과 온라인 방 만들기(그 방의 규칙)가 같은 컴포넌트를 쓴다.
 * 두 곳의 항목이 갈라지면 "설정에서 7이닝으로 바꿨는데 방은 9이닝"처럼
 * 어느 값이 적용되는지 알 수 없게 되기 때문이다.
 */
export function RuleSettings({
  value,
  onChange,
  /** 지명타자 항목을 숨긴다 (올스타전은 항상 DH) */
  hideDH = false,
  /** 방 만들기처럼 좁은 폭에 넣을 때 여백을 줄인다 */
  compact = false,
}: {
  value: MatchRules;
  onChange: (patch: Partial<MatchRules>) => void;
  hideDH?: boolean;
  compact?: boolean;
}) {
  const gap = compact ? 'mb-4' : 'mb-5';

  return (
    <div>
      <div className={gap}>
        <label className="field-label">정규 이닝</label>
        <div className="grid grid-cols-2 gap-2">
          {([7, 9] as const).map((n) => (
            <button
              key={n}
              onClick={() => onChange({ regulationInnings: n })}
              className={`rounded-xl border-2 px-3 font-semibold transition ${
                compact ? 'py-2 text-sm' : 'py-3'
              } ${
                value.regulationInnings === n
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

      <label className={`${gap} flex items-center justify-between`}>
        <span>
          <span className="block text-sm font-semibold">콜드게임</span>
          <span className="text-[11px] text-slate-500">
            정해진 이닝 이후 점수차가 크면 경기를 끝냅니다
          </span>
        </span>
        <input
          type="checkbox"
          checked={value.mercyRule}
          onChange={(e) => onChange({ mercyRule: e.target.checked })}
          className="h-5 w-5 shrink-0 accent-lime-500"
        />
      </label>

      <div className={value.mercyRule ? `${gap} grid gap-4 sm:grid-cols-2` : 'hidden'}>
        <div>
          <label className="field-label">발동 이닝: {value.mercyFromInning}회부터</label>
          <input
            type="range"
            min={3}
            max={value.regulationInnings}
            value={Math.min(value.mercyFromInning, value.regulationInnings)}
            onChange={(e) => onChange({ mercyFromInning: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="field-label">점수차: {value.mercyRunDiff}점</label>
          <input
            type="range"
            min={5}
            max={20}
            value={value.mercyRunDiff}
            onChange={(e) => onChange({ mercyRunDiff: Number(e.target.value) })}
          />
        </div>
      </div>

      {!hideDH && (
        <label className={`${gap} flex items-center justify-between`}>
          <span>
            <span className="block text-sm font-semibold">지명타자 (DH)</span>
            <span className="text-[11px] text-slate-500">끄면 투수가 타순에 들어갑니다</span>
          </span>
          <input
            type="checkbox"
            checked={value.useDH}
            onChange={(e) => onChange({ useDH: e.target.checked })}
            className="h-5 w-5 shrink-0 accent-lime-500"
          />
        </label>
      )}

      <div>
        <label className="field-label">
          투구 체감 속도 {Math.round(value.pitchSpeedScale * 100)}%
        </label>
        <input
          type="range"
          min={25}
          max={100}
          value={Math.round(value.pitchSpeedScale * 100)}
          onChange={(e) => onChange({ pitchSpeedScale: Number(e.target.value) / 100 })}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          낮출수록 공이 천천히 날아와 타이밍 맞추기가 쉬워집니다. 100%는 실제 구속 그대로라 매우
          어렵습니다. (판정 자체는 동일하게 환산됩니다)
        </p>
      </div>
    </div>
  );
}
