'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAppStore } from '@/lib/store/appStore';
import { GameView } from '@/components/GameView';
import { useMatchStore } from '@/lib/store/matchStore';
import {
  clearSuspendedMatch,
  getCachedTeam,
  loadSuspendedMatch,
  saveLeague,
} from '@/lib/firebase/store';
import { cpuTeamOf, findLeagueGame, leagueGameIssue, recordGame } from '@/lib/game/league';
import {
  describeSuspended,
  matchResumeKey,
  resumeIssue,
  savedAgoText,
  type ResumeContext,
  type SuspendedMatch,
} from '@/lib/game/resume';
import type { GameSettings, Side, Team } from '@/lib/game/types';

/** 이 경기를 시작하는 데 필요한 것 전부. 이어서 할지 새로 할지는 이 다음에 정한다. */
interface GamePlan {
  team: Team;
  opponent: Team;
  playerSide: Side;
  settings: GameSettings;
  seed: string;
  leagueRef: { leagueId: string; gameId: string };
  resume: ResumeContext;
}

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
  const resumeCpuGame = useMatchStore((s) => s.resumeCpuGame);
  const state = useMatchStore((s) => s.state);
  const reset = useMatchStore((s) => s.reset);
  const [ready, setReady] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 중단해 둔 이 경기. 값이 있으면 이어서 할지 새로 할지를 물어보는 중이다.
   * 자동으로 이어 붙이지 않는 이유는, 처음부터 다시 치르고 싶을 수도 있어서다.
   */
  const [suspended, setSuspended] = useState<SuspendedMatch | null>(null);
  const planRef = useRef<GamePlan | null>(null);

  const league = leagues.find((l) => l.id === leagueId) ?? null;
  // 정규 일정과 포스트시즌 대진을 통틀어 찾는다
  const game = (league && findLeagueGame(league, gameId)) ?? null;
  const playerRef = league?.teams.find((t) => !t.isCPU && t.ownerUid === user?.uid) ?? null;
  const team = teams.find((t) => t.id === playerRef?.teamId) ?? null;

  const startFresh = useCallback(
    (plan: GamePlan) => {
      initCpuGame({
        playerTeam: plan.team,
        cpuTeam: plan.opponent,
        playerSide: plan.playerSide,
        settings: plan.settings,
        difficulty: 'NORMAL',
        seed: plan.seed,
        rewardKind: 'LEAGUE',
        leagueRef: plan.leagueRef,
        resume: plan.resume,
      });
      setSuspended(null);
      setReady(true);
    },
    [initCpuGame],
  );

  useEffect(() => {
    if (!authReady || !dataReady || ready || error || suspended) return;
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
    // 리그 문서의 CPU 팀이 정본이다 — 캐시를 먼저 보면 리그에서 돌아간 로테이션이
    // 무시돼 상대가 매번 1선발을 낸다.
    const opponent: Team | null = cpuTeamOf(league, opponentId) ?? getCachedTeam(opponentId);
    if (!opponent) {
      setError('상대 팀 데이터를 찾을 수 없습니다.');
      return;
    }
    const leagueRef = { leagueId: league.id, gameId: game.id };
    const key = matchResumeKey(leagueRef);
    const plan: GamePlan = {
      team,
      opponent,
      playerSide: game.awayTeamId === team.id ? 'away' : 'home',
      settings: league.settings,
      seed: `${league.id}-${game.id}`,
      leagueRef,
      resume: { key, uid: user.uid, teamId: team.id },
    };
    planRef.current = plan;

    // 중단해 둔 같은 경기가 있으면 먼저 물어본다.
    const found = loadSuspendedMatch(user.uid, key);
    if (found) {
      const why = resumeIssue(
        found,
        { uid: user.uid, teamId: team.id, leagueGameStatus: game.status },
        Date.now(),
      );
      if (!why) {
        setSuspended(found);
        return;
      }
      // 이어서 할 수 없는 저장은 치운다 (자동 진행으로 이미 처리된 경기 등)
      clearSuspendedMatch(user.uid, key);
    }
    startFresh(plan);
  }, [
    authReady,
    dataReady,
    user,
    league,
    game,
    gameId,
    playerRef,
    team,
    ready,
    error,
    suspended,
    startFresh,
  ]);

  useEffect(() => () => reset(), [reset]);

  // 종료 시 리그 결과만 기록한다. 선수 보상(경험치·골드)은 useMatchReward가 지급한다.
  useEffect(() => {
    if (!state || state.phase !== 'GAME_OVER' || recorded || !league || !game || !team) return;
    setRecorded(true);

    // 화면을 연 뒤 다른 경로에서 먼저 처리됐더라도 결과를 다시 쓰지 않는다.
    const latestLeague = useAppStore.getState().leagues.find((l) => l.id === league.id);
    const latestGame = latestLeague && findLeagueGame(latestLeague, game.id);
    if (!latestLeague || latestGame?.status !== 'SCHEDULED') {
      reset();
      setError('이미 처리된 경기라 결과를 다시 기록하지 않았습니다.');
      return;
    }

    // 결과와 상대 CPU 선수의 기록을 함께 적는다. 여기 state에는 내 팀 델타도 들어 있지만
    // 내 팀은 League.cpuTeams에 없으므로 리그 문서에는 닿지 않는다 (이중 계산 방지).
    // 포스트시즌 경기는 순위표에 섞이면 안 되므로 recordGame이 대진 쪽 장부로 보낸다.
    const next = recordGame(latestLeague, game.id, state);
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

  if (suspended) {
    const info = describeSuspended(suspended);
    return (
      <div className="mx-auto max-w-md space-y-4 py-10">
        <section className="panel border-lime-400/40 bg-lime-500/[0.07] p-6">
          <h1 className="text-xl font-black">진행 중이던 경기가 있습니다</h1>
          <p className="mt-1.5 text-xs text-slate-400">
            {savedAgoText(suspended.savedAt, Date.now())}에 중단한 이 일정의 경기입니다.
          </p>

          <div className="my-5 rounded-xl bg-black/25 px-4 py-4 text-center">
            <div className="text-xs text-slate-500">
              {info.inning} · {info.situation} · 내 팀 {info.sideLabel}
            </div>
            <div className="mt-1 text-2xl font-black tabular">{info.score}</div>
          </div>

          <div className="space-y-2">
            <button
              className="btn btn-primary w-full !py-2.5"
              onClick={() => {
                resumeCpuGame(suspended);
                setSuspended(null);
                setReady(true);
              }}
            >
              이어서 하기
            </button>
            <button
              className="btn w-full !py-1.5 !text-xs"
              onClick={() => {
                if (!planRef.current) return;
                if (!confirm('지금까지 친 이닝을 버리고 1회부터 다시 시작할까요?')) return;
                clearSuspendedMatch(suspended.uid, suspended.key);
                startFresh(planRef.current);
              }}
            >
              처음부터 다시 시작
            </button>
            <button
              className="btn w-full !py-1.5 !text-xs"
              onClick={() => router.push('/league')}
            >
              리그로 돌아가기
            </button>
          </div>
        </section>
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
