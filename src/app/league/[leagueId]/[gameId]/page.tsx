'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAppStore } from '@/lib/store/appStore';
import { GameView } from '@/components/GameView';
import { useMatchStore } from '@/lib/store/matchStore';
import { getCachedTeam, saveLeague } from '@/lib/firebase/store';
import { leagueGameIssue, recordResult } from '@/lib/game/league';
import type { Side, Team } from '@/lib/game/types';

/** 리그 일정에 포함된 내 팀 경기를 직접 플레이한다. */
export default function LeagueGamePage() {
  const router = useRouter();
  const { leagueId, gameId } = useParams<{ leagueId: string; gameId: string }>();
  const user = useAppStore((s) => s.user);
  const authReady = useAppStore((s) => s.authReady);
  const dataReady = useAppStore((s) => s.dataReady);
  const teams = useAppStore((s) => s.teams);
  const leagues = useAppStore((s) => s.leagues);
  const upsertLeague = useAppStore((s) => s.upsertLeague);

  const initCpuGame = useMatchStore((s) => s.initCpuGame);
  const state = useMatchStore((s) => s.state);
  const reset = useMatchStore((s) => s.reset);
  const [ready, setReady] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const league = leagues.find((l) => l.id === leagueId) ?? null;
  const game = league?.schedule.find((g) => g.id === gameId) ?? null;
  const playerRef = league?.teams.find((t) => !t.isCPU && t.ownerUid === user?.uid) ?? null;
  const team = teams.find((t) => t.id === playerRef?.teamId) ?? null;

  useEffect(() => {
    if (!authReady || !dataReady || ready || error) return;
    if (!user) {
      setError('로그인이 필요합니다.');
      return;
    }
    if (!league || league.ownerUid !== user.uid) {
      setError('리그를 찾을 수 없거나 접근 권한이 없습니다.');
      return;
    }
    if (!playerRef || !team) {
      setError('이 리그에 참가한 내 팀 데이터를 찾을 수 없습니다.');
      return;
    }
    const issue = leagueGameIssue(league, gameId, team.id);
    if (issue) {
      setError(issue);
      return;
    }
    if (!game) return;
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
      rewardKind: 'LEAGUE',
    });
    setReady(true);
  }, [authReady, dataReady, user, league, game, gameId, playerRef, team, ready, error, initCpuGame]);

  useEffect(() => () => reset(), [reset]);

  // 종료 시 리그 결과만 기록한다. 선수 보상(경험치·골드)은 useMatchReward가 지급한다.
  useEffect(() => {
    if (!state || state.phase !== 'GAME_OVER' || recorded || !league || !game || !team) return;
    setRecorded(true);

    // 화면을 연 뒤 다른 경로에서 먼저 처리됐더라도 결과를 다시 쓰지 않는다.
    const latestLeague = useAppStore.getState().leagues.find((l) => l.id === league.id);
    const latestGame = latestLeague?.schedule.find((g) => g.id === game.id);
    if (!latestLeague || latestGame?.status !== 'SCHEDULED') {
      reset();
      setError('이미 처리된 경기라 결과를 다시 기록하지 않았습니다.');
      return;
    }

    const next = recordResult(latestLeague, game.id, state.away.runs, state.home.runs);
    upsertLeague(next);
    void saveLeague(next);
  }, [state, recorded, league, game, team, upsertLeague, reset]);

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

  if (!authReady || !dataReady || !ready) {
    return <div className="py-20 text-center text-slate-500">경기 확인 중…</div>;
  }

  return (
    <GameView
      onExit={() => {
        reset();
        router.push('/league');
      }}
    />
  );
}
