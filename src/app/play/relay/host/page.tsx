'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RelayGameView } from '@/components/relay/RelayGameView';
import { RelayRoomView } from '@/components/relay/RelayRoomView';
import {
  createRelayState,
  canAcceptRelayPitch,
  canAcceptRelaySwing,
  forfeitRelayParticipant,
  isValidRelayRoundCount,
  relayParticipant,
  suggestRelayPick,
  validateRelayPick,
  type RelayLobbyPlayer,
  type RelayPick,
  type RelayRoomRules,
} from '@/lib/game/relay';
import type { Team } from '@/lib/game/types';
import { PartyHost } from '@/lib/net/party';
import type { NetMessage } from '@/lib/net/protocol';
import type { ConnState } from '@/lib/net/webrtc';
import { hostResolveWithSwing, hostStartPitch, useMatchStore } from '@/lib/store/matchStore';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';

export default function RelayHostPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-slate-500">준비 중…</div>}>
      <RelayHostInner />
    </Suspense>
  );
}

function lobbyPlayer(uid: string, name: string, team: Team): RelayLobbyPlayer {
  return {
    uid,
    name,
    teamId: team.id,
    teamName: team.name,
    teamAbbr: team.abbr,
    logoId: team.logoId,
    primaryColor: team.primaryColor,
    secondaryColor: team.secondaryColor,
    ready: false,
    connected: true,
    pickedBatter: '',
    pickedPitcher: '',
  };
}

function RelayHostInner() {
  const router = useRouter();
  const params = useSearchParams();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);
  const hostRef = useRef<PartyHost | null>(null);
  const teamsRef = useRef<Map<string, Team>>(new Map());
  const picksRef = useRef<Map<string, RelayPick>>(new Map());
  const playersRef = useRef<RelayLobbyPlayer[]>([]);
  const rulesRef = useRef<RelayRoomRules>({ roundCount: null, pitchSpeedScale: settings.pitchSpeedScale });
  const startedRef = useRef(false);

  const [conn, setConn] = useState<ConnState>('idle');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [players, setPlayers] = useState<RelayLobbyPlayer[]>([]);
  const [rules, setRules] = useState<RelayRoomRules>(rulesRef.current);
  const [myPick, setMyPick] = useState<RelayPick>({ batterId: '', pitcherId: '' });
  const [myReady, setMyReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const uid = user?.uid ?? '';

  startedRef.current = started;
  playersRef.current = players;
  rulesRef.current = rules;

  const publishLobby = useCallback((nextPlayers: RelayLobbyPlayer[], requestedRules?: RelayRoomRules) => {
    let nextRules = requestedRules ?? rulesRef.current;
    const count = nextPlayers.filter((p) => p.connected).length;
    if (!isValidRelayRoundCount(count, nextRules.roundCount)) {
      nextRules = { ...nextRules, roundCount: null };
    }
    playersRef.current = nextPlayers;
    rulesRef.current = nextRules;
    setPlayers(nextPlayers);
    setRules(nextRules);
    hostRef.current?.broadcast({ t: 'RELAY_LOBBY', players: nextPlayers, hostUid: uid, rules: nextRules });
  }, [uid]);

  useEffect(() => {
    if (!user || !team || hostRef.current) return;
    const pick = suggestRelayPick(team);
    const me = {
      ...lobbyPlayer(user.uid, user.displayName, team),
      pickedBatter: team.players.find((p) => p.id === pick.batterId)?.name ?? '',
      pickedPitcher: team.players.find((p) => p.id === pick.pitcherId)?.name ?? '',
    };
    teamsRef.current.set(user.uid, team);
    picksRef.current.set(user.uid, pick);
    setMyPick(pick);
    playersRef.current = [me];
    setPlayers([me]);

    const host = new PartyHost(
      {
        onPeer: (peerUid, state) => handlePeerState(peerUid, state),
        onError: setError,
        onMessage: (message, from) => handleMessage(message, from),
      },
      { mode: 'relay', maxGuests: 6 },
    );
    hostRef.current = host;
    setConn('creating');
    void host
      .open({
        hostUid: user.uid,
        hostName: user.displayName,
        teamName: team.name,
        isPrivate: params.get('private') === '1',
        relayRules: rulesRef.current,
      })
      .then((id) => {
        setRoomId(id);
        setConn('waiting');
      })
      .catch((cause) => setError(String((cause as Error)?.message ?? cause)));

    return () => {
      void host.close();
      hostRef.current = null;
      useMatchStore.getState().reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, team?.id]);

  useEffect(() => {
    if (started) return;
    const id = setTimeout(() => void hostRef.current?.updateRelayRules(rules), 500);
    return () => clearTimeout(id);
  }, [rules, started]);

  function handlePeerState(peerUid: string, state: ConnState) {
    if (state !== 'closed' && state !== 'failed') return;
    if (!startedRef.current) {
      teamsRef.current.delete(peerUid);
      picksRef.current.delete(peerUid);
      publishLobby(playersRef.current.filter((p) => p.uid !== peerUid));
      return;
    }
    forfeit(peerUid, '연결이 끊겨 기권 처리되었습니다.');
  }

  function handleMessage(message: NetMessage, from: string) {
    const host = hostRef.current;
    if (!host || !user || !team) return;
    switch (message.t) {
      case 'HELLO': {
        if (startedRef.current) {
          host.sendTo(from, { t: 'LEAVE', reason: '이미 시작된 경기입니다.' });
          return;
        }
        teamsRef.current.set(from, message.team);
        const current = playersRef.current;
        const existing = current.find((p) => p.uid === from);
        const next = existing
          ? current.map((p) => p.uid === from ? { ...p, connected: true } : p)
          : [...current, lobbyPlayer(from, message.name, message.team)];
        setConn('connected');
        publishLobby(next);
        host.sendTo(from, { t: 'RELAY_LOBBY', players: next, hostUid: user.uid, rules: rulesRef.current });
        void host.cleanupSignaling();
        break;
      }
      case 'RELAY_PICK': {
        if (startedRef.current || typeof message.ready !== 'boolean') break;
        const roster = teamsRef.current.get(from);
        if (!roster || validateRelayPick(roster, message.pick)) {
          host.sendTo(from, { t: 'RELAY_LOBBY', players: playersRef.current, hostUid: user.uid, rules: rulesRef.current });
          break;
        }
        picksRef.current.set(from, message.pick);
        const batter = roster.players.find((p) => p.id === message.pick.batterId)?.name ?? '';
        const pitcher = roster.players.find((p) => p.id === message.pick.pitcherId)?.name ?? '';
        publishLobby(playersRef.current.map((p) => p.uid === from ? { ...p, ready: message.ready, pickedBatter: batter, pickedPitcher: pitcher } : p));
        break;
      }
      case 'RELAY_PITCH': {
        const store = useMatchStore.getState();
        const relay = store.relayState;
        if (!relay || store.phase !== 'SETUP') break;
        if (!canAcceptRelayPitch(relay, from, message.turnId, message.pitchSeq)) break;
        hostStartPitch(message.cmd);
        break;
      }
      case 'RELAY_SWING': {
        const store = useMatchStore.getState();
        const relay = store.relayState;
        if (!relay || store.phase !== 'FLIGHT') break;
        if (!canAcceptRelaySwing(relay, from, message.turnId, message.pitchSeq)) break;
        hostResolveWithSwing(message.cmd);
        break;
      }
      case 'RELAY_RESYNC_REQ': {
        const relay = useMatchStore.getState().relayState;
        if (relay) host.sendTo(from, { t: 'RELAY_RESYNC', state: relay });
        break;
      }
      case 'LEAVE':
        if (startedRef.current) forfeit(from, '경기에서 나가 기권 처리되었습니다.');
        else handlePeerState(from, 'closed');
        break;
      default:
        break;
    }
  }

  function forfeit(targetUid: string, reason: string) {
    const store = useMatchStore.getState();
    if (!store.relayState) return;
    const participant = store.relayState.participants.find((p) => p.uid === targetUid);
    if (!participant || participant.forfeited) return;
    const who = participant.name;
    const next = forfeitRelayParticipant(store.relayState, targetUid);
    const notice = `${who} 님이 ${reason}`;
    store.applyRelayState(next, notice);
    hostRef.current?.broadcast({ t: 'RELAY_STATE', state: next, notice });
  }

  function applyMyPick(pick: RelayPick, ready: boolean) {
    if (!team) return;
    picksRef.current.set(uid, pick);
    const batter = team.players.find((p) => p.id === pick.batterId)?.name ?? '';
    const pitcher = team.players.find((p) => p.id === pick.pitcherId)?.name ?? '';
    publishLobby(playersRef.current.map((p) => p.uid === uid ? { ...p, ready, pickedBatter: batter, pickedPitcher: pitcher } : p));
  }

  function startGame() {
    if (!roomId || !user || !team || !rules.roundCount) return;
    const rows = playersRef.current.filter((p) => p.connected);
    if (rows.length < 2 || rows.length > 7 || rows.some((p) => !p.ready)) {
      setError('2~7명의 참가자가 모두 준비해야 합니다.');
      return;
    }
    if (!isValidRelayRoundCount(rows.length, rules.roundCount)) {
      setError('현재 인원에 맞는 라운드를 선택해 주세요.');
      return;
    }
    try {
      const participants = rows.map((row) => {
        const roster = teamsRef.current.get(row.uid);
        const pick = picksRef.current.get(row.uid);
        if (!roster || !pick) throw new Error(`${row.name} 님의 선수 선택이 없습니다.`);
        return relayParticipant(row.uid, row.name, roster, pick);
      });
      const relayState = createRelayState(
        participants,
        { roundCount: rules.roundCount, pitchSpeedScale: rules.pitchSpeedScale },
        `relay-${roomId}-${Date.now()}`,
      );
      hostRef.current?.broadcast({ t: 'RELAY_START', state: relayState });
      void hostRef.current?.setStatus('playing');
      useMatchStore.getState().initRelayGame({
        relayState,
        mode: 'RELAY_HOST',
        myUid: user.uid,
        settings,
        sendFn: (message) => hostRef.current?.broadcast(message as NetMessage),
      });
      setStarted(true);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    }
  }

  if (!user || !team) return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;

  if (started) {
    return (
      <RelayGameView
        onExit={() => {
          hostRef.current?.broadcast({ t: 'LEAVE', reason: '방장이 나가 경기가 종료되었습니다.' });
          void hostRef.current?.close();
          useMatchStore.getState().reset();
          router.push('/play/relay');
        }}
      />
    );
  }

  return (
    <RelayRoomView
      roomId={roomId}
      conn={conn}
      players={players}
      myUid={uid}
      hostUid={uid}
      myTeam={team}
      pick={myPick}
      onPickChange={(pick) => {
        setMyPick(pick);
        setMyReady(false);
        applyMyPick(pick, false);
      }}
      ready={myReady}
      onReadyChange={(ready) => {
        setMyReady(ready);
        applyMyPick(myPick, ready);
      }}
      rules={rules}
      onRulesChange={(next) => publishLobby(playersRef.current, next)}
      error={error}
      isHost
      onStart={startGame}
      onLeave={() => {
        hostRef.current?.broadcast({ t: 'LEAVE', reason: '방장이 방을 닫았습니다.' });
        void hostRef.current?.close();
        router.push('/play/relay');
      }}
    />
  );
}
