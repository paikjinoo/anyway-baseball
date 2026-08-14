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
import { clearSuspendedMatch, loadSuspendedMatch } from '@/lib/firebase/store';
import {
  CPU_RESUME_KEY,
  describeSuspended,
  resumeIssue,
  RESUME_ISSUE_KO,
  savedAgoText,
  type SuspendedMatch,
} from '@/lib/game/resume';
import { TeamLogo } from '@/components/ui/TeamLogo';
import type { Side, Team } from '@/lib/game/types';

const DIFFS: Difficulty[] = ['EASY', 'NORMAL', 'HARD', 'PRO'];
const STRENGTH: Record<Difficulty, number> = { EASY: 0.85, NORMAL: 1.0, HARD: 1.1, PRO: 1.2 };

export default function CpuGamePage() {
  const router = useRouter();
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);
  const user = useAppStore((s) => s.user);

  const initCpuGame = useMatchStore((s) => s.initCpuGame);
  const resumeCpuGame = useMatchStore((s) => s.resumeCpuGame);
  const reset = useMatchStore((s) => s.reset);

  const [difficulty, setDifficulty] = useState<Difficulty>('NORMAL');
  const [side, setSide] = useState<Side>('home');
  const [started, setStarted] = useState(false);
  /** 중단해 둔 CPU 경기. 화면을 열 때 한 번 읽는다. */
  const [saved, setSaved] = useState<SuspendedMatch | null>(null);

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

  useEffect(() => {
    if (!user) return;
    setSaved(loadSuspendedMatch(user.uid, CPU_RESUME_KEY));
  }, [user]);

  const issues = useMemo(
    () => (team ? rosterIssues(team) : []),
    [team],
  );

  /** 저장된 경기를 이어서 할 수 없는 이유. null이면 이어서 할 수 있다. */
  const savedIssue = useMemo(
    () =>
      saved && user && team
        ? resumeIssue(saved, { uid: user.uid, teamId: team.id }, Date.now())
        : null,
    [saved, user, team],
  );

  function dropSaved() {
    if (user) clearSuspendedMatch(user.uid, CPU_RESUME_KEY);
    setSaved(null);
  }

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

        {saved && (
          <ResumeCard
            saved={saved}
            issue={savedIssue}
            onResume={() => {
              resumeCpuGame(saved);
              setStarted(true);
            }}
            onDrop={dropSaved}
          />
        )}

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
              // 중간에 나가도 이어서 할 수 있게 저장한다. CPU 경기 슬롯은 하나뿐이라
              // 새 경기를 시작하는 순간 이전에 중단해 둔 경기는 덮어써진다.
              resume: user ? { key: CPU_RESUME_KEY, uid: user.uid, teamId: team.id } : null,
            });
            setStarted(true);
          }}
        >
          플레이 볼!
        </button>
        {saved && !savedIssue && (
          <p className="-mt-3 text-center text-xs text-amber-300/90">
            새 경기를 시작하면 위에 저장된 경기는 사라집니다.
          </p>
        )}
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

/**
 * 중단해 둔 경기 카드.
 *
 * 이어서 할 수 없는 저장(다른 팀·오래된 것)도 지우기 버튼과 함께 보여 준다.
 * 아무 말 없이 감추면 "분명 나갔다 왔는데 없어졌다"가 되기 때문이다.
 */
function ResumeCard({
  saved,
  issue,
  onResume,
  onDrop,
}: {
  saved: SuspendedMatch;
  issue: ReturnType<typeof resumeIssue>;
  onResume: () => void;
  onDrop: () => void;
}) {
  const info = describeSuspended(saved);
  return (
    <section
      className={`panel p-5 ${issue ? 'border-white/10' : 'border-lime-400/40 bg-lime-500/[0.07]'}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-bold">{issue ? '이어서 할 수 없는 경기' : '진행 중이던 경기'}</h2>
        <span className="text-[11px] text-slate-500">
          {savedAgoText(saved.savedAt, Date.now())} 저장
        </span>
      </div>

      <div className="rounded-xl bg-black/25 px-4 py-3 text-center">
        <div className="text-xs text-slate-500">
          {info.inning} · {info.situation} · 내 팀 {info.sideLabel}
        </div>
        <div className="mt-0.5 text-xl font-black tabular">{info.score}</div>
      </div>

      {issue ? (
        <>
          <p className="mt-3 text-xs text-slate-400">{RESUME_ISSUE_KO[issue]}</p>
          <button className="btn btn-danger mt-3 w-full !py-1.5 !text-xs" onClick={onDrop}>
            저장 삭제
          </button>
        </>
      ) : (
        <div className="mt-3 flex gap-2">
          <button className="btn btn-primary flex-1 !py-2" onClick={onResume}>
            이어서 하기
          </button>
          <button
            className="btn btn-danger !py-2 !text-xs"
            onClick={() => {
              if (confirm('저장된 경기를 지울까요? 되돌릴 수 없습니다.')) onDrop();
            }}
          >
            삭제
          </button>
        </div>
      )}
    </section>
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
