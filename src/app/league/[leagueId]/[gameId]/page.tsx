'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { GameView } from '@/components/GameView';
import { useMatchStore } from '@/lib/store/matchStore';
import { getCachedTeam, saveLeague, saveTeam } from '@/lib/firebase/store';
import { recordResult } from '@/lib/game/league';
import { distributeRewards, gameRewardPoints } from '@/lib/game/training';
import type { Side, Team } from '@/lib/game/types';

/** 리그 일정에 포함된 내 팀 경기를 직접 플레이한다. */
export default function LeagueGamePage() {
  const router = useRouter();
  const { leagueId, gameId } = useParams<{ leagueId: string; gameId: string }>();
  const team = useActiveTeam();
  const leagues = useAppStore((s) => s.leagues);
  const upsertLeague = useAppStore((s) => s.upsertLeague);
  const upsertTeam = useAppStore((s) => s.upsertTeam);

  const initCpuGame = useMatchStore((s) => s.initCpuGame);
  const state = useMatchStore((s) => s.state);
  const reset = useMatchStore((s) => s.reset);
  const [ready, setReady] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const league = leagues.find((l) => l.id === leagueId) ?? null;
  const game = league?.schedule.find((g) => g.id === gameId) ?? null;

  useEffect(() => {
    if (!league || !game || !team || ready) return;
    const opponentId = game.awayTeamId === team.id ? game.homeTeamId : game.awayTeamId;
    const opponent: Team | null = getCachedTeam(opponentId);
    if (!opponent) {
      setError('상대 팀 데이터를 찾을 수 없습니다.');
      return;
    }
    const playerSide: Side = game.awayTeamId === team.id ? 'away' : 'home';
    initCpuGame({
      playerTeam: team,
      cpuTeam: opponent,
      playerSide,
      settings: league.settings,
      difficulty: 'NORMAL',
      seed: `${league.id}-${game.id}`,
    });
    setReady(true);
  }, [league, game, team, ready, initCpuGame]);

  useEffect(() => () => reset(), [reset]);

  // 종료 시 리그 결과 기록 + 보상
  useEffect(() => {
    if (!state || state.phase !== 'GAME_OVER' || recorded || !league || !game || !team) return;
    setRecorded(true);

    const next = recordResult(league, game.id, state.away.runs, state.home.runs);
    upsertLeague(next);
    void saveLeague(next);

    const playerSide: Side = game.awayTeamId === team.id ? 'away' : 'home';
    const mine = state[playerSide];
    const theirs = state[playerSide === 'away' ? 'home' : 'away'];
    const pts = gameRewardPoints({
      won: state.winner === playerSide,
      runsScored: mine.runs,
      runsAllowed: theirs.runs,
      isPlayerTeam: true,
    });
    const merged: Team = {
      ...team,
      players: distributeRewards(
        team.players.map((p) => {
          const g = mine.roster[p.id];
          if (!g) return p;
          return {
            ...p,
            season: {
              ...p.season,
              g: p.season.g + 1,
              pa: p.season.pa + g.season.pa,
              ab: p.season.ab + g.season.ab,
              h: p.season.h + g.season.h,
              double: p.season.double + g.season.double,
              triple: p.season.triple + g.season.triple,
              hr: p.season.hr + g.season.hr,
              rbi: p.season.rbi + g.season.rbi,
              r: p.season.r + g.season.r,
              bb: p.season.bb + g.season.bb,
              so: p.season.so + g.season.so,
              sb: p.season.sb + g.season.sb,
              cs: p.season.cs + g.season.cs,
              ip3: p.season.ip3 + g.season.ip3,
              er: p.season.er + g.season.er,
              pk: p.season.pk + g.season.pk,
              pbb: p.season.pbb + g.season.pbb,
              ph: p.season.ph + g.season.ph,
            },
          };
        }),
        pts,
      ),
    };
    upsertTeam(merged);
    void saveTeam(merged);
  }, [state, recorded, league, game, team, upsertLeague, upsertTeam]);

  if (error) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-sm text-rose-300">{error}</p>
        <button className="btn" onClick={() => router.push('/league')}>
          리그로 돌아가기
        </button>
      </div>
    );
  }

  if (!ready) return <div className="py-20 text-center text-slate-500">경기 준비 중…</div>;

  return (
    <GameView
      onExit={() => {
        reset();
        router.push('/league');
      }}
    />
  );
}
