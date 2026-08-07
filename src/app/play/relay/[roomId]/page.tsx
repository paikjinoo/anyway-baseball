'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { RelayGameView } from '@/components/relay/RelayGameView';
import { RelayRoomView } from '@/components/relay/RelayRoomView';
import {
  suggestRelayPick,
  type RelayLobbyPlayer,
  type RelayPick,
  type RelayRoomRules,
} from '@/lib/game/relay';
import { PartyGuest } from '@/lib/net/party';
import type { NetMessage } from '@/lib/net/protocol';
import type { ConnState } from '@/lib/net/webrtc';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { useMatchStore } from '@/lib/store/matchStore';

export default function RelayGuestPage() {
  const router = useRouter();
  const { roomId } = useParams<{ roomId: string }>();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();
  const settings = useAppStore((s) => s.settings);
  const peerRef = useRef<PartyGuest | null>(null);
  const startedRef = useRef(false);
  const connectedRef = useRef(false);
  const [conn, setConn] = useState<ConnState>('idle');
  const [players, setPlayers] = useState<RelayLobbyPlayer[]>([]);
  const [hostUid, setHostUid] = useState('');
  const [pick, setPick] = useState<RelayPick>({ batterId: '', pitcherId: '' });
  const [ready, setReady] = useState(false);
  const [rules, setRules] = useState<RelayRoomRules>({ roundCount: null, pitchSpeedScale: settings.pitchSpeedScale });
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const uid = user?.uid ?? '';
  startedRef.current = started;

  useEffect(() => {
    if (!user || !team || !roomId || peerRef.current) return;
    setPick(suggestRelayPick(team));
    const peer = new PartyGuest(
      {
        onState: (state) => {
          setConn(state);
          if (state === 'connected' && !connectedRef.current) {
            connectedRef.current = true;
            peer.send({ t: 'HELLO', uid: user.uid, name: user.displayName, team });
          } else if ((state === 'closed' || state === 'failed') && connectedRef.current) {
            startedRef.current = false;
            useMatchStore.getState().reset();
            setStarted(false);
            router.replace('/play/relay');
          }
        },
        onError: setError,
        onMessage: (message) => handleMessage(message, peer),
      },
      { mode: 'relay' },
    );
    peerRef.current = peer;
    void peer.join(roomId, { uid: user.uid, name: user.displayName }).catch((cause) => setError(String((cause as Error)?.message ?? cause)));
    return () => {
      connectedRef.current = false;
      void peer.close();
      peerRef.current = null;
      useMatchStore.getState().reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, team?.id, roomId]);

  function handleMessage(message: NetMessage, peer: PartyGuest) {
    const store = useMatchStore.getState();
    switch (message.t) {
      case 'RELAY_LOBBY':
        setPlayers(message.players);
        setHostUid(message.hostUid);
        setRules(message.rules);
        break;
      case 'RELAY_START':
        if (!user) break;
        store.initRelayGame({
          relayState: message.state,
          mode: 'RELAY_GUEST',
          myUid: user.uid,
          settings,
          sendFn: (outgoing) => peer.send(outgoing as NetMessage),
        });
        setStarted(true);
        break;
      case 'RELAY_PITCH_GO': {
        const relay = store.relayState;
        if (!relay || message.turnId !== relay.turnId || message.pitchSeq !== relay.pitchSeq + 1) break;
        store.startRemotePitch(message.cmd);
        break;
      }
      case 'RELAY_RESULT':
        store.applyRelayResult(message.result, message.state);
        break;
      case 'RELAY_STATE':
        store.applyRelayState(message.state, message.notice);
        break;
      case 'RELAY_RESYNC':
        store.applyRelayState(message.state);
        break;
      case 'LEAVE':
        setError(message.reason || '방장이 경기를 종료했습니다.');
        startedRef.current = false;
        connectedRef.current = false;
        store.reset();
        setStarted(false);
        void peer.close();
        router.push('/play/relay');
        break;
      default:
        break;
    }
  }

  function sendPick(nextPick: RelayPick, nextReady: boolean) {
    peerRef.current?.send({ t: 'RELAY_PICK', uid, pick: nextPick, ready: nextReady });
  }

  if (!team || !user) return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;

  if (started) {
    return (
      <RelayGameView
        onExit={() => {
          startedRef.current = false;
          peerRef.current?.send({ t: 'LEAVE', reason: '참가자가 경기에서 나갔습니다.' });
          void peerRef.current?.close();
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
      hostUid={hostUid}
      myTeam={team}
      pick={pick}
      onPickChange={(next) => {
        setPick(next);
        setReady(false);
        sendPick(next, false);
      }}
      ready={ready}
      onReadyChange={(nextReady) => {
        setReady(nextReady);
        sendPick(pick, nextReady);
      }}
      rules={rules}
      error={error}
      isHost={false}
      onLeave={() => {
        connectedRef.current = false;
        peerRef.current?.send({ t: 'LEAVE', reason: '참가자가 방을 나갔습니다.' });
        void peerRef.current?.close();
        router.push('/play/relay');
      }}
    />
  );
}
