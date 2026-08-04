'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { GameView } from '@/components/GameView';
import { useMatchStore } from '@/lib/store/matchStore';
import { DIFFICULTY_LABELS, type Difficulty } from '@/lib/game/ai';
import { Rng, seedFromString } from '@/lib/game/rng';
import { generateTeam, teamRating } from '@/lib/game/generator';
import { distributeRewards, gameRewardPoints } from '@/lib/game/training';
import { saveTeam } from '@/lib/firebase/store';
import { TeamLogo } from '@/components/ui/TeamLogo';
import type { Side, Team } from '@/lib/game/types';

const DIFFS: Difficulty[] = ['EASY', 'NORMAL', 'HARD', 'PRO'];
const STRENGTH: Record<Difficulty, number> = { EASY: 0.85, NORMAL: 1.0, HARD: 1.1, PRO: 1.2 };

export default function CpuGamePage() {
  const router = useRouter();
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);
  const upsertTeam = useAppStore((s) => s.upsertTeam);

  const initCpuGame = useMatchStore((s) => s.initCpuGame);
  const reset = useMatchStore((s) => s.reset);
  const state = useMatchStore((s) => s.state);

  const [difficulty, setDifficulty] = useState<Difficulty>('NORMAL');
  const [side, setSide] = useState<Side>('home');
  const [started, setStarted] = useState(false);
  const [rewarded, setRewarded] = useState(false);

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

  // 경기 종료 시 훈련 포인트 지급
  useEffect(() => {
    if (!state || state.phase !== 'GAME_OVER' || rewarded || !team) return;
    setRewarded(true);
    const mine = state[side];
    const theirs = state[side === 'away' ? 'home' : 'away'];
    const pts = gameRewardPoints({
      won: state.winner === side,
      runsScored: mine.runs,
      runsAllowed: theirs.runs,
      isPlayerTeam: true,
    });

    // 경기에서 쌓인 시즌 스탯을 원본 팀에 반영하고 포인트를 분배한다
    const merged: Team = {
      ...team,
      players: team.players.map((p) => {
        const inGame = mine.roster[p.id];
        if (!inGame) return p;
        const s = inGame.season;
        return {
          ...p,
          season: {
            ...p.season,
            g: p.season.g + 1,
            pa: p.season.pa + s.pa,
            ab: p.season.ab + s.ab,
            h: p.season.h + s.h,
            double: p.season.double + s.double,
            triple: p.season.triple + s.triple,
            hr: p.season.hr + s.hr,
            rbi: p.season.rbi + s.rbi,
            r: p.season.r + s.r,
            bb: p.season.bb + s.bb,
            so: p.season.so + s.so,
            sb: p.season.sb + s.sb,
            cs: p.season.cs + s.cs,
            ip3: p.season.ip3 + s.ip3,
            er: p.season.er + s.er,
            pk: p.season.pk + s.pk,
            pbb: p.season.pbb + s.pbb,
            ph: p.season.ph + s.ph,
            w: p.season.w + (state.winner === side && p.id === mine.pitcherId ? 1 : 0),
            l: p.season.l + (state.winner !== side && state.winner !== 'TIE' && p.id === mine.pitcherId ? 1 : 0),
          },
        };
      }),
    };
    merged.players = distributeRewards(merged.players, pts);
    upsertTeam(merged);
    void saveTeam(merged);
  }, [state, rewarded, team, side, upsertTeam]);

  if (!team || !cpuTeam) {
    return <div className="py-20 text-center text-slate-500">팀이 필요합니다.</div>;
  }

  if (!started) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 py-6">
        <h1 className="text-2xl font-black">CPU 대전</h1>

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

        <button
          className="btn btn-primary w-full !py-3 text-base"
          onClick={() => {
            initCpuGame({
              playerTeam: team,
              cpuTeam,
              playerSide: side,
              settings,
              difficulty,
            });
            setRewarded(false);
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
