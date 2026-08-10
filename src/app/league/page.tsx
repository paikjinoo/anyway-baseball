'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { Rng, seedFromString } from '@/lib/game/rng';
import { generateTeam, teamRating } from '@/lib/game/generator';
import {
  computeStandings,
  createLeague,
  isLeagueComplete,
  leagueFinishReward,
  nextGameFor,
  recordResult,
  simulateGame,
} from '@/lib/game/league';
import { applyMatchResult, outcomeOf } from '@/lib/game/matchReward';
import { addItems, ITEM_DEFS } from '@/lib/game/items';
import { rosterIssues } from '@/lib/game/roster';
import { deleteLeague, getCachedTeam, saveLeague, saveTeam } from '@/lib/firebase/store';
import { TeamLogo } from '@/components/ui/TeamLogo';
import { baseballRate } from '@/lib/format';
import type { League, LeagueTeamRef, Team } from '@/lib/game/types';

export default function LeaguePage() {
  const router = useRouter();
  const user = useAppStore((s) => s.user);
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

  useEffect(() => {
    if (!selectedId && leagues.length) setSelectedId(leagues[0].id);
  }, [leagues, selectedId]);

  const league = leagues.find((l) => l.id === selectedId) ?? null;
  const leaguePlayerRef = league?.teams.find((t) => !t.isCPU && t.ownerUid === user?.uid);
  const team = league
    ? (allTeams.find((t) => t.id === leaguePlayerRef?.teamId) ?? null)
    : activeTeam;
  const standings = useMemo(() => (league ? computeStandings(league) : []), [league]);
  const issues = useMemo(
    () => (team ? rosterIssues(team, settings.useDH) : []),
    [team, settings.useDH],
  );
  /** 일정이 모두 끝났는가. 끝난 리그에서는 더 칠 경기가 없다. */
  const done = !!league && isLeagueComplete(league);

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

  /** 플레이어 팀 경기를 제외한 나머지를 라운드 단위로 시뮬레이션 */
  async function simulateOtherGames(l: League, upToRound: number): Promise<League> {
    let next = l;
    for (const g of l.schedule) {
      if (g.status !== 'SCHEDULED' || g.round > upToRound) continue;
      if (g.awayTeamId === team?.id || g.homeTeamId === team?.id) continue;
      const a = getCachedTeam(g.awayTeamId);
      const h = getCachedTeam(g.homeTeamId);
      if (!a || !h) continue;
      const r = simulateGame(a, h, l.settings, `${l.id}-${g.id}`);
      next = recordResult(next, g.id, r.awayScore, r.homeScore);
    }
    return next;
  }

  async function playNext() {
    if (!league || !team) return;
    const g = nextGameFor(league, team.id);
    if (!g) {
      setMsg('남은 경기가 없습니다.');
      return;
    }
    setBusy(true);
    // 같은 라운드의 다른 경기를 먼저 처리한다
    const updated = await simulateOtherGames(league, g.round);
    await saveLeague(updated);
    upsertLeague(updated);
    setBusy(false);
    router.push(`/league/${league.id}/${g.id}`);
  }

  async function simulateMyGame() {
    if (!league || !team) return;
    const g = nextGameFor(league, team.id);
    if (!g) return;
    setBusy(true);
    const a = g.awayTeamId === team.id ? team : getCachedTeam(g.awayTeamId);
    const h = g.homeTeamId === team.id ? team : getCachedTeam(g.homeTeamId);
    if (a && h) {
      const withOthers = await simulateOtherGames(league, g.round);
      const r = simulateGame(a, h, league.settings, `${league.id}-${g.id}`);
      const next = recordResult(withOthers, g.id, r.awayScore, r.homeScore);
      await saveLeague(next);
      upsertLeague(next);

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
      setMsg(
        `${a.abbr} ${r.awayScore} : ${r.homeScore} ${h.abbr} (자동 진행) · +${reward.gold.toLocaleString()}G`,
      );
    }
    setBusy(false);
  }

  /**
   * 리그가 끝났으면 1~3위에게 골드와 아이템을 지급한다.
   * League.rewardedAt으로 한 번만 준다. 아이템이 나오는 유일한 경로다.
   */
  useEffect(() => {
    if (!league || !team) return;
    if (!isLeagueComplete(league) || league.rewardedAt) return;
    const prize = leagueFinishReward(league, team.id);

    const closed: League = { ...league, status: 'FINISHED', rewardedAt: Date.now() };
    upsertLeague(closed);
    void saveLeague(closed);

    if (!prize) {
      setMsg('리그가 끝났습니다. 3위 안에 들지 못해 종료 보상은 없습니다.');
      return;
    }
    const rewarded: Team = {
      ...team,
      gold: team.gold + prize.gold,
      inventory: addItems(team.inventory, prize.items),
    };
    upsertTeam(rewarded);
    void saveTeam(rewarded);
    const itemText = Object.entries(prize.items)
      .map(([id, n]) => `${ITEM_DEFS[id as keyof typeof ITEM_DEFS].ko} ×${n}`)
      .join(', ');
    setMsg(
      `리그 ${prize.rank}위! +${prize.gold.toLocaleString()}G${itemText ? ` · ${itemText}` : ''}`,
    );
  }, [league, team, upsertLeague, upsertTeam]);

  if (!user || !team) {
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
              {done && (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold text-amber-300">
                  종료
                </span>
              )}
              <div className="flex-1" />
              <button
                className="btn btn-primary !py-1.5 !text-xs"
                onClick={() => void playNext()}
                disabled={busy || issues.length > 0 || done}
              >
                다음 경기 플레이
              </button>
              <button
                className="btn !py-1.5 !text-xs"
                onClick={() => void simulateMyGame()}
                disabled={busy || issues.length > 0 || done}
              >
                자동 진행
              </button>
              <button
                className="btn btn-danger !py-1.5 !text-xs"
                onClick={() => {
                  if (!confirm('리그를 삭제할까요?')) return;
                  void deleteLeague(league.id);
                  removeLeague(league.id);
                  setSelectedId(null);
                }}
              >
                삭제
              </button>
            </div>

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
                      className={`border-b border-white/5 ${r.teamId === team.id ? 'bg-lime-500/10' : ''}`}
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
            <h2 className="mb-3 font-bold">일정</h2>
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {league.schedule.map((g) => {
                const a = league.teams.find((t) => t.teamId === g.awayTeamId);
                const h = league.teams.find((t) => t.teamId === g.homeTeamId);
                const mine = g.awayTeamId === team.id || g.homeTeamId === team.id;
                return (
                  <div
                    key={g.id}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                      mine ? 'bg-lime-500/10' : 'bg-white/[0.03]'
                    }`}
                  >
                    <span className="w-10 text-xs text-slate-500">R{g.round}</span>
                    <span className="flex-1 text-right">{a?.abbr}</span>
                    <span className="w-16 text-center font-bold tabular">
                      {g.status === 'FINAL' ? `${g.awayScore} : ${g.homeScore}` : 'vs'}
                    </span>
                    <span className="flex-1">{h?.abbr}</span>
                    <span
                      className={`w-12 text-right text-[11px] ${
                        g.status === 'FINAL' ? 'text-slate-500' : 'text-amber-400'
                      }`}
                    >
                      {g.status === 'FINAL' ? '종료' : '예정'}
                    </span>
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
    </div>
  );
}
