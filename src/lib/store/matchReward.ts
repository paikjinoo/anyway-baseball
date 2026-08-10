'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from './appStore';
import { isRelayMode, useMatchStore } from './matchStore';
import { relayStandings } from '../game/relay';
import {
  applyMatchResult,
  outcomeOf,
  relayOutcome,
  type MatchOutcome,
  type MatchRewardContext,
  type PlayerExpLine,
} from '../game/matchReward';
import { claimOnlineReward, saveTeam } from '../firebase/store';
import type { Team, TeamInGame } from '../game/types';

/**
 * 경기 종료 보상 지급. **모든 모드가 이 훅 하나를 지난다.**
 *
 * 예전에는 CPU 페이지 · 리그 페이지 · 온라인 훅이 각자 보상을 계산했고, 그중 CPU와 리그는
 * 화면에 아무것도 띄우지 않아 "이겼는데 뭘 받았는지 모르겠다"가 됐다. 지금은 한 곳에서
 * 지급하고 한 장의 카드로 보여 준다.
 *
 * 온라인·릴레이는 시즌 기록을 남기지 않고 하루 한도가 걸린다 — 상대 팀 전력이 제각각이라
 * 같은 기록도 의미가 달라지고, 무엇보다 짜고 친 성적이 통산 기록에 섞이면 되돌릴 수 없다.
 */

export interface MatchRewardSummary {
  /** 경기 결과로 산정된 골드 (하루 한도 적용 전) */
  earnedGold: number;
  /** 실제로 지급된 골드 */
  gold: number;
  /** 선수별 경험치 내역 (많이 받은 순) */
  lines: PlayerExpLine[];
  /** 총 경험치 */
  totalExp: number;
  /** 레벨업한 선수 수 */
  levelUps: number;
  /** 하루 한도에 걸려 깎였는가 (온라인·릴레이 전용) */
  capped: boolean;
  /** 하루 한도 진행 상황. 오프라인 모드는 null. */
  daily: { goldUsed: number; goldCap: number; expUsed: number; expCap: number } | null;
  /** 보상 근거. "승리" / "4명 중 2위" 처럼 화면에 그대로 쓴다. */
  reason: string;
}

type Store = ReturnType<typeof useMatchStore.getState>;

interface Basis {
  outcome: MatchOutcome;
  reason: string;
  mine: TeamInGame | null;
  runsScored: number;
  runsAllowed: number;
  seed: number;
  decisionPitcherId?: string;
}

/** 이 경기의 승패와 내 팀 상태. 받을 자격이 없으면 null. */
function rewardBasis(st: Store): Basis | null {
  if (isRelayMode(st.mode)) {
    const relay = st.relayState;
    if (!relay) return null;
    const rows = relayStandings(relay);
    const me = rows.find((r) => r.uid === st.myUid);
    // relayStandings는 기권자를 빼고 매긴다. 도중에 기권하면 보상도 없다.
    if (!me) return null;
    return {
      outcome: relayOutcome(me.rank, rows.length),
      reason: `${rows.length}명 중 ${me.rank}위`,
      mine: null,
      runsScored: me.score,
      runsAllowed: 0,
      seed: relay.rngState ?? 1,
    };
  }

  const game = st.state;
  if (!game?.winner) return null;
  const mine = game[st.playerSide];
  const theirs = game[st.playerSide === 'away' ? 'home' : 'away'];
  const outcome = outcomeOf(game.winner, st.playerSide);
  return {
    outcome,
    reason: outcome === 'WIN' ? '승리' : outcome === 'DRAW' ? '무승부' : '패배',
    mine,
    runsScored: mine.runs,
    runsAllowed: theirs.runs,
    seed: game.rngState,
    decisionPitcherId: mine.pitcherId,
  };
}

export function useMatchReward(): MatchRewardSummary | null {
  const [summary, setSummary] = useState<MatchRewardSummary | null>(null);
  const claimed = useRef(false);
  // 릴레이는 순환표가, 그 밖의 모드는 엔진 상태가 종료를 알린다
  const over = useMatchStore(
    (s) => s.state?.phase === 'GAME_OVER' || s.relayState?.phase === 'GAME_OVER',
  );

  useEffect(() => {
    if (!over || claimed.current) return;

    const st = useMatchStore.getState();
    const app = useAppStore.getState();
    const uid = app.user?.uid;
    const team = app.teams.find((t) => t.id === app.activeTeamId) ?? null;
    if (!uid || !team) return;

    const basis = rewardBasis(st);
    if (!basis) return;
    claimed.current = true;

    const kind = st.rewardKind;
    const online = kind === 'ONLINE' || kind === 'RELAY';
    const ctx: MatchRewardContext = {
      kind,
      difficulty: st.difficulty,
      outcome: basis.outcome,
      runsScored: basis.runsScored,
      runsAllowed: basis.runsAllowed,
      seed: basis.seed,
      recordSeason: !online,
      decisionPitcherId: basis.decisionPitcherId,
    };

    const result = applyMatchResult(team, basis.mine, ctx);
    let next: Team = result.team;
    let gold = result.gold;
    let lines = result.lines;
    let capped = false;
    let daily: MatchRewardSummary['daily'] = null;

    if (online) {
      // 담합 방지 총량 제한. 한도를 넘긴 만큼은 아예 지급하지 않는다.
      const totalExp = lines.reduce((a, l) => a + l.exp, 0);
      const claim = claimOnlineReward(uid, { gold: result.gold, exp: totalExp });
      capped = claim.granted.gold < result.gold || claim.granted.exp < totalExp;
      daily = {
        goldUsed: claim.usedToday.gold,
        goldCap: claim.cap.gold,
        expUsed: claim.usedToday.exp,
        expCap: claim.cap.exp,
      };

      if (capped) {
        // 한도가 남은 비율만큼만 다시 계산한다 (전부 버리면 "이겼는데 0"이 되므로).
        const expRatio = totalExp > 0 ? claim.granted.exp / totalExp : 0;
        const scaled = applyMatchResult(team, basis.mine, {
          ...ctx,
          expScale: expRatio,
        });
        next = { ...scaled.team, gold: team.gold + claim.granted.gold };
        gold = claim.granted.gold;
        lines = scaled.lines;
      }
    }

    app.upsertTeam(next);
    void saveTeam(next);

    setSummary({
      earnedGold: result.gold,
      gold,
      lines,
      totalExp: lines.reduce((a, l) => a + l.exp, 0),
      levelUps: lines.reduce((a, l) => a + l.levelUps, 0),
      capped,
      daily,
      reason: basis.reason,
    });
  }, [over]);

  return summary;
}
