'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { useMatchStore } from '@/lib/store/matchStore';
import { GameScene } from '@/components/three/GameScene';
import { BatPanel } from '@/components/hud/BatPanel';
import { currentBatter } from '@/lib/game/engine';
import { KIND_LABEL, type SwingLog, describeSwing, summarize } from './feedback';

/**
 * 연습 타석.
 *
 * 이 게임은 타이밍 게임인데 연습할 곳이 없었다. 처음 온 사람은 첫 타석에서 아무것도
 * 못 맞히고, 왜 못 맞혔는지도 모른 채 나간다 — **타이밍 오차가 매 스윙 계산되고 있는데
 * 화면에 한 번도 나오지 않기 때문이다** (SwingCommand.timingMs). 여기서 하는 일은
 * 그 값을 보여 주는 것이다.
 *
 * 보상은 없다. 카운트도 아웃도 없는 무한 타석에 경험치나 골드를 걸면 그게 곧 최적
 * 파밍 경로가 되어, 경기를 할 이유가 사라진다.
 */
export default function PracticePage() {
  const authReady = useAppStore((s) => s.authReady);
  const dataReady = useAppStore((s) => s.dataReady);
  const settings = useAppStore((s) => s.settings);
  const team = useActiveTeam();

  const initCpuGame = useMatchStore((s) => s.initCpuGame);
  const practiceReset = useMatchStore((s) => s.practiceReset);
  const reset = useMatchStore((s) => s.reset);
  const state = useMatchStore((s) => s.state);
  const phase = useMatchStore((s) => s.phase);
  const lastResult = useMatchStore((s) => s.lastResult);
  const revealed = useMatchStore((s) => s.revealed);

  const [log, setLog] = useState<SwingLog[]>([]);
  const [ready, setReady] = useState(false);
  /** 이미 기록한 투구 번호. 같은 결과를 두 번 세지 않는다. */
  const countedRef = useRef(-1);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- 경기 준비 -----------------------------------------------------------
  useEffect(() => {
    if (!authReady || !dataReady || !team || ready) return;
    // 내 팀이 양쪽에 선다. 상대 전력을 고르는 화면을 두면 연습을 시작하기까지가 멀어진다.
    initCpuGame({
      playerTeam: team,
      cpuTeam: team,
      playerSide: 'away',
      settings,
      difficulty: 'NORMAL',
      seed: `practice-${team.id}`,
    });
    setReady(true);
  }, [authReady, dataReady, team, ready, initCpuGame, settings]);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      reset();
    },
    [reset],
  );

  // 엔진 시계(tick)는 GameScene 안의 Driver가 매 프레임 돌린다. 여기서 또 돌리면
  // 같은 공을 두 번 재촉하게 되므로 두지 않는다 — GameView도 같은 구조다.

  // --- 결과 기록 후 다음 공 ------------------------------------------------
  useEffect(() => {
    if (phase !== 'RESULT' || !revealed || !lastResult) return;
    if (countedRef.current === lastResult.pitchNumber) return;
    countedRef.current = lastResult.pitchNumber;

    const entry = describeSwing(lastResult);
    if (entry) setLog((l) => [entry, ...l].slice(0, 40));

    resetTimer.current = setTimeout(() => practiceReset(), 900);
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, [phase, revealed, lastResult, practiceReset]);

  const stats = useMemo(() => summarize(log), [log]);


  if (!authReady || !dataReady) {
    return (
      <div className="loading-state" aria-live="polite">
        <div className="loading-mark">A/B</div>
      </div>
    );
  }
  if (!team) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-sm text-slate-400">연습하려면 먼저 팀을 만들어야 합니다.</p>
        <Link className="btn btn-primary" href="/team">
          구단 창단하기
        </Link>
      </div>
    );
  }
  if (!state) return <div className="py-20 text-center text-slate-500">타석 준비 중…</div>;

  const batter = currentBatter(state);

  return (
    <div className="practice-page">
      <div className="practice-stage">
        <GameScene cameraMode="BATTER" />
        {/* 공을 받는 버튼은 BatPanel이 이미 갖고 있다. 여기 또 두면 같은 버튼이 둘이 된다. */}
        {log[0] && phase === 'RESULT' && revealed && (
          <div className={`practice-verdict ${log[0].contact ? 'is-hit' : 'is-miss'}`}>
            <b>{KIND_LABEL[log[0].kind] ?? log[0].kind}</b>
            <span>{log[0].detail}</span>
          </div>
        )}
      </div>

      <aside className="practice-side">
        <div className="panel p-4">
          <h1 className="mb-1 text-lg font-black">연습 타석</h1>
          <p className="text-[11px] text-slate-500">
            카운트도 아웃도 없습니다. 스윙마다 얼마나 빨랐는지·늦었는지가 숫자로 나옵니다.
            <br />
            보상은 주지 않습니다.
          </p>
        </div>

        <div className="panel p-4">
          <div className="field-label">최근 {stats.n}스윙</div>
          <div className="practice-stats">
            <div>
              <span>컨택</span>
              <b>{stats.n ? `${Math.round(stats.contactRate * 100)}%` : '-'}</b>
            </div>
            <div>
              <span>평균 타이밍</span>
              <b>{stats.n ? `${stats.avgTiming > 0 ? '+' : ''}${stats.avgTiming}ms` : '-'}</b>
            </div>
            <div>
              <span>버릇</span>
              <b>{stats.tendency}</b>
            </div>
          </div>
        </div>

        <BatPanel state={state} batter={batter} />

        {log.length > 0 && (
          <div className="panel p-4">
            <div className="field-label">기록</div>
            <ul className="practice-log">
              {log.slice(0, 8).map((l, i) => (
                <li key={`${l.pitchNumber}-${i}`}>
                  <span className={l.contact ? 'text-lime-300' : 'text-slate-500'}>
                    {KIND_LABEL[l.kind] ?? l.kind}
                  </span>
                  <span>{l.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Link className="btn w-full" href="/play">
          연습 끝내기
        </Link>
      </aside>
    </div>
  );
}
