'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { firebaseConfigured } from '@/lib/firebase/client';
import { teamRating } from '@/lib/game/generator';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { watchOpenRooms, type RoomInfo } from '@/lib/net/webrtc';

export default function RelayLobbyPage() {
  const router = useRouter();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [code, setCode] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);

  useEffect(() => {
    if (!firebaseConfigured) return;
    return watchOpenRooms(setRooms, 'relay');
  }, []);

  if (!firebaseConfigured) {
    return (
      <div className="panel mx-auto max-w-lg p-8 text-center">
        <h1 className="mb-3 text-xl font-bold">릴레이 대결을 사용할 수 없습니다</h1>
        <p className="text-sm text-slate-400">온라인 대전에는 Firebase 설정이 필요합니다.</p>
      </div>
    );
  }
  if (!team || !user) return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;
  if (user.isGuest) {
    return <div className="panel mx-auto max-w-md p-8 text-center text-sm text-slate-400">온라인 대전은 Google 로그인이 필요합니다.</div>;
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-black">릴레이 타격 대결</h1>

      <section className="panel p-5">
        <h2 className="mb-2 font-bold">2~7인 개인전</h2>
        <ul className="space-y-1 text-[13px] leading-relaxed text-slate-400">
          <li>· 라운드마다 한 명이 투수, 나머지는 각자 고른 타자로 1타석을 진행합니다.</li>
          <li>· 일반 안타·볼넷·사구는 1점, 홈런은 3점입니다.</li>
          <li>· 약한 타구와 팝업은 아웃이며 수비·주루·번트·투수 교체는 없습니다.</li>
          <li>· 모든 참가자가 같은 횟수로 투수 역할을 하도록 인원수의 배수 라운드만 사용합니다.</li>
        </ul>
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 font-bold">방 만들기</h2>
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="h-4 w-4 accent-lime-500"
          />
          비공개 방 (코드로만 입장)
        </label>
        <button className="btn btn-primary" onClick={() => router.push(`/play/relay/host?private=${isPrivate ? '1' : '0'}`)}>
          방 만들기
        </button>
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 font-bold">코드로 입장</h2>
        <div className="flex gap-2">
          <input type="text" placeholder="방 코드를 붙여넣으세요" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          <button className="btn btn-primary shrink-0" disabled={!code} onClick={() => router.push(`/play/relay/${code}`)}>
            입장
          </button>
        </div>
      </section>

      <section className="panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-bold">공개 방 목록</h2>
          <span className="text-xs text-slate-500">{rooms.length}개</span>
        </div>
        {rooms.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">열려 있는 릴레이 방이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {rooms.map((room) => (
              <div key={room.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{room.teamName}</div>
                  <div className="text-xs text-slate-500">
                    {room.hostName} · {room.playerCount ?? 1}/{room.maxPlayers ?? 7}명 · {room.relayRules?.roundCount ? `${room.relayRules.roundCount}라운드` : '라운드 미정'}
                  </div>
                </div>
                <button className="btn btn-primary !py-1.5 !text-xs" onClick={() => router.push(`/play/relay/${room.id}`)}>
                  입장
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-center text-xs text-slate-600">
        내 팀: {team.name} (전력 {teamRating(team)}) · 감독 이름: {user.displayName}{' '}
        <Link href="/settings#profile" className="underline hover:text-slate-400">
          변경
        </Link>
      </p>
    </div>
  );
}
