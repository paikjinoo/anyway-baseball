'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { GameView } from '@/components/GameView';
import { useMatchStore } from '@/lib/store/matchStore';
import { DIFFICULTY_LABELS, type Difficulty } from '@/lib/game/ai';
import { Rng, seedFromString } from '@/lib/game/rng';
import { generateTeam, teamRating } from '@/lib/game/generator';
import { rosterIssues } from '@/lib/game/roster';
import { TeamLogo } from '@/components/ui/TeamLogo';
import type { Side, Team } from '@/lib/game/types';

const DIFFS: Difficulty[] = ['EASY', 'NORMAL', 'HARD', 'PRO'];
const STRENGTH: Record<Difficulty, number> = { EASY: 0.85, NORMAL: 1.0, HARD: 1.1, PRO: 1.2 };

export default function CpuGamePage() {
  const router = useRouter();
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);

  const initCpuGame = useMatchStore((s) => s.initCpuGame);
  const reset = useMatchStore((s) => s.reset);

  const [difficulty, setDifficulty] = useState<Difficulty>('NORMAL');
  const [side, setSide] = useState<Side>('home');
  const [started, setStarted] = useState(false);

  const cpuTeam: Team | null = useMemo(() => {
    if (!team) return null;
    const rng = new Rng(seedFromString(`cpu-${difficulty}-${team.id}`));
    return generateTeam(rng, {
      ownerUid: 'cpu',
      id: `cpu_${difficulty}`,
      strength: STRENGTH[difficulty],
    });
  }, [team, difficulty]);

  useEffect(() => () => reset(), [reset]);

  const issues = useMemo(
    () => (team ? rosterIssues(team, settings.useDH) : []),
    [team, settings.useDH],
  );

  if (!team || !cpuTeam) {
    return <div className="py-20 text-center text-slate-500">팀이 필요합니다.</div>;
  }

  if (!started) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 py-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-black">CPU 대전</h1>
          <div className="flex-1" />
          <button className="btn !py-1.5 !text-xs" onClick={() => router.push('/play')}>
            경기 선택으로 돌아가기
          </button>
        </div>

        <section className="panel p-5">
          <h2 className="mb-3 font-bold">난이도</h2>
          <div className="grid grid-cols-4 gap-2">
            {DIFFS.map((d) => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                className={`rounded-xl border-2 px-2 py-3 text-center transition ${
                  difficulty === d
                    ? 'border-lime-400 bg-lime-500/15 text-lime-200'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                }`}
              >
                <div className="font-bold">{DIFFICULTY_LABELS[d]}</div>
                <div className="text-[10px] text-slate-500">전력 ×{STRENGTH[d].toFixed(2)}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="mb-3 font-bold">선공 / 후공</h2>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['away', '원정 (선공)'],
                ['home', '홈 (후공)'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setSide(v)}
                className={`rounded-xl border-2 px-3 py-3 font-semibold transition ${
                  side === v
                    ? 'border-lime-400 bg-lime-500/15 text-lime-200'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="mb-4 font-bold">매치업</h2>
          <div className="flex items-center justify-around">
            <Side team={side === 'away' ? team : cpuTeam} label="원정" />
            <span className="text-2xl font-black text-slate-600">VS</span>
            <Side team={side === 'home' ? team : cpuTeam} label="홈" />
          </div>
          <p className="mt-4 text-center text-xs text-slate-500">
            {settings.regulationInnings}이닝제
            {settings.mercyRule
              ? ` · ${settings.mercyFromInning}회 이후 ${settings.mercyRunDiff}점차 콜드게임`
              : ' · 콜드게임 없음'}
            {settings.useDH ? ' · 지명타자' : ' · 투수 타석'}
          </p>
        </section>

        {issues.length > 0 && (
          <section className="panel border-rose-500/30 bg-rose-500/10 p-4">
            <h2 className="mb-2 text-sm font-bold text-rose-300">출전할 수 없습니다</h2>
            <ul className="space-y-1 text-xs text-rose-200/90">
              {issues.map((m) => (
                <li key={m}>· {m}</li>
              ))}
            </ul>
            <button className="btn mt-3 !py-1.5 !text-xs" onClick={() => router.push('/roster')}>
              선수단에서 정리하기
            </button>
          </section>
        )}

        <button
          className="btn btn-primary w-full !py-3 text-base"
          disabled={issues.length > 0}
          onClick={() => {
            initCpuGame({
              playerTeam: team,
              cpuTeam,
              playerSide: side,
              settings,
              difficulty,
            });
            setStarted(true);
          }}
        >
          플레이 볼!
        </button>
      </div>
    );
  }

  return (
    <GameView
      onExit={() => {
        reset();
        router.push('/play');
      }}
    />
  );
}

function Side({ team, label }: { team: Team; label: string }) {
  return (
    <div className="text-center">
      <div className="mb-1 text-[11px] text-slate-500">{label}</div>
      <TeamLogo logoId={team.logoId} primary={team.primaryColor} secondary={team.secondaryColor} size={62} />
      <div className="mt-1.5 max-w-28 truncate text-sm font-bold">{team.name}</div>
      <div className="text-xs text-slate-500">전력 {teamRating(team)}</div>
    </div>
  );
}
