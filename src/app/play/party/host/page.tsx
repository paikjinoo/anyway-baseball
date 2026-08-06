'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { PartyHost } from '@/lib/net/party';
import type { ConnState } from '@/lib/net/webrtc';
import type { NetMessage, OwnerMap, PartyPicks, PartySeat } from '@/lib/net/protocol';
import { changePitcher, createGame } from '@/lib/game/engine';
import {
  buildAllStarTeam,
  disambiguateAbbr,
  suggestPicks,
  validatePartyPicks,
  type AllStarEntry,
} from '@/lib/game/allstar';
import { seedFromString } from '@/lib/game/rng';
import { GameView } from '@/components/GameView';
import { PartyRoomView } from '@/components/party/PartyRoomView';
import {
  hostResolveWithSwing,
  hostStartPitch,
  useMatchStore,
} from '@/lib/store/matchStore';
import { pickRules, type MatchRules, type Side, type Team } from '@/lib/game/types';

/** 자리 배정 순서. 방장이 홈 slot 0에 앉고, 들어온 순서대로 나머지를 채운다. */
const SEAT_ORDER: { side: Side; slot: 0 | 1 }[] = [
  { side: 'home', slot: 0 },
  { side: 'away', slot: 0 },
  { side: 'home', slot: 1 },
  { side: 'away', slot: 1 },
];

export default function PartyHostPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-slate-500">준비 중…</div>}>
      <PartyHostInner />
    </Suspense>
  );
}

function seatFromTeam(uid: string, name: string, team: Team, side: Side, slot: 0 | 1): PartySeat {
  return {
    uid,
    name,
    side,
    slot,
    teamId: team.id,
    teamName: team.name,
    teamAbbr: team.abbr,
    primaryColor: team.primaryColor,
    secondaryColor: team.secondaryColor,
    logoId: team.logoId,
    ready: false,
    connected: true,
    pickedBatters: [],
    pickedPitchers: [],
  };
}

function PartyHostInner() {
  const router = useRouter();
  const params = useSearchParams();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);

  const hostRef = useRef<PartyHost | null>(null);
  /** uid -> 그 사람의 팀 원본. 경기 시작 시 픽과 합쳐 올스타 팀을 만든다. */
  const teamsRef = useRef<Map<string, Team>>(new Map());
  const picksRef = useRef<Map<string, PartyPicks>>(new Map());

  const [conn, setConn] = useState<ConnState>('idle');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [seats, setSeats] = useState<PartySeat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [myPicks, setMyPicks] = useState<PartyPicks>({ batters: [], pitchers: [] });
  const [myReady, setMyReady] = useState(false);
  // 올스타 라인업은 야수 9명으로 짜므로 지명타자는 항상 켠 채로 둔다
  const [rules, setRules] = useState<MatchRules>(() => ({ ...pickRules(settings), useDH: true }));

  const uid = user?.uid ?? '';
  // 방을 만드는 effect는 한 번만 도는데, 그 안에서 최신 규칙을 읽어야 한다
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  // 좌석 목록을 최신 상태로 읽어야 하는 콜백들이 있어 ref로도 들고 있는다
  const seatsRef = useRef<PartySeat[]>([]);
  seatsRef.current = seats;
  const startedRef = useRef(false);
  startedRef.current = started;

  const broadcastSeats = useCallback(
    (next: PartySeat[]) => {
      setSeats(next);
      seatsRef.current = next;
      hostRef.current?.broadcast({ t: 'PARTY_SEATS', seats: next, hostUid: uid });
    },
    [uid],
  );

  // ---- 방 생성 -------------------------------------------------------------
  useEffect(() => {
    if (!user || !team || hostRef.current) return;

    teamsRef.current.set(user.uid, team);
    const initial = [seatFromTeam(user.uid, user.displayName, team, 'home', 0)];
    setSeats(initial);
    seatsRef.current = initial;
    setMyPicks(suggestPicks(team, 0));

    const host = new PartyHost({
      onPeer: (peerUid, state) => handlePeerState(peerUid, state),
      onError: setError,
      onMessage: (msg, from) => handleMessage(msg, from),
    });
    hostRef.current = host;
    setConn('creating');

    void host
      .open({
        hostUid: user.uid,
        hostName: user.displayName,
        teamName: team.name,
        isPrivate: params.get('private') === '1',
        rules: rulesRef.current,
      })
      .then((id) => {
        setRoomId(id);
        setConn('waiting');
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)));

    return () => {
      void host.close();
      hostRef.current = null;
      useMatchStore.getState().reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, team?.id]);

  // 규칙이 바뀌면 들어와 있는 사람들과 방 목록 양쪽에 알린다
  useEffect(() => {
    if (started) return;
    hostRef.current?.broadcast({ t: 'ROOM_RULES', rules });
    const id = setTimeout(() => void hostRef.current?.updateRoomRules(rules), 600);
    return () => clearTimeout(id);
  }, [rules, started]);

  function handlePeerState(peerUid: string, state: ConnState) {
    if (state !== 'closed' && state !== 'failed') return;
    const st = useMatchStore.getState();

    // 대기실에서는 자리를 완전히 비워 재접속/대체 입장이 가능하게 한다.
    if (!startedRef.current && !st.state) {
      teamsRef.current.delete(peerUid);
      picksRef.current.delete(peerUid);
      broadcastSeats(seatsRef.current.filter((s) => s.uid !== peerUid));
      return;
    }

    const next = seatsRef.current.map((s) =>
      s.uid === peerUid ? { ...s, connected: false, ready: false } : s,
    );
    broadcastSeats(next);

    // 경기 중이었다면 그 사람의 선수를 방장이 인계받아 경기가 멈추지 않게 한다
    if (st.state && Object.keys(st.owners).length) {
      const owners: OwnerMap = {};
      for (const [pid, owner] of Object.entries(st.owners)) {
        owners[pid] = owner === peerUid ? uid : owner;
      }
      st.setOwners(owners);
      const who = seatsRef.current.find((s) => s.uid === peerUid)?.name ?? '상대';
      hostRef.current?.broadcast({
        t: 'PARTY_OWNERS',
        owners,
        notice: `${who} 님의 연결이 끊겨 방장이 그 선수들을 맡습니다.`,
      });
      st.pushLog(`${who} 님의 연결이 끊겨 방장이 그 선수들을 맡습니다.`, 'info');
    }
  }

  function handleMessage(msg: NetMessage, from: string) {
    const host = hostRef.current;
    if (!host || !user || !team) return;

    switch (msg.t) {
      case 'HELLO': {
        teamsRef.current.set(from, msg.team);
        const cur = seatsRef.current;
        const existing = cur.find((s) => s.uid === from);
        let next: PartySeat[];
        if (existing) {
          next = cur.map((s) => (s.uid === from ? { ...s, connected: true } : s));
        } else {
          const spot = SEAT_ORDER.find(
            (o) => !cur.some((s) => s.side === o.side && s.slot === o.slot),
          );
          if (!spot) {
            host.sendTo(from, { t: 'LEAVE', reason: '방이 가득 찼습니다.' });
            return;
          }
          next = [...cur, seatFromTeam(from, msg.name, msg.team, spot.side, spot.slot)];
        }
        setConn('connected');
        broadcastSeats(next);
        host.sendTo(from, { t: 'ROOM_RULES', rules: rulesRef.current });
        void host.cleanupSignaling();
        break;
      }

      case 'PARTY_PICK': {
        if (typeof msg.ready !== 'boolean') break;
        const seat = seatsRef.current.find((s) => s.uid === from);
        const roster = teamsRef.current.get(from);
        if (!seat || !roster) break;
        const invalid = validatePartyPicks(roster, msg.picks, seat.slot, msg.ready);
        if (invalid) {
          host.sendTo(from, { t: 'PARTY_SEATS', seats: seatsRef.current, hostUid: uid });
          break;
        }
        picksRef.current.set(from, msg.picks);
        const nameOf = (id: string) => roster?.players.find((p) => p.id === id)?.name ?? '';
        broadcastSeats(
          seatsRef.current.map((s) =>
            s.uid === from
              ? {
                  ...s,
                  ready: msg.ready,
                  pickedBatters: msg.picks.batters.map(nameOf),
                  pickedPitchers: msg.picks.pitchers.map(nameOf),
                }
              : s,
          ),
        );
        break;
      }

      // --- 경기 중 ---
      case 'PITCH': {
        // 보낸 사람이 지금 마운드에 선 투수의 주인인지 확인한다
        const st = useMatchStore.getState();
        if (!st.state) break;
        const def = st.state[st.state.half === 'TOP' ? 'home' : 'away'];
        if (st.owners[def.pitcherId] !== from) break;
        hostStartPitch(msg.cmd);
        break;
      }
      case 'SWING': {
        const st = useMatchStore.getState();
        if (!st.state) break;
        const off = st.state[st.state.half === 'TOP' ? 'away' : 'home'];
        const batterId = off.lineup[off.atBatIndex % off.lineup.length];
        if (st.owners[batterId] !== from) break;
        hostResolveWithSwing(msg.cmd, msg.steal);
        break;
      }
      case 'SUB_PITCHER': {
        const st = useMatchStore.getState();
        if (!st.state || st.phase !== 'SETUP') break;
        // 자기 투수만 올릴 수 있다
        if (st.owners[msg.pitcherId] !== from) break;
        const next = changePitcher(structuredClone(st.state), msg.side, msg.pitcherId);
        if (next[msg.side].pitcherId === st.state[msg.side].pitcherId) break;
        st.applyRemoteState(next);
        st.pushLog(
          `${next[msg.side].name} 투수 교체: ${next[msg.side].roster[msg.pitcherId].name}`,
          'info',
        );
        host.broadcast(msg, from);
        break;
      }
      case 'RESYNC_REQ': {
        const st = useMatchStore.getState();
        if (st.state) host.sendTo(from, { t: 'RESYNC', state: st.state });
        break;
      }
      case 'LEAVE': {
        const who = seatsRef.current.find((s) => s.uid === from)?.name ?? '상대';
        setError(`${who} 님이 나갔습니다.`);
        handlePeerState(from, 'closed');
        break;
      }
      default:
        break;
    }
  }

  // ---- 자리 조정 -----------------------------------------------------------

  function swapSide(targetUid: string) {
    const cur = seatsRef.current;
    const me = cur.find((s) => s.uid === targetUid);
    if (!me) return;
    const other: Side = me.side === 'away' ? 'home' : 'away';
    const occupant = cur.find((s) => s.side === other && s.slot === me.slot);
    broadcastSeats(
      cur.map((s) => {
        if (s.uid === targetUid) return { ...s, side: other };
        if (occupant && s.uid === occupant.uid) return { ...s, side: me.side };
        return s;
      }),
    );
  }

  function shuffleSeats() {
    const cur = seatsRef.current;
    // 사람 수만큼 자리를 다시 나눠 준다 (호스트 포함)
    const order = [...cur];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    broadcastSeats(
      order.map((s, i) => ({
        ...s,
        ...SEAT_ORDER[i],
        // slot이 바뀌면 골라야 하는 야수 수가 달라지므로 다시 고르게 한다
        ready: s.slot === SEAT_ORDER[i].slot && s.ready,
      })),
    );
  }

  // ---- 내 픽 ---------------------------------------------------------------

  const mySeat = seats.find((s) => s.uid === uid);

  // 자리(slot)가 바뀌면 골라야 하는 야수 수도 달라지므로 추천 픽을 다시 잡는다
  useEffect(() => {
    if (!team || !mySeat) return;
    setMyPicks(suggestPicks(team, mySeat.slot));
    setMyReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mySeat?.slot, team?.id]);

  function applyMyPicks(picks: PartyPicks, ready: boolean) {
    if (!team) return;
    picksRef.current.set(uid, picks);
    const nameOf = (id: string) => team.players.find((p) => p.id === id)?.name ?? '';
    broadcastSeats(
      seatsRef.current.map((s) =>
        s.uid === uid
          ? {
              ...s,
              ready,
              pickedBatters: picks.batters.map(nameOf),
              pickedPitchers: picks.pitchers.map(nameOf),
            }
          : s,
      ),
    );
  }

  // ---- 경기 시작 -----------------------------------------------------------

  function startGame() {
    const host = hostRef.current;
    if (!host || !user || !team || !roomId) return;

    const entriesFor = (side: Side): [AllStarEntry, AllStarEntry] | null => {
      const rows = seatsRef.current.filter((s) => s.side === side);
      if (rows.length !== 2 || rows.some((s) => !s.connected || !s.ready)) return null;
      const built = rows.map((s) => {
        const t = teamsRef.current.get(s.uid);
        const picks = picksRef.current.get(s.uid);
        return t && picks && !validatePartyPicks(t, picks, s.slot, true)
          ? { uid: s.uid, slot: s.slot, team: t, picks }
          : null;
      });
      if (built.some((b) => !b)) return null;
      return built as [AllStarEntry, AllStarEntry];
    };

    const awayEntries = entriesFor('away');
    const homeEntries = entriesFor('home');
    if (!awayEntries || !homeEntries) {
      setError('선수 선택이 끝나지 않은 사람이 있습니다.');
      return;
    }

    const seed = `party-${roomId}-${Date.now()}`;
    // 선발 투수 추첨. 원정/홈이 서로 다른 시드를 쓰도록 한 글자씩 다르게 준다.
    const away = buildAllStarTeam(awayEntries, 'away', seedFromString(seed + ':away'));
    const home = buildAllStarTeam(homeEntries, 'home', seedFromString(seed + ':home'));
    disambiguateAbbr(away.team, home.team);

    // 사운드·카메라는 각자 자기 설정을 쓰고, 승부 조건만 방 규칙으로 덮는다.
    // 올스타 라인업은 야수 9명으로 짜므로 지명타자는 항상 쓴다.
    const gameSettings = { ...settings, ...rules, useDH: true };
    const state = createGame(away.team, home.team, gameSettings, seed);
    const owners: OwnerMap = { ...away.owners, ...home.owners };
    const seatNames = Object.fromEntries(seats.map((s) => [s.uid, s.name]));

    host.broadcast({ t: 'PARTY_START', state, settings: gameSettings, seats, owners });
    void host.setStatus('playing');

    useMatchStore.getState().initPartyGame({
      state,
      mode: 'PARTY_HOST',
      playerSide: seats.find((s) => s.uid === uid)?.side ?? 'home',
      myUid: uid,
      owners,
      seatNames,
      sendFn: (m) => host.broadcast(m as NetMessage),
    });
    setStarted(true);
  }

  // ---- 렌더 ---------------------------------------------------------------

  if (!team || !user) {
    return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;
  }

  if (started) {
    return (
      <GameView
        onExit={() => {
          hostRef.current?.broadcast({ t: 'LEAVE', reason: '방장이 나갔습니다.' });
          void hostRef.current?.close();
          useMatchStore.getState().reset();
          router.push('/play/party');
        }}
      />
    );
  }

  return (
    <PartyRoomView
      roomId={roomId}
      conn={conn}
      seats={seats}
      myUid={uid}
      hostUid={uid}
      myTeam={team}
      picks={myPicks}
      onPicksChange={(p) => {
        setMyPicks(p);
        setMyReady(false);
        applyMyPicks(p, false);
      }}
      ready={myReady}
      onReadyChange={(v) => {
        setMyReady(v);
        applyMyPicks(myPicks, v);
      }}
      error={error}
      rules={rules}
      onRulesChange={(p) => setRules((r) => ({ ...r, ...p }))}
      isHost
      onSwapSide={swapSide}
      onShuffle={shuffleSeats}
      onStart={startGame}
      onLeave={() => {
        hostRef.current?.broadcast({ t: 'LEAVE', reason: '방장이 방을 닫았습니다.' });
        void hostRef.current?.close();
        router.push('/play/party');
      }}
    />
  );
}
