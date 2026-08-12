'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { Rng, seedFromString } from '@/lib/game/rng';
import { generateTeam, teamRating } from '@/lib/game/generator';
import {
  computeStandings,
  cpuTeamOf,
  createLeague,
  isLeagueComplete,
  findLeagueGame,
  isPostseasonGame,
  leagueFinishReward,
  leagueRankedPlayers,
  nextGameFor,
  pendingPostseasonGames,
  postseasonNextGameFor,
  postseasonReward,
  recordGame,
  relinkPlayerTeam,
  seriesWins,
  simulateGame,
  startPostseason,
} from '@/lib/game/league';
import { applyMatchResult, outcomeOf } from '@/lib/game/matchReward';
import { addItems, ITEM_DEFS } from '@/lib/game/items';
import { rosterIssues } from '@/lib/game/roster';
import {
  clearSuspendedMatch,
  deleteLeague,
  findLeagueGameRecord,
  getCachedTeam,
  listSuspendedMatches,
  saveGameRecord,
  saveLeague,
  saveTeam,
} from '@/lib/firebase/store';
import {
  describeSuspended,
  matchResumeKey,
  resumeIssue,
  savedAgoText,
  type SuspendedMatch,
} from '@/lib/game/resume';
import { buildGameRecord, type GameRecord } from '@/lib/game/record';
import {
  LEADERBOARD_CATEGORIES,
  TITLE_KO,
  closeSeason,
  computeLeaders,
  computeTitlesOf,
  seasonNo,
} from '@/lib/game/season';
import { BoxScore } from '@/components/league/BoxScore';
import { TeamLogo } from '@/components/ui/TeamLogo';
import { baseballRate } from '@/lib/format';
import type { Inventory, League, LeagueGame, LeagueTeamRef, Team } from '@/lib/game/types';

/** 리더보드 부문마다 보여 줄 인원 */
const LEADER_LIMIT = 5;

export default function LeaguePage() {
  const router = useRouter();
  const user = useAppStore((s) => s.user);
  const authReady = useAppStore((s) => s.authReady);
  const dataReady = useAppStore((s) => s.dataReady);
  const activeTeam = useActiveTeam();
  const allTeams = useAppStore((s) => s.teams);
  const settings = useAppStore((s) => s.settings);
  const leagues = useAppStore((s) => s.leagues);
  const upsertLeague = useAppStore((s) => s.upsertLeague);
  const removeLeague = useAppStore((s) => s.removeLeague);
  const upsertTeam = useAppStore((s) => s.upsertTeam);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cpuCount, setCpuCount] = useState(5);
  const [rounds, setRounds] = useState(2);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 펼쳐 놓은 박스스코어. null이면 닫혀 있다. */
  const [openRecord, setOpenRecord] = useState<GameRecord | null>(null);
  /** 이 리그에서 중단해 둔 경기. 없으면 null. */
  const [suspended, setSuspended] = useState<SuspendedMatch | null>(null);

  // null은 "아직 안 골랐다", 빈 문자열은 사용자가 직접 고른 "새 리그 만들기"다.
  // 빈 문자열까지 되돌리면 새 리그 화면을 열자마자 기존 리그로 튕긴다.
  useEffect(() => {
    if (selectedId === null && leagues.length) setSelectedId(leagues[0].id);
  }, [leagues, selectedId]);

  const league = selectedId ? (leagues.find((l) => l.id === selectedId) ?? null) : null;
  const leaguePlayerRef = league?.teams.find((t) => !t.isCPU && t.ownerUid === user?.uid) ?? null;
  const leagueTeam = leaguePlayerRef
    ? (allTeams.find((t) => t.id === leaguePlayerRef.teamId) ?? null)
    : null;
  const team = league ? leagueTeam : activeTeam;
  /**
   * 리그가 가리키는 내 팀을 못 찾은 상태.
   * 이 리그로는 경기를 치를 수 없지만, 순위표와 일정은 남아 있으니 화면을 지우지 않는다.
   */
  const orphaned = !!league && !leagueTeam;
  const standings = useMemo(() => (league ? computeStandings(league) : []), [league]);
  const issues = useMemo(
    () => (team ? rosterIssues(team, settings.useDH) : []),
    [team, settings.useDH],
  );
  /** 정규 일정이 모두 끝났는가 */
  const regularDone = !!league && isLeagueComplete(league);
  /**
   * 더 칠 경기가 없는가.
   *
   * 정규 일정만 보면 안 된다 — 그러면 정규 시즌이 끝나는 순간 버튼이 잠겨 포스트시즌을
   * 시작할 수도 없다. 리그의 진짜 끝은 포스트시즌까지 끝난 시점이다.
   */
  const done =
    !!league && regularDone && (!league.postseason || league.postseason.status === 'FINISHED');

  /**
   * 중단해 둔 이 리그의 경기를 찾는다.
   *
   * 저장소를 렌더 중에 읽지 않고 여기서 읽는 이유는 하이드레이션이다 — 서버에는
   * localStorage가 없어 첫 렌더가 어긋난다.
   */
  useEffect(() => {
    if (!user || !league || !team) {
      setSuspended(null);
      return;
    }
    const found = listSuspendedMatches(user.uid).find(
      (m) => m.leagueRef?.leagueId === league.id,
    );
    const g = found?.leagueRef ? findLeagueGame(league, found.leagueRef.gameId) : null;
    if (!found || !g) {
      setSuspended(null);
      return;
    }
    const why = resumeIssue(
      found,
      { uid: user.uid, teamId: team.id, leagueGameStatus: g.status },
      Date.now(),
    );
    setSuspended(why ? null : found);
  }, [user, league, team]);

  /**
   * 사라진 팀 ID를 지금 쓰는 팀으로 자동으로 이어붙인다.
   * 팀 스키마 버전이 올라 옛 팀이 걸러졌거나 팀을 지우고 다시 창단하면 리그 전체가 잠긴다.
   * 팀이 하나뿐일 때만 잇는다 — 여러 개면 누구 기록인지 정할 수 없어 사용자에게 맡긴다.
   */
  useEffect(() => {
    if (!dataReady || !user || !activeTeam || allTeams.length !== 1) return;
    let relinked = 0;
    for (const l of leagues) {
      if (l.ownerUid !== user.uid) continue;
      const ref = l.teams.find((t) => !t.isCPU && t.ownerUid === user.uid);
      if (!ref || allTeams.some((t) => t.id === ref.teamId)) continue;
      const fixed = relinkPlayerTeam(l, activeTeam);
      if (fixed === l) continue;
      upsertLeague(fixed);
      void saveLeague(fixed);
      relinked++;
    }
    if (relinked > 0) {
      setMsg(`리그 ${relinked}개의 옛 팀 기록을 ${activeTeam.name}(으)로 이어붙였습니다.`);
    }
  }, [dataReady, user, activeTeam, allTeams, leagues, upsertLeague]);

  async function create() {
    if (!user || !activeTeam) return;
    setBusy(true);
    const rng = new Rng(seedFromString(`league-${user.uid}-${Date.now()}`));

    const refs: LeagueTeamRef[] = [
      {
        teamId: activeTeam.id,
        ownerUid: user.uid,
        name: activeTeam.name,
        abbr: activeTeam.abbr,
        primaryColor: activeTeam.primaryColor,
        secondaryColor: activeTeam.secondaryColor,
        logoId: activeTeam.logoId,
        isCPU: false,
      },
    ];
    const cpuTeams: Team[] = [];

    for (let i = 0; i < cpuCount; i++) {
      const t = generateTeam(rng, {
        ownerUid: 'cpu',
        id: `lt_${rng.int(0, 0xffffff).toString(36)}${i}`,
        strength: 0.92 + rng.next() * 0.2,
      });
      cpuTeams.push(t);
      refs.push({
        teamId: t.id,
        ownerUid: 'cpu',
        name: t.name,
        abbr: t.abbr,
        primaryColor: t.primaryColor,
        secondaryColor: t.secondaryColor,
        logoId: t.logoId,
        isCPU: true,
      });
    }

    const l = createLeague(user.uid, `${activeTeam.name} 리그`, refs, settings, rounds, cpuTeams);
    await saveLeague(l);
    upsertLeague(l);
    setSelectedId(l.id);
    setBusy(false);
    setMsg(`리그를 만들었습니다. 총 ${l.schedule.length}경기.`);
  }

  /**
   * 경기에 넣을 팀. 리그 문서에 박제된 CPU 팀이 정본이고, 없으면(구버전 리그) 캐시를 쓴다.
   * 내 팀은 cpuTeams에 없으므로 여기로 오지 않는다.
   */
  function teamForGame(l: League, teamId: string): Team | null {
    return cpuTeamOf(l, teamId) ?? getCachedTeam(teamId);
  }

  /**
   * 내 경기보다 먼저 치러야 할 다른 경기들을 시뮬레이션한다.
   *
   * 정규 시즌은 같은 라운드까지, 포스트시즌은 내가 낀 시리즈를 뺀 나머지 시리즈에서
   * 한 경기씩이다. 시리즈는 순서가 있어서 한 번에 다 돌릴 수 없다.
   */
  async function simulateOtherGames(l: League, myGame: LeagueGame): Promise<League> {
    let next = l;

    if (isPostseasonGame(l, myGame.id)) {
      // 다른 시리즈가 내 시리즈보다 뒤처지지 않도록 끝날 때까지 굴린다
      for (let guard = 0; guard < 40; guard++) {
        const pending = pendingPostseasonGames(next, team?.id);
        if (!pending.length) break;
        for (const g of pending) {
          const a = teamForGame(next, g.awayTeamId);
          const h = teamForGame(next, g.homeTeamId);
          if (!a || !h) continue;
          const r = simulateGame(a, h, next.settings, `${next.id}-${g.id}`);
          next = recordGame(next, g.id, r.state);
        }
      }
      return next;
    }

    for (const g of l.schedule) {
      if (g.status !== 'SCHEDULED' || g.round > myGame.round) continue;
      if (g.awayTeamId === team?.id || g.homeTeamId === team?.id) continue;
      // **리그 문서를 먼저 본다.** getCachedTeam이 먼저면 방금 돌린 로테이션이 안 보여
      // 한 라운드에 두 경기를 하는 팀이 같은 선발을 두 번 낸다.
      const a = teamForGame(next, g.awayTeamId);
      const h = teamForGame(next, g.homeTeamId);
      if (!a || !h) continue;
      const r = simulateGame(a, h, l.settings, `${l.id}-${g.id}`);
      next = recordGame(next, g.id, r.state);
    }
    return next;
  }

  /** 내가 다음에 치를 경기. 정규 일정을 다 소화했으면 포스트시즌으로 넘어간다. */
  function myNextGame(l: League): LeagueGame | undefined {
    if (!team) return undefined;
    return nextGameFor(l, team.id) ?? postseasonNextGameFor(l, team.id);
  }

  async function playNext() {
    if (!league || !team) return;
    const g = myNextGame(league);
    if (!g) {
      setMsg('남은 경기가 없습니다.');
      return;
    }
    setBusy(true);
    const updated = await simulateOtherGames(league, g);
    await saveLeague(updated);
    upsertLeague(updated);
    setBusy(false);
    router.push(`/league/${league.id}/${g.id}`);
  }

  async function simulateMyGame() {
    if (!league || !team) return;
    const g = myNextGame(league);
    if (!g) return;
    setBusy(true);
    const withOthers = await simulateOtherGames(league, g);
    const a = g.awayTeamId === team.id ? team : teamForGame(withOthers, g.awayTeamId);
    const h = g.homeTeamId === team.id ? team : teamForGame(withOthers, g.homeTeamId);
    if (a && h) {
      const r = simulateGame(a, h, league.settings, `${league.id}-${g.id}`);
      const next = recordGame(withOthers, g.id, r.state);
      await saveLeague(next);
      upsertLeague(next);

      // 이 경기를 치르다 나간 저장이 있었다면 이제 되살릴 수 없다 (일정이 FINAL이 됐다).
      if (user) clearSuspendedMatch(user.uid, matchResumeKey({ leagueId: league.id, gameId: g.id }));

      // 자동 진행도 직접 플레이와 똑같이 보상과 시즌 기록을 남긴다.
      const mySide = g.awayTeamId === team.id ? 'away' : 'home';
      const mine = r.state[mySide];
      const theirs = r.state[mySide === 'away' ? 'home' : 'away'];
      const reward = applyMatchResult(team, mine, {
        kind: 'LEAGUE',
        difficulty: 'NORMAL',
        outcome: outcomeOf(r.state.winner, mySide),
        runsScored: mine.runs,
        runsAllowed: theirs.runs,
        seed: r.state.rngState,
        recordSeason: true,
        decisionPitcherId: mine.pitcherId,
      });
      upsertTeam(reward.team);
      void saveTeam(reward.team);

      // 직접 플레이는 useMatchReward가 기록을 남긴다. 자동 진행은 그 훅을 지나지 않으므로
      // 여기서 남긴다 — 안 그러면 "자동으로 돌린 경기만 박스스코어가 없다"가 된다.
      // 실황 로그는 헤드리스 시뮬레이션에 없어서 비어 있다.
      saveGameRecord(
        buildGameRecord(r.state, {
          kind: 'LEAGUE',
          playedAt: Date.now(),
          leagueId: league.id,
          leagueGameId: g.id,
          decisionPitcherId: mine.pitcherId,
        }),
      );

      setMsg(
        `${a.abbr} ${r.awayScore} : ${r.homeScore} ${h.abbr} (자동 진행) · +${reward.gold.toLocaleString()}G`,
      );
    }
    setBusy(false);
  }

  /**
   * 리그 전체 개인 기록 원장. CPU는 리그 문서에, 내 팀은 Team 문서에 쌓인다.
   * 구버전 리그(cpuTeams 없음)에서는 내 팀 선수만 들어와 예전과 같은 화면이 된다.
   */
  const ranked = useMemo(
    () => (league ? leagueRankedPlayers(league, team ?? null) : []),
    [league, team],
  );

  const titles = useMemo(() => computeTitlesOf(ranked), [ranked]);

  /** 시즌을 마감하고 다음 시즌으로 넘긴다. 되돌릴 수 없어 버튼으로만 부른다. */
  async function finishSeason() {
    if (!team) return;
    setBusy(true);
    const next = closeSeason(team);
    upsertTeam(next);
    await saveTeam(next);
    setBusy(false);
    setMsg(`시즌 ${seasonNo(team)}을 마감했습니다. 이제 시즌 ${seasonNo(next)}입니다.`);
  }

  /** 아이템 목록을 "경험치보충제 ×2" 처럼 한 줄로 */
  const itemText = (items: Inventory) =>
    Object.entries(items)
      .map(([id, n]) => `${ITEM_DEFS[id as keyof typeof ITEM_DEFS].ko} ×${n}`)
      .join(', ');

  /**
   * 정규 시즌이 끝나면 1~3위 보상을 주고 **곧바로 포스트시즌을 연다.**
   * League.rewardedAt으로 한 번만 준다.
   */
  useEffect(() => {
    if (!league || !team) return;
    if (!isLeagueComplete(league) || league.rewardedAt) return;
    const prize = leagueFinishReward(league, team.id);

    // 여기서 리그를 닫지 않는다. 진짜 끝은 포스트시즌이 끝나는 시점이다.
    const next: League = startPostseason({ ...league, rewardedAt: Date.now() });
    upsertLeague(next);
    void saveLeague(next);

    if (!prize) {
      setMsg('정규 시즌이 끝났습니다. 3위 안에 들지 못해 순위 보상은 없습니다.');
      return;
    }
    const rewarded: Team = {
      ...team,
      gold: team.gold + prize.gold,
      inventory: addItems(team.inventory, prize.items),
    };
    upsertTeam(rewarded);
    void saveTeam(rewarded);
    const text = itemText(prize.items);
    setMsg(
      `정규 시즌 ${prize.rank}위! +${prize.gold.toLocaleString()}G${text ? ` · ${text}` : ''}`,
    );
  }, [league, team, upsertLeague, upsertTeam]);

  /**
   * 포스트시즌이 끝나면 우승·준우승 보상을 주고 리그를 닫는다.
   * 4강에서 떨어졌으면 보상 없이 닫기만 한다.
   */
  useEffect(() => {
    if (!league || !team) return;
    if (league.postseason?.status !== 'FINISHED' || league.postseasonRewardedAt) return;
    const prize = postseasonReward(league, team.id);

    const closed: League = { ...league, status: 'FINISHED', postseasonRewardedAt: Date.now() };
    upsertLeague(closed);
    void saveLeague(closed);

    if (!prize) {
      setMsg('포스트시즌이 끝났습니다. 다음 시즌을 노려 보세요.');
      return;
    }
    const rewarded: Team = {
      ...team,
      gold: team.gold + prize.gold,
      inventory: addItems(team.inventory, prize.items),
    };
    upsertTeam(rewarded);
    void saveTeam(rewarded);
    const text = itemText(prize.items);
    setMsg(
      `${prize.title === 'CHAMPION' ? '우승!' : '준우승'} +${prize.gold.toLocaleString()}G${
        text ? ` · ${text}` : ''
      }`,
    );
  }, [league, team, upsertLeague, upsertTeam]);

  if (!authReady || !dataReady) {
    return (
      <div className="loading-state" aria-live="polite">
        <div className="loading-mark">A/B</div>
      </div>
    );
  }

  // 리그가 가리키는 팀을 못 찾는 건 팀이 없는 것과 다르다. 창단 여부만 여기서 막는다.
  if (!user || !activeTeam) {
    return <div className="py-20 text-center text-slate-500">팀이 필요합니다.</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black">리그</h1>
        <div className="flex-1" />
        {leagues.length > 0 && (
          <select
            className="max-w-56"
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {leagues.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            {/* 리그가 망가져도 새 리그를 만들 길은 항상 열어둔다. */}
            <option value="">+ 새 리그 만들기</option>
          </select>
        )}
      </div>

      {msg && (
        <div className="rounded-xl border border-lime-500/30 bg-lime-500/10 px-4 py-2 text-sm text-lime-200">
          {msg}
        </div>
      )}

      {!league && (
        <section className="panel p-6">
          <h2 className="mb-2 text-lg font-bold">새 리그 만들기</h2>
          <p className="mb-5 text-sm text-slate-400">
            내 팀과 CPU 팀들이 참가하는 풀리그를 만듭니다. 모든 팀과 정해진 횟수만큼 맞붙고,
            승률로 순위를 매깁니다.
          </p>
          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label">CPU 팀 수: {cpuCount}팀</label>
              <input
                type="range"
                min={3}
                max={11}
                value={cpuCount}
                onChange={(e) => setCpuCount(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="field-label">팀당 맞대결 횟수: {rounds}회</label>
              <input
                type="range"
                min={1}
                max={4}
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
              />
            </div>
          </div>
          <p className="mb-4 text-xs text-slate-500">
            총 {((cpuCount + 1) * cpuCount * rounds) / 2}경기 · 내 팀은 {cpuCount * rounds}경기를 치릅니다.
          </p>
          <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>
            {busy ? '생성 중…' : '리그 생성'}
          </button>
        </section>
      )}

      {league && (
        <>
          <section className="panel p-5">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 className="font-bold">{league.name}</h2>
              <span className="text-xs text-slate-500">
                {league.schedule.filter((g) => g.status === 'FINAL').length} / {league.schedule.length}경기 완료
              </span>
              {done ? (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold text-amber-300">
                  종료
                </span>
              ) : (
                regularDone && (
                  <span className="rounded-full bg-lime-500/20 px-2 py-0.5 text-[11px] font-bold text-lime-300">
                    포스트시즌
                  </span>
                )
              )}
              <div className="flex-1" />
              <button
                className="btn btn-primary !py-1.5 !text-xs"
                onClick={() => void playNext()}
                disabled={busy || issues.length > 0 || done || orphaned}
              >
                다음 경기 플레이
              </button>
              <button
                className="btn !py-1.5 !text-xs"
                onClick={() => void simulateMyGame()}
                disabled={busy || issues.length > 0 || done || orphaned}
              >
                자동 진행
              </button>
              <button
                className="btn btn-danger !py-1.5 !text-xs"
                onClick={() => {
                  if (!confirm('리그를 삭제할까요?')) return;
                  // 이 리그 경기의 이어서 하기 저장도 같이 치운다. 남겨 두면 목록에는
                  // 보이는데 열면 "리그를 찾을 수 없습니다"가 되는 항목이 생긴다.
                  if (user) {
                    for (const m of listSuspendedMatches(user.uid)) {
                      if (m.leagueRef?.leagueId === league.id) clearSuspendedMatch(m.uid, m.key);
                    }
                  }
                  void deleteLeague(league.id);
                  removeLeague(league.id);
                  setSelectedId(null);
                  setSuspended(null);
                }}
              >
                삭제
              </button>
            </div>

            {suspended?.leagueRef && (
              <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-lime-400/40 bg-lime-500/10 p-3">
                <div className="text-xs">
                  <span className="font-bold text-lime-300">진행 중이던 경기</span>
                  <span className="mx-1.5 text-slate-600">·</span>
                  <span className="text-slate-200">{describeSuspended(suspended).headline}</span>
                  <span className="ml-1.5 text-slate-500">
                    ({savedAgoText(suspended.savedAt, Date.now())})
                  </span>
                </div>
                <div className="flex-1" />
                <button
                  className="btn btn-primary !py-1 !text-[11px]"
                  onClick={() =>
                    router.push(`/league/${league.id}/${suspended.leagueRef!.gameId}`)
                  }
                >
                  이어서 하기
                </button>
              </div>
            )}

            {orphaned && (
              <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
                <p className="mb-1 text-xs font-bold text-rose-300">
                  이 리그에 등록된 내 팀 데이터를 찾을 수 없습니다
                </p>
                <p className="text-[11px] text-rose-200/90">
                  {leaguePlayerRef
                    ? `참가 기록은 "${leaguePlayerRef.name}"을(를) 가리키는데 그 팀이 남아 있지 않습니다. 팀이 하나뿐이면 자동으로 이어붙이지만, 그러지 못했다면 리그를 삭제하고 새로 만들어야 합니다.`
                    : '이 리그에는 내 계정의 참가 기록이 없습니다. 다른 계정에서 만든 리그일 수 있습니다.'}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  순위표와 일정은 그대로 두었으니 기록은 확인할 수 있습니다. 경기 진행만 막힙니다.
                </p>
              </div>
            )}

            {issues.length > 0 && (
              <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
                <p className="mb-1 text-xs font-bold text-rose-300">선수단 편성을 먼저 마쳐야 합니다</p>
                <ul className="space-y-0.5 text-[11px] text-rose-200/90">
                  {issues.map((m) => (
                    <li key={m}>· {m}</li>
                  ))}
                </ul>
                <button className="btn mt-2 !py-1 !text-[11px]" onClick={() => router.push('/roster')}>
                  선수단으로 이동
                </button>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-slate-400">
                    <th className="px-2 py-2 text-left">순위</th>
                    <th className="px-2 py-2 text-left">팀</th>
                    <th className="px-2 py-2">승</th>
                    <th className="px-2 py-2">패</th>
                    <th className="px-2 py-2">무</th>
                    <th className="px-2 py-2">승률</th>
                    <th className="px-2 py-2">게임차</th>
                    <th className="px-2 py-2">득점</th>
                    <th className="px-2 py-2">실점</th>
                    <th className="px-2 py-2">연속</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((r, i) => (
                    <tr
                      key={r.teamId}
                      className={`border-b border-white/5 ${r.teamId === team?.id ? 'bg-lime-500/10' : ''}`}
                    >
                      <td className="px-2 py-2 font-bold">{i + 1}</td>
                      <td className="px-2 py-2">
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-sm"
                            style={{ background: r.primaryColor }}
                          />
                          <span className="font-semibold">{r.name}</span>
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center">{r.w}</td>
                      <td className="px-2 py-2 text-center">{r.l}</td>
                      <td className="px-2 py-2 text-center">{r.t}</td>
                      <td className="px-2 py-2 text-center">{baseballRate(r.pct)}</td>
                      <td className="px-2 py-2 text-center">{r.gb === 0 ? '-' : r.gb.toFixed(1)}</td>
                      <td className="px-2 py-2 text-center text-slate-400">{r.rf}</td>
                      <td className="px-2 py-2 text-center text-slate-400">{r.ra}</td>
                      <td className="px-2 py-2 text-center text-slate-400">{r.streak}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="mb-1 font-bold">개인 기록</h2>
            <p className="mb-3 text-[11px] text-slate-500">
              부문별 상위 {LEADER_LIMIT}명입니다. 포스트시즌 기록을 포함하며, 타율·방어율에는
              규정 타석·이닝이 걸립니다. 내 팀 기록에는 이 리그 밖에서 치른 경기도 들어 있습니다.
            </p>
            {ranked.length === 0 ? (
              <p className="text-sm text-slate-500">아직 기록이 없습니다.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {LEADERBOARD_CATEGORIES.map((id) => {
                  const rows = computeLeaders(ranked, id, LEADER_LIMIT);
                  return (
                    <div key={id} className="overflow-x-auto">
                      <table className="w-full text-sm tabular">
                        <thead>
                          <tr className="border-b border-white/10 text-xs text-slate-400">
                            <th className="px-2 py-2 text-left" colSpan={2}>
                              {TITLE_KO[id]}
                            </th>
                            <th className="px-2 py-2 text-right">기록</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length === 0 ? (
                            <tr className="border-b border-white/5">
                              <td className="px-2 py-2 text-slate-600" colSpan={3}>
                                규정 미달
                              </td>
                            </tr>
                          ) : (
                            rows.map((r, i) => (
                              <tr
                                key={r.playerId}
                                className={`border-b border-white/5 ${
                                  r.teamId === team?.id ? 'bg-lime-500/10' : ''
                                }`}
                              >
                                <td className="px-2 py-2 font-bold text-slate-400">{i + 1}</td>
                                <td className="px-2 py-2">
                                  <span className="font-semibold">{r.name}</span>
                                  <span className="ml-1.5 text-[11px] text-slate-500">
                                    {r.teamAbbr}
                                  </span>
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums">{r.value}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {league.postseason && (
            <section className="panel p-5">
              <h2 className="mb-1 font-bold">
                포스트시즌
                {league.postseason.championTeamId && (
                  <span className="ml-2 text-sm font-extrabold text-amber-300">
                    🏆{' '}
                    {league.teams.find((t) => t.teamId === league.postseason!.championTeamId)?.name}{' '}
                    우승
                  </span>
                )}
              </h2>
              <p className="mb-3 text-[11px] text-slate-500">
                선발은 넷뿐인데 시리즈는 계속됩니다. 로테이션과 피로가 그대로 이어집니다.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {league.postseason.series.map((s) => {
                  const hi = league.teams.find((t) => t.teamId === s.hiSeedId);
                  const lo = league.teams.find((t) => t.teamId === s.loSeedId);
                  const hiW = seriesWins(s, s.hiSeedId);
                  const loW = seriesWins(s, s.loSeedId);
                  return (
                    <div key={s.id} className="ps-series">
                      <div className="ps-series-head">
                        <span>{s.round === 2 ? '결승' : '준결승'}</span>
                        <span>{s.winsNeeded}선승</span>
                      </div>
                      <div className={`ps-team ${s.winnerId === s.hiSeedId ? 'is-winner' : ''}`}>
                        <span className="ps-seed">1</span>
                        <span className="flex-1 truncate">{hi?.name ?? '-'}</span>
                        <b>{hiW}</b>
                      </div>
                      <div className={`ps-team ${s.winnerId === s.loSeedId ? 'is-winner' : ''}`}>
                        <span className="ps-seed">2</span>
                        <span className="flex-1 truncate">{lo?.name ?? '-'}</span>
                        <b>{loW}</b>
                      </div>
                      <div className="ps-games">
                        {s.games.map((g, i) => {
                          const rec = findLeagueGameRecord(league.id, g.id);
                          const label =
                            g.status === 'FINAL' ? `${g.awayScore}:${g.homeScore}` : `${i + 1}차`;
                          return rec ? (
                            <button
                              key={g.id}
                              type="button"
                              className="ps-game is-final"
                              onClick={() => setOpenRecord(rec)}
                            >
                              {label}
                            </button>
                          ) : (
                            <span
                              key={g.id}
                              className={`ps-game ${g.status === 'FINAL' ? 'is-final' : ''}`}
                            >
                              {label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {done && team && (
            <section className="panel p-5">
              <h2 className="mb-1 font-bold">시즌 {seasonNo(team)} 결산</h2>
              <p className="mb-3 text-[11px] text-slate-500">
                리그 전체 타이틀입니다. 마감하면 이번 시즌 기록이 통산으로 넘어가고 0에서
                다시 시작합니다 — 능력치·레벨·티어는 그대로입니다.
              </p>

              {titles.length > 0 ? (
                <div className="season-titles">
                  {titles.map((t) => (
                    <div key={t.id} className="season-title">
                      <span className="season-title-name">{TITLE_KO[t.id]}</span>
                      <b>{t.name}</b>
                      <span className="season-title-value">{t.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">기록이 없어 수상자가 없습니다.</p>
              )}

              <button
                className="btn btn-primary mt-4 !py-1.5 !text-xs"
                disabled={busy}
                onClick={() => void finishSeason()}
              >
                시즌 마감하고 다음 시즌으로
              </button>
            </section>
          )}

          <section className="panel p-5">
            <h2 className="mb-3 font-bold">일정</h2>
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {league.schedule.map((g) => {
                const a = league.teams.find((t) => t.teamId === g.awayTeamId);
                const h = league.teams.find((t) => t.teamId === g.homeTeamId);
                const mine = g.awayTeamId === team?.id || g.homeTeamId === team?.id;
                // 기록은 이 기기에만 남으므로, 다른 기기에서 치른 경기는 열 수 없다.
                const rec = g.status === 'FINAL' ? findLeagueGameRecord(league.id, g.id) : null;
                const row = (
                  <>
                    <span className="w-10 text-xs text-slate-500">R{g.round}</span>
                    <span className="flex-1 text-right">{a?.abbr}</span>
                    <span className="w-16 text-center font-bold tabular">
                      {g.status === 'FINAL' ? `${g.awayScore} : ${g.homeScore}` : 'vs'}
                    </span>
                    <span className="flex-1">{h?.abbr}</span>
                    <span
                      className={`w-12 text-right text-[11px] ${
                        rec ? 'text-lime-400' : g.status === 'FINAL' ? 'text-slate-500' : 'text-amber-400'
                      }`}
                    >
                      {rec ? '기록 ›' : g.status === 'FINAL' ? '종료' : '예정'}
                    </span>
                  </>
                );
                const cls = `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  mine ? 'bg-lime-500/10' : 'bg-white/[0.03]'
                }`;

                return rec ? (
                  <button
                    key={g.id}
                    type="button"
                    className={`${cls} text-left transition hover:bg-lime-500/20`}
                    onClick={() => setOpenRecord(rec)}
                  >
                    {row}
                  </button>
                ) : (
                  <div key={g.id} className={cls}>
                    {row}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="mb-3 font-bold">참가 팀</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {league.teams.map((t) => {
                const cached = getCachedTeam(t.teamId);
                return (
                  <div key={t.teamId} className="flex items-center gap-3 rounded-xl bg-white/5 p-3">
                    <TeamLogo logoId={t.logoId} primary={t.primaryColor} secondary={t.secondaryColor} size={38} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{t.name}</div>
                      <div className="text-[11px] text-slate-500">
                        {t.isCPU ? 'CPU' : '내 팀'}
                        {cached ? ` · 전력 ${teamRating(cached)}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {openRecord && <BoxScore record={openRecord} onClose={() => setOpenRecord(null)} />}
    </div>
  );
}
