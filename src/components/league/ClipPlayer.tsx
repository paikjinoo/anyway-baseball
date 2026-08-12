'use client';

import { useEffect, useRef, useState } from 'react';
import { GameScene } from '@/components/three/GameScene';
import { useMatchStore } from '@/lib/store/matchStore';
import type { PlayClip } from '@/lib/game/record';

/**
 * 다시 보기.
 *
 * 엔진이 결정론적이라 "투구 직전 상태 + 그때의 커맨드"만으로 그 한 플레이가 그대로
 * 재현된다. 그래서 여기서 하는 일은 저장된 상태를 세우고, 공이 홈플레이트에 닿을 때쯤
 * 판정을 한 번 부르는 것뿐이다. 연출은 실제 경기와 완전히 같은 경로를 탄다.
 *
 * **GameView를 쓰지 않는다.** GameView는 useMatchReward를 품고 있어서, 끝내기 장면을
 * 재생하면 그 경기 보상이 한 번 더 지급된다.
 */
export function ClipPlayer({ clip, onClose }: { clip: PlayClip; onClose: () => void }) {
  const startClip = useMatchStore((s) => s.startClip);
  const resolveClip = useMatchStore((s) => s.resolveClip);
  const reset = useMatchStore((s) => s.reset);
  const description = useMatchStore((s) => s.lastResult?.description ?? null);
  const revealed = useMatchStore((s) => s.revealed);
  const [replayKey, setReplayKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    startClip(clip);
    // 공이 미트에 닿는 순간에 맞춰 판정한다. 실제 경기에서 tick()이 하는 일과 같다.
    const st = useMatchStore.getState();
    const delay = st.pitchStartAt + st.displayFlightMs - performance.now();
    timerRef.current = setTimeout(() => resolveClip(), Math.max(0, delay));

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      reset();
    };
  }, [clip, replayKey, startClip, resolveClip, reset]);

  return (
    <div className="clip-backdrop" role="dialog" aria-modal="true" aria-label="다시 보기">
      <div className="clip-stage">
        <GameScene cameraMode="DRAMATIC" />
      </div>

      <div className="clip-bar">
        <div className="clip-label">
          <span className="clip-tag">다시 보기</span>
          {clip.label}
        </div>
        <div className="clip-actions">
          <button className="btn" onClick={() => setReplayKey((k) => k + 1)}>
            한 번 더
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>

      {revealed && description && <div className="clip-result">{description}</div>}
    </div>
  );
}
