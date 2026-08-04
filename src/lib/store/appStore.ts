'use client';

import { create } from 'zustand';
import type { GameSettings, League, Team } from '../game/types';
import { DEFAULT_SETTINGS } from '../game/types';
import type { AppUser } from '../firebase/auth';
import { loadSettings, saveSettings } from '../firebase/store';
import { configureAudio } from '../audio/sfx';

interface AppState {
  user: AppUser | null;
  authReady: boolean;
  teams: Team[];
  activeTeamId: string | null;
  leagues: League[];
  settings: GameSettings;

  setUser: (u: AppUser | null) => void;
  setAuthReady: (v: boolean) => void;
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
  teams: [],
  activeTeamId: typeof window !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null,
  leagues: [],
  settings: DEFAULT_SETTINGS,

  setUser: (user) => set({ user }),
  setAuthReady: (authReady) => set({ authReady }),
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
