'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { firebaseConfigured } from '@/lib/firebase/client';
import { watchOpenRooms, type RoomInfo } from '@/lib/net/webrtc';
import { teamRating } from '@/lib/game/generator';

export default function PartyLobbyPage() {
  const router = useRouter();
  const user = useAppStore((s) => s.user);
  const team = useActiveTeam();
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [code, setCode] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);

  useEffect(() => {
    if (!firebaseConfigured) return;
    return watchOpenRooms(setRooms, '2v2');
  }, []);

  if (!firebaseConfigured) {
    return (
      <div className="panel mx-auto max-w-lg p-8 text-center">
        <h1 className="mb-3 text-xl font-bold">2대2 대전을 사용할 수 없습니다</h1>
        <p className="text-sm leading-relaxed text-slate-400">
          온라인 대전은 방 정보 교환(시그널링)에 Firebase를 사용합니다.
          <br />
          프로젝트 루트에 <code className="text-lime-300">.env.local</code>을 만들고 Firebase 웹 앱
          설정을 채운 뒤 다시 시도하세요.
        </p>
      </div>
    );
  }

  if (!team || !user) {
    return <div className="py-20 text-center text-slate-500">팀과 로그인이 필요합니다.</div>;
  }

  if (user.isGuest) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <p className="text-sm text-slate-400">온라인 대전은 Google 로그인이 필요합니다.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-black">2대2 올스타전</h1>
        <Link href="/play/online" className="text-xs text-slate-400 underline hover:text-slate-200">
          1:1 대전으로
        </Link>
      </div>

      <section className="panel p-5">
        <h2 className="mb-2 font-bold">이렇게 진행됩니다</h2>
        <ul className="space-y-1 text-[13px] leading-relaxed text-slate-400">
          <li>· 네 명이 두 팀으로 나뉘고, 같은 편 두 사람이 각자 자기 팀에서 선수를 골라 옵니다.</li>
          <li>· 야수는 5명/4명으로 나눠 고르고, 타순은 서로 번갈아 배치됩니다 (1·3·5·7·9 / 2·4·6·8).</li>
          <li>· 타석에 <b className="text-slate-200">내 선수</b>가 섰을 때만 조작하고, 팀원 차례에는 관전합니다.</li>
          <li>· 선발 투수는 두 사람이 낸 투수를 섞어 <b className="text-slate-200">무작위</b>로 정합니다.</li>
          <li>· 수비는 마운드에 선 투수의 주인이 맡습니다. 내 불펜을 올리면 조작권을 가져옵니다.</li>
        </ul>
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 font-bold">방 만들기</h2>
        <p className="mb-4 text-sm text-slate-400">
          방장이 <b>홈(후공)</b> 자리에 앉고, 경기 판정은 방장 브라우저에서 처리됩니다. 나머지 세 명은
          방 코드로 입장합니다. 자리는 방장이 바꿀 수 있습니다.
        </p>
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="h-4 w-4 accent-lime-500"
          />
          비공개 방 (목록에 노출하지 않고 코드로만 입장)
        </label>
        <button
          className="btn btn-primary"
          onClick={() => router.push(`/play/party/host?private=${isPrivate ? '1' : '0'}`)}
        >
          방 만들기
        </button>
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 font-bold">코드로 입장</h2>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="방 코드를 붙여넣으세요"
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
          <button
            className="btn btn-primary shrink-0"
            disabled={!code}
            onClick={() => router.push(`/play/party/${code}`)}
          >
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
          <p className="py-8 text-center text-sm text-slate-500">
            열려 있는 2대2 방이 없습니다. 직접 방을 만들어 보세요.
          </p>
        ) : (
          <div className="space-y-2">
            {rooms.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{r.teamName}</div>
                  <div className="text-xs text-slate-500">
                    {r.hostName} · {r.playerCount ?? 1}/4명 ·{' '}
                    {new Date(r.createdAt).toLocaleTimeString('ko-KR')}
                  </div>
                </div>
                <button
                  className="btn btn-primary !py-1.5 !text-xs"
                  onClick={() => router.push(`/play/party/${r.id}`)}
                >
                  입장
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-center text-xs text-slate-600">
        내 팀: {team.name} (전력 {teamRating(team)})
      </p>
    </div>
  );
}
