'use client';

import { create } from 'zustand';
import type { GameSettings, League, Team } from '../game/types';
import { DEFAULT_SETTINGS } from '../game/types';
import { withNickname, type AppUser } from '../firebase/auth';
import { loadSettings, normalizeNickname, saveNickname, saveSettings } from '../firebase/store';
import { configureAudio } from '../audio/sfx';

interface AppState {
  user: AppUser | null;
  authReady: boolean;
  dataReady: boolean;
  teams: Team[];
  activeTeamId: string | null;
  leagues: League[];
  settings: GameSettings;

  setUser: (u: AppUser | null) => void;
  /** 감독 닉네임 변경. null이나 빈 문자열이면 계정 이름으로 되돌린다. */
  setNickname: (raw: string | null) => void;
  /** 다른 기기에서 정한 닉네임 반영. 값이 같으면 아무것도 하지 않는다. */
  syncNickname: (uid: string, nickname: string | null) => void;
  setAuthReady: (v: boolean) => void;
  setDataReady: (v: boolean) => void;
  setTeams: (t: Team[]) => void;
  upsertTeam: (t: Team) => void;
  removeTeam: (id: string) => void;
  setActiveTeam: (id: string | null) => void;
  setLeagues: (l: League[]) => void;
  upsertLeague: (l: League) => void;
  removeLeague: (id: string) => void;
  updateSettings: (patch: Partial<GameSettings>) => void;
  hydrateSettings: () => void;
}

const ACTIVE_KEY = 'ab:activeTeam';

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  authReady: false,
  dataReady: false,
  teams: [],
  activeTeamId: typeof window !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null,
  leagues: [],
  settings: DEFAULT_SETTINGS,

  setUser: (user) => set({ user, dataReady: false }),

  setNickname: (raw) => {
    const { user } = get();
    if (!user) return;
    const next = raw === null ? null : normalizeNickname(raw) || null;
    // 게스트 uid는 Firebase 인증이 없어 원격 쓰기가 규칙에 막힌다. 로컬에만 남긴다.
    saveNickname(user.uid, next, !user.isGuest);
    set({ user: withNickname(user, next) });
  },

  syncNickname: (uid, nickname) => {
    const { user } = get();
    // 같은 값이면 사용자 객체를 새로 만들지 않는다 — 화면 전체가 괜히 다시 그려진다.
    if (!user || user.uid !== uid || user.nickname === (nickname || null)) return;
    set({ user: withNickname(user, nickname || null) });
  },

  setAuthReady: (authReady) => set({ authReady }),
  setDataReady: (dataReady) => set({ dataReady }),
  setTeams: (teams) => {
    const { activeTeamId } = get();
    const stillValid = activeTeamId && teams.some((t) => t.id === activeTeamId);
    const nextActive = stillValid ? activeTeamId : (teams[0]?.id ?? null);
    if (typeof window !== 'undefined') {
      if (nextActive) localStorage.setItem(ACTIVE_KEY, nextActive);
      else localStorage.removeItem(ACTIVE_KEY);
    }
    set({ teams, activeTeamId: nextActive });
  },
  upsertTeam: (t) =>
    set((s) => {
      const idx = s.teams.findIndex((x) => x.id === t.id);
      const teams = idx >= 0 ? s.teams.map((x) => (x.id === t.id ? t : x)) : [...s.teams, t];
      return { teams, activeTeamId: s.activeTeamId ?? t.id };
    }),
  removeTeam: (id) =>
    set((s) => {
      const teams = s.teams.filter((t) => t.id !== id);
      const activeTeamId = s.activeTeamId === id ? (teams[0]?.id ?? null) : s.activeTeamId;
      if (typeof window !== 'undefined') {
        if (activeTeamId) localStorage.setItem(ACTIVE_KEY, activeTeamId);
        else localStorage.removeItem(ACTIVE_KEY);
      }
      return { teams, activeTeamId };
    }),
  setActiveTeam: (id) => {
    if (typeof window !== 'undefined') {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    }
    set({ activeTeamId: id });
  },
  setLeagues: (leagues) => set({ leagues }),
  upsertLeague: (l) =>
    set((s) => {
      const idx = s.leagues.findIndex((x) => x.id === l.id);
      return {
        leagues: idx >= 0 ? s.leagues.map((x) => (x.id === l.id ? l : x)) : [...s.leagues, l],
      };
    }),
  removeLeague: (id) => set((s) => ({ leagues: s.leagues.filter((l) => l.id !== id) })),

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      saveSettings(settings);
      configureAudio({
        sfxEnabled: settings.sfxEnabled,
        crowdEnabled: settings.crowdEnabled,
        bgmEnabled: settings.bgmEnabled,
        sfxVolume: settings.sfxVolume,
        crowdVolume: settings.crowdVolume,
        bgmVolume: settings.bgmVolume,
      });
      return { settings };
    }),

  hydrateSettings: () => {
    const settings = loadSettings();
    configureAudio({
      sfxEnabled: settings.sfxEnabled,
      crowdEnabled: settings.crowdEnabled,
      bgmEnabled: settings.bgmEnabled,
      sfxVolume: settings.sfxVolume,
      crowdVolume: settings.crowdVolume,
      bgmVolume: settings.bgmVolume,
    });
    set({ settings });
  },
}));

export function useActiveTeam(): Team | null {
  const teams = useAppStore((s) => s.teams);
  const id = useAppStore((s) => s.activeTeamId);
  return teams.find((t) => t.id === id) ?? null;
}
