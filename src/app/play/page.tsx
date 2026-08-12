'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useActiveTeam, useAppStore } from '@/lib/store/appStore';
import { firebaseConfigured } from '@/lib/firebase/client';
import { teamRating } from '@/lib/game/generator';
import { listSuspendedMatches } from '@/lib/firebase/store';
import {
  describeSuspended,
  isSuspendable,
  RESUME_MAX_AGE_MS,
  savedAgoText,
  type SuspendedMatch,
} from '@/lib/game/resume';
import { TeamLogo } from '@/components/ui/TeamLogo';

export default function PlayIndexPage() {
  const team = useActiveTeam();
  const leagues = useAppStore((s) => s.leagues);
  const user = useAppStore((s) => s.user);
  /**
   * 중단해 둔 경기들. 여기서는 안내만 한다 — 정말 이어서 할 수 있는지는
   * 각 경기 화면이 팀·일정까지 보고 다시 판단한다.
   */
  const [suspended, setSuspended] = useState<SuspendedMatch[]>([]);

  useEffect(() => {
    if (!user) return;
    const now = Date.now();
    setSuspended(
      listSuspendedMatches(user.uid).filter(
        (m) => isSuspendable(m.state) && now - m.savedAt <= RESUME_MAX_AGE_MS,
      ),
    );
  }, [user]);

  if (!team) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-slate-400">경기를 하려면 먼저 팀이 필요합니다.</p>
        <Link href="/team" className="btn btn-primary">
          팀 만들러 가기
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="panel flex items-center gap-4 p-5">
        <TeamLogo logoId={team.logoId} primary={team.primaryColor} secondary={team.secondaryColor} size={56} />
        <div>
          <div className="text-lg font-bold">{team.name}</div>
          <div className="text-sm text-slate-400">전력 {teamRating(team)}</div>
        </div>
      </div>

      {suspended.length > 0 && (
        <section className="panel border-lime-400/40 bg-lime-500/[0.07] p-5">
          <h2 className="mb-1 font-bold">이어서 하기</h2>
          <p className="mb-3 text-xs text-slate-400">
            중간에 나온 경기입니다. 나갔던 자리에서 그대로 이어집니다.
          </p>
          <div className="space-y-2">
            {suspended.map((m) => {
              const info = describeSuspended(m);
              const href = m.leagueRef
                ? `/league/${m.leagueRef.leagueId}/${m.leagueRef.gameId}`
                : '/play/cpu';
              return (
                <Link
                  key={`${m.uid}:${m.key}`}
                  href={href}
                  className="flex items-center gap-3 rounded-xl bg-black/25 px-4 py-3 transition hover:bg-black/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-slate-500">
                      {m.leagueRef ? '리그 경기' : 'CPU 대전'} ·{' '}
                      {savedAgoText(m.savedAt, Date.now())}
                    </div>
                    <div className="truncate text-sm font-bold">{info.headline}</div>
                  </div>
                  <span className="btn btn-primary !py-1 !text-[11px]">이어서 하기</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ModeCard
          href="/practice"
          title="연습 타석"
          desc="카운트도 아웃도 없이 계속 칩니다. 스윙마다 얼마나 빨랐는지·늦었는지가 숫자로 나옵니다. 보상은 없습니다."
          cta="타석에 들어서기"
        />
        <ModeCard
          href="/play/cpu"
          title="CPU 대전"
          desc="난이도를 골라 컴퓨터 팀과 한 경기를 치릅니다. 난이도가 높을수록 경험치와 골드를 많이 받습니다."
          cta="경기 시작"
        />
        <ModeCard
          href="/play/online"
          title="온라인 1:1"
          desc="방을 만들거나 참여해 다른 감독과 실시간 대결합니다. 경기 데이터는 P2P로 직접 오갑니다."
          cta={firebaseConfigured ? '로비 입장' : 'Firebase 필요'}
          disabled={!firebaseConfigured}
        />
        <ModeCard
          href="/play/party"
          title="2대2 올스타전"
          desc="네 명이 두 팀으로. 같은 편끼리 자기 팀 선수를 반씩 골라 한 팀을 만들고, 내 선수 타석에서만 조작합니다."
          cta={firebaseConfigured ? '로비 입장' : 'Firebase 필요'}
          disabled={!firebaseConfigured}
        />
        <ModeCard
          href="/play/relay"
          title="릴레이 타격 대결"
          desc="2~7명이 개인전으로 참가해 라운드마다 한 명은 투수, 나머지는 타자로 점수를 겨룹니다."
          cta={firebaseConfigured ? '로비 입장' : 'Firebase 필요'}
          disabled={!firebaseConfigured}
        />
        <ModeCard
          href="/league"
          title="리그 경기"
          desc={
            leagues.length
              ? `진행 중인 리그 ${leagues.length}개. 일정에 따라 경기를 치릅니다.`
              : '리그를 만들어 풀리그 일정을 소화하세요.'
          }
          cta={leagues.length ? '리그로 이동' : '리그 만들기'}
        />
      </div>

      <section className="panel p-5">
        <h2 className="mb-3 font-bold">조작 안내</h2>
        <div className="grid gap-4 text-sm text-slate-400 sm:grid-cols-2">
          <div>
            <h3 className="mb-1.5 font-semibold text-slate-200">공격 (타격)</h3>
            <ul className="space-y-1 text-[13px]">
              <li>· 마우스를 움직여 배트 조준점을 맞춥니다 (방향키도 가능)</li>
              <li>· 클릭 또는 <kbd className="rounded bg-white/10 px-1">Space</kbd> — 일반타격</li>
              <li>· Shift+클릭 또는 <kbd className="rounded bg-white/10 px-1">A</kbd> — 강한타격 (범위 좁고 파워↑)</li>
              <li>· <kbd className="rounded bg-white/10 px-1">S</kbd> — 번트</li>
              <li>· 투구 전 주자 버튼을 눌러 도루를 지시합니다</li>
            </ul>
          </div>
          <div>
            <h3 className="mb-1.5 font-semibold text-slate-200">수비 (투구)</h3>
            <ul className="space-y-1 text-[13px]">
              <li>· 구종을 고르고, 존 그리드를 클릭해 목표 코스를 정합니다</li>
              <li>· 제구 능력치가 낮으면 노린 곳에서 벗어납니다</li>
              <li>· 주자가 있으면 퀵모션으로 도루를 견제할 수 있습니다</li>
              <li>· 스태미나가 떨어지면 구속·제구가 나빠지니 교체하세요</li>
              <li>· 수비와 주루는 능력치에 따라 자동 처리됩니다</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

function ModeCard({
  href,
  title,
  desc,
  cta,
  disabled,
}: {
  href: string;
  title: string;
  desc: string;
  cta: string;
  disabled?: boolean;
}) {
  return (
    <div className="panel flex flex-col p-5">
      <h2 className="mb-2 text-lg font-bold">{title}</h2>
      <p className="mb-5 flex-1 text-sm leading-relaxed text-slate-400">{desc}</p>
      {disabled ? (
        <button className="btn w-full" disabled>
          {cta}
        </button>
      ) : (
        <Link href={href} className="btn btn-primary w-full">
          {cta}
        </Link>
      )}
    </div>
  );
}
