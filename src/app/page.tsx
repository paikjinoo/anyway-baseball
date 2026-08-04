'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAppStore, useActiveTeam } from '@/lib/store/appStore';
import { getOrCreateGuest, signInWithGoogle } from '@/lib/firebase/auth';
import { firebaseConfigured } from '@/lib/firebase/client';
import { TeamLogo } from '@/components/ui/TeamLogo';
import { teamRating } from '@/lib/game/generator';

export default function HomePage() {
  const user = useAppStore((s) => s.user);
  const authReady = useAppStore((s) => s.authReady);
  const setUser = useAppStore((s) => s.setUser);
  const teams = useAppStore((s) => s.teams);
  const leagues = useAppStore((s) => s.leagues);
  const active = useActiveTeam();
  const [err, setErr] = useState<string | null>(null);

  if (!authReady) {
    return (
      <div className="loading-state" aria-live="polite">
        <div className="loading-mark">A/B</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="home-page">
        <section className="landing-hero">
          <div className="hero-copy">
            <p className="eyebrow">Play the whole game</p>
            <h1 className="hero-title">
              야구는, 결국
              <span className="accent-line">선택의 연속.</span>
            </h1>
            <p className="hero-description">
              구종 하나, 스윙 한 번, 선수 교체의 타이밍까지. 직접 팀을 만들고 성장시키며
              나만의 야구를 완성하세요.
            </p>

            <div className="hero-actions">
              <button
                className="btn btn-primary"
                onClick={() =>
                  void signInWithGoogle()
                    .then(setUser)
                    .catch((e) => setErr(String(e.message ?? e)))
                }
              >
                Google로 시작 <span aria-hidden>↗</span>
              </button>
              <button className="btn" onClick={() => setUser(getOrCreateGuest())}>
                게스트로 플레이 <span aria-hidden>→</span>
              </button>
            </div>

            <p className="hero-note">
              게스트 기록은 현재 브라우저에 안전하게 보관됩니다. 온라인 대전은 계정 연결 후
              이용할 수 있습니다.
            </p>
            {err && <p className="hero-error">{err}</p>}

            <div className="hero-metrics" aria-label="게임 주요 특징">
              <div className="hero-metric">
                <strong>3D</strong>
                <span>Real-time play</span>
              </div>
              <div className="hero-metric">
                <strong>23</strong>
                <span>Player roster</span>
              </div>
              <div className="hero-metric">
                <strong>P2P</strong>
                <span>Online match</span>
              </div>
            </div>
          </div>

          <div className="hero-art" role="img" aria-label="조명 아래 펼쳐진 야간 야구장">
            <div className="live-card" aria-hidden>
              <div className="live-card-head">
                <span className="live-dot">LIVE</span>
                <span>CHAMPIONSHIP · 7TH</span>
              </div>
              <div className="live-score">
                <div className="live-team">
                  <b>SEO</b>
                  <span>서울 스톰</span>
                </div>
                <div className="live-inning">4 : 3</div>
                <div className="live-team">
                  <b>BUS</b>
                  <span>부산 웨이브</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="feature-grid" aria-label="핵심 플레이">
          <FeatureCard
            index="01"
            title="구종과 코스를 직접 설계"
            body="타자의 약점을 읽고 구종과 코스를 고르세요. 제구와 스태미나가 매 공의 결과를 바꿉니다."
          />
          <FeatureCard
            index="02"
            title="타이밍으로 만드는 한 방"
            body="공의 궤적을 읽고 조준점을 맞춰 스윙하세요. 컨택, 강한 타격, 번트의 선택은 당신의 몫입니다."
          />
          <FeatureCard
            index="03"
            title="시즌을 쌓아가는 구단 운영"
            body="선수를 훈련하고 타순을 짜며 리그를 운영하세요. 한 경기의 판단이 긴 시즌의 서사가 됩니다."
          />
        </section>
      </div>
    );
  }

  return (
    <div className="home-page">
      <section className="dashboard-hero">
        <div className="dashboard-copy">
          <p className="eyebrow">Manager desk · {user.displayName}</p>
          <h1 className="dashboard-title">
            오늘의 야구는
            <br />여기서 시작됩니다.
          </h1>
          <p className="dashboard-subtitle">
            다음 한 경기와 시즌 전체를 함께 보세요. 준비가 끝났다면 바로 그라운드로 나갈 시간입니다.
          </p>

          {!firebaseConfigured && (
            <p className="local-notice">
              현재 로컬 모드입니다. 기록은 이 브라우저에 저장되며 온라인 대전만 잠시 비활성화됩니다.
            </p>
          )}

          {user.isGuest && firebaseConfigured && (
            <div className="guest-link">
              <div className="guest-link-copy">
                <strong>게스트로 플레이 중</strong>
                <span>로그인하면 기록이 계정에 저장되고 온라인 대전을 이용할 수 있습니다.</span>
              </div>
              <button
                className="btn btn-primary guest-link-btn"
                onClick={() =>
                  void signInWithGoogle()
                    .then(setUser)
                    .catch((e) => setErr(String(e.message ?? e)))
                }
              >
                Google로 로그인 <span aria-hidden>↗</span>
              </button>
            </div>
          )}
          {err && <p className="hero-error">{err}</p>}

          <div className="dashboard-actions">
            {teams.length === 0 ? (
              <Link href="/team" className="btn btn-primary">
                첫 구단 창단하기 <span aria-hidden>→</span>
              </Link>
            ) : (
              <>
                <Link href="/play/cpu" className="btn btn-primary">
                  CPU 경기 시작 <span aria-hidden>▶</span>
                </Link>
                <Link href="/league" className="btn">
                  리그 이어가기 <span aria-hidden>→</span>
                </Link>
              </>
            )}
          </div>
        </div>

        <div className="match-ticket">
          <div>
            <span className="ticket-label">{active ? 'CLUB STATUS' : 'ROOKIE ENTRY'}</span>
            <div className="ticket-team">
              {active ? (
                <TeamLogo
                  logoId={active.logoId}
                  primary={active.primaryColor}
                  secondary={active.secondaryColor}
                  size={58}
                />
              ) : (
                <span className="brand-mark" aria-hidden>A/B</span>
              )}
              <div>
                <h2>{active?.name ?? '새로운 구단의 시작'}</h2>
                <p>{active ? `${active.abbr} · ACTIVE ROSTER` : '유니폼과 로고부터 직접 만드세요'}</p>
              </div>
            </div>
          </div>

          <div className="ticket-stats">
            <div className="ticket-stat">
              <b>{active ? teamRating(active) : '—'}</b>
              <span>POWER</span>
            </div>
            <div className="ticket-stat">
              <b>{active?.players.length ?? 0}</b>
              <span>ROSTER</span>
            </div>
            <div className="ticket-stat">
              <b>{leagues.length}</b>
              <span>LEAGUE</span>
            </div>
          </div>
        </div>
      </section>

      {active && (
        <section className="panel team-overview">
          <div className="team-overview-main">
            <TeamLogo
              logoId={active.logoId}
              primary={active.primaryColor}
              secondary={active.secondaryColor}
              size={54}
            />
            <div className="team-overview-copy">
              <small>MY CLUB</small>
              <strong>{active.name}</strong>
              <span>{active.players.length}명 로스터 · 종합 전력 {teamRating(active)}</span>
            </div>
          </div>
          <div className="team-links">
            <Link href="/team" className="btn !min-h-9 !py-1.5 !text-xs">
              구단 설정
            </Link>
            <Link href="/roster" className="btn !min-h-9 !py-1.5 !text-xs">
              선수단 관리
            </Link>
          </div>
        </section>
      )}

      <section className="feature-grid" aria-label="빠른 메뉴">
        <FeatureCard
          index="PLAY"
          title="승부를 직접 결정하세요"
          body="구종 선택부터 스윙 타이밍까지, 매 플레이의 핵심 판단을 직접 내립니다."
        />
        <FeatureCard
          index="GROW"
          title="선수의 다음 시즌을 만드세요"
          body="훈련 포인트로 능력치를 올리고 새로운 변화구와 플레이 스타일을 완성합니다."
        />
        <FeatureCard
          index="LEAD"
          title="긴 시즌의 흐름을 지휘하세요"
          body="상대 전력과 순위를 읽고 리그 일정을 소화하며 우승까지 팀을 이끕니다."
        />
      </section>
    </div>
  );
}

function FeatureCard({ index, title, body }: { index: string; title: string; body: string }) {
  return (
    <article className="feature-card">
      <span className="feature-index" aria-hidden>
        {index}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}
