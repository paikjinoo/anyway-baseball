'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useAppStore } from '@/lib/store/appStore';
import { watchAuth, signInWithGoogle, signOut, getOrCreateGuest } from '@/lib/firebase/auth';
import { firebaseConfigured } from '@/lib/firebase/client';
import { listLeagues, listTeams } from '@/lib/firebase/store';
import { startMenuBgm, stopMenuBgm, unlockAudio } from '@/lib/audio/sfx';
import { useMatchStore } from '@/lib/store/matchStore';

const NAV = [
  { href: '/', label: '홈', mark: '⌂' },
  { href: '/team', label: '구단', mark: '◆' },
  { href: '/roster', label: '선수', mark: '≡' },
  { href: '/league', label: '리그', mark: '▦' },
  { href: '/play', label: '경기', mark: '▶' },
  { href: '/settings', label: '설정', mark: '●' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useAppStore((s) => s.user);
  const authReady = useAppStore((s) => s.authReady);
  const setUser = useAppStore((s) => s.setUser);
  const setAuthReady = useAppStore((s) => s.setAuthReady);
  const setDataReady = useAppStore((s) => s.setDataReady);
  const setTeams = useAppStore((s) => s.setTeams);
  const setLeagues = useAppStore((s) => s.setLeagues);
  const hydrateSettings = useAppStore((s) => s.hydrateSettings);
  const matchActive = useMatchStore((s) => s.phase !== 'IDLE');

  useEffect(() => {
    hydrateSettings();
    const unsub = watchAuth((u) => {
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, [hydrateSettings, setUser, setAuthReady]);

  // 로그인되면 팀/리그를 불러온다
  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      setTeams([]);
      setLeagues([]);
      setDataReady(true);
      return;
    }
    setDataReady(false);
    let alive = true;
    void (async () => {
      try {
        const [teams, leagues] = await Promise.all([listTeams(user.uid), listLeagues(user.uid)]);
        if (!alive) return;
        setTeams(teams);
        setLeagues(leagues);
      } finally {
        if (alive) setDataReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [authReady, user, setTeams, setLeagues, setDataReady]);

  // 첫 상호작용에 오디오 컨텍스트 활성화
  useEffect(() => {
    const h = () => unlockAudio();
    window.addEventListener('pointerdown', h, { once: true });
    window.addEventListener('keydown', h, { once: true });
    return () => {
      window.removeEventListener('pointerdown', h);
      window.removeEventListener('keydown', h);
    };
  }, []);

  // 경기 중에는 관중석 소리만, 그 밖의 화면에서는 사용자가 넣은 메뉴 BGM만 재생한다.
  useEffect(() => {
    if (matchActive) stopMenuBgm();
    else startMenuBgm();
    return () => stopMenuBgm();
  }, [matchActive]);

  const navLinks = (mobile = false) =>
    NAV.map((n) => {
      const active = n.href === '/' ? pathname === '/' : pathname?.startsWith(n.href);
      return (
        <Link
          key={n.href}
          href={n.href}
          className={`nav-link ${active ? 'is-active' : ''}`}
          aria-current={active ? 'page' : undefined}
          aria-label={mobile ? n.label : undefined}
        >
          <span className="nav-mark" aria-hidden>
            {n.mark}
          </span>
          <span>{n.label}</span>
        </Link>
      );
    });

  return (
    <div className={matchActive ? '' : 'app-shell'}>
      <div className={matchActive ? 'hidden' : 'site-ambient'} aria-hidden />

      <header className={matchActive ? 'hidden' : 'topbar'}>
        <div className="topbar-inner">
          <Link href="/" className="brand" aria-label="Anyway Baseball 홈">
            <span className="brand-mark">A/B</span>
            <span className="brand-copy">
              <span className="brand-name">Anyway Baseball</span>
              <span className="brand-kicker">Baseball Simulation Club</span>
            </span>
          </Link>

          <nav className="desktop-nav" aria-label="주요 메뉴">
            {navLinks()}
          </nav>

          <div className="account-area">
            {!authReady ? (
              <span className="text-xs text-slate-500">불러오는 중…</span>
            ) : user ? (
              <div className="account-chip">
                <span className="account-avatar" aria-hidden>
                  {user.displayName.trim().slice(0, 1).toUpperCase() || 'P'}
                </span>
                <span className="account-name">{user.displayName}</span>
                {user.isGuest ? (
                  firebaseConfigured ? (
                    <button
                      className="btn btn-primary !min-h-8 !px-3 !py-1 !text-[11px]"
                      onClick={() => void signInWithGoogle()}
                      aria-label="Google 계정으로 로그인"
                    >
                      Google 로그인
                    </button>
                  ) : (
                    <span className="local-badge">LOCAL</span>
                  )
                ) : (
                  <button
                    className="btn !min-h-8 !px-3 !py-1 !text-[11px]"
                    onClick={() => void signOut().then(() => setUser(getOrCreateGuest()))}
                  >
                    로그아웃
                  </button>
                )}
              </div>
            ) : (
              <button className="btn btn-primary !min-h-9 !px-3 !py-1 !text-xs" onClick={() => void signInWithGoogle()}>
                시작하기
              </button>
            )}
          </div>
        </div>
      </header>

      {/* main과 children은 같은 트리 위치를 유지해 경기 시작 시 페이지 상태가 초기화되지 않게 한다. */}
      <main className={matchActive ? '' : 'app-main'}>{children}</main>

      <nav className={matchActive ? 'hidden' : 'mobile-nav'} aria-label="모바일 주요 메뉴">
        {navLinks(true)}
      </nav>

      <footer className={matchActive ? 'hidden' : 'site-footer'}>
        ANYWAY BASEBALL · 승부는 당신의 선택에서 시작됩니다
      </footer>
    </div>
  );
}
