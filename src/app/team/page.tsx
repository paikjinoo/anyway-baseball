'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppStore, useActiveTeam } from '@/lib/store/appStore';
import { TeamLogo } from '@/components/ui/TeamLogo';
import { UNIFORM_DEFS } from '@/lib/game/constants';
import {
  LOGO_IDS,
  TEAM_COLOR_PRESETS,
  abbrFromName,
  autoLineup,
  generateTeam,
  teamRating,
} from '@/lib/game/generator';
import { Rng, seedFromString } from '@/lib/game/rng';
import { deleteTeam, saveTeam } from '@/lib/firebase/store';
import type { Team, UniformType } from '@/lib/game/types';
import { UniformPreview } from '@/components/ui/UniformPreview';

export default function TeamPage() {
  const user = useAppStore((s) => s.user);
  const teams = useAppStore((s) => s.teams);
  const activeTeamId = useAppStore((s) => s.activeTeamId);
  const setActiveTeam = useAppStore((s) => s.setActiveTeam);
  const upsertTeam = useAppStore((s) => s.upsertTeam);
  const removeTeam = useAppStore((s) => s.removeTeam);
  const active = useActiveTeam();

  const [draft, setDraft] = useState<Team | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setDraft(active ? structuredClone(active) : null);
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(
    () => (draft && active ? JSON.stringify(draft) !== JSON.stringify(active) : false),
    [draft, active],
  );

  async function createTeam() {
    if (!user) return;
    const rng = new Rng(seedFromString(`${user.uid}-${Date.now()}`));
    const team = generateTeam(rng, { ownerUid: user.uid });
    setSaving(true);
    await saveTeam(team);
    upsertTeam(team);
    setActiveTeam(team.id);
    setSaving(false);
    setMsg(`${team.name} 창단 완료! 선수 ${team.players.length}명이 배정되었습니다.`);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    const next = { ...draft, abbr: draft.abbr.trim() || abbrFromName(draft.name) };
    await saveTeam(next);
    upsertTeam(next);
    setSaving(false);
    setMsg('저장했습니다.');
  }

  async function remove() {
    if (!draft) return;
    if (!confirm(`${draft.name} 팀을 삭제할까요? 선수 데이터도 함께 사라집니다.`)) return;
    await deleteTeam(draft.id);
    removeTeam(draft.id);
    setMsg('삭제했습니다.');
  }

  if (!user) return <div className="py-20 text-center text-slate-500">로그인이 필요합니다.</div>;

  if (teams.length === 0) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <h1 className="mb-2 text-2xl font-bold">아직 팀이 없습니다</h1>
        <p className="mb-6 text-sm text-slate-400">
          팀을 창단하면 23명의 선수가 자동으로 배정됩니다. 능력치는 무작위지만 총량이 균형 있게
          맞춰집니다.
        </p>
        <button className="btn btn-primary w-full" onClick={() => void createTeam()} disabled={saving}>
          {saving ? '창단 중…' : '팀 창단하기'}
        </button>
      </div>
    );
  }

  if (!draft) return null;

  const set = (patch: Partial<Team>) => setDraft({ ...draft, ...patch });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black">팀 설정</h1>
        <div className="flex-1" />
        {teams.length > 1 && (
          <select
            className="max-w-52"
            value={activeTeamId ?? ''}
            onChange={(e) => setActiveTeam(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn !py-2 !text-xs" onClick={() => void createTeam()} disabled={saving}>
          + 새 팀
        </button>
      </div>

      {msg && (
        <div className="rounded-xl border border-lime-500/30 bg-lime-500/10 px-4 py-2.5 text-sm text-lime-200">
          {msg}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        {/* ---- 편집 ---- */}
        <div className="space-y-5">
          <section className="panel p-5">
            <h2 className="mb-4 font-bold">기본 정보</h2>
            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <div>
                <label className="field-label">팀 이름</label>
                <input
                  type="text"
                  value={draft.name}
                  maxLength={20}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </div>
              <div>
                <label className="field-label">약칭 (3자)</label>
                <input
                  type="text"
                  value={draft.abbr}
                  maxLength={3}
                  onChange={(e) => set({ abbr: e.target.value })}
                />
              </div>
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="mb-4 font-bold">팀 로고</h2>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
              {LOGO_IDS.map((id) => (
                <button
                  key={id}
                  onClick={() => set({ logoId: id })}
                  className={`grid aspect-square place-items-center rounded-xl border-2 p-1.5 transition ${
                    draft.logoId === id
                      ? 'border-lime-400 bg-lime-500/15'
                      : 'border-transparent bg-white/5 hover:bg-white/10'
                  }`}
                  title={id}
                >
                  <TeamLogo
                    logoId={id}
                    primary={draft.primaryColor}
                    secondary={draft.secondaryColor}
                    size={34}
                  />
                </button>
              ))}
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="mb-4 font-bold">유니폼 색상</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <ColorField
                label="메인"
                value={draft.primaryColor}
                onChange={(v) => set({ primaryColor: v })}
              />
              <ColorField
                label="서브"
                value={draft.secondaryColor}
                onChange={(v) => set({ secondaryColor: v })}
              />
              <ColorField
                label="포인트"
                value={draft.accentColor}
                onChange={(v) => set({ accentColor: v })}
              />
            </div>
            <div className="mt-4">
              <label className="field-label">프리셋</label>
              <div className="flex flex-wrap gap-2">
                {TEAM_COLOR_PRESETS.map((p, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      set({ primaryColor: p.primary, secondaryColor: p.secondary, accentColor: p.accent })
                    }
                    className="flex h-8 w-16 overflow-hidden rounded-lg border border-white/10"
                    title="적용"
                  >
                    <span className="h-full flex-1" style={{ background: p.primary }} />
                    <span className="h-full flex-1" style={{ background: p.secondary }} />
                    <span className="h-full flex-1" style={{ background: p.accent }} />
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="mb-4 font-bold">유니폼 종류</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              {UNIFORM_DEFS.map((u) => (
                <button
                  key={u.id}
                  onClick={() => set({ uniformType: u.id as UniformType })}
                  className={`rounded-xl border-2 p-3 text-left transition ${
                    draft.uniformType === u.id
                      ? 'border-lime-400 bg-lime-500/10'
                      : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                  }`}
                >
                  <div className="mb-2 flex justify-center">
                    <UniformPreview
                      type={u.id}
                      primary={draft.primaryColor}
                      secondary={draft.secondaryColor}
                      accent={draft.accentColor}
                      width={54}
                    />
                  </div>
                  <div className="text-sm font-semibold">{u.ko}</div>
                  <div className="text-[11px] text-slate-500">{u.desc}</div>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* ---- 미리보기 ---- */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <section className="panel p-5 text-center">
            <TeamLogo
              logoId={draft.logoId}
              primary={draft.primaryColor}
              secondary={draft.secondaryColor}
              size={104}
            />
            <div className="mt-3 text-xl font-black">{draft.name || '팀 이름'}</div>
            <div className="text-sm text-slate-400">{draft.abbr || abbrFromName(draft.name)}</div>

            <div className="my-5 flex items-end justify-center gap-4">
              <UniformPreview
                type={draft.uniformType}
                primary={draft.primaryColor}
                secondary={draft.secondaryColor}
                accent={draft.accentColor}
                width={92}
              />
            </div>

            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Stat label="선수" value={`${draft.players.length}명`} />
              <Stat label="전력" value={String(teamRating(draft))} />
            </dl>
          </section>

          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? '저장 중…' : dirty ? '저장' : '저장됨'}
            </button>
            <button className="btn btn-danger" onClick={() => void remove()}>
              삭제
            </button>
          </div>
          <button
            className="btn w-full !text-xs"
            onClick={() => setDraft({ ...draft, lineup: autoLineup(draft) })}
          >
            타순 자동 편성
          </button>
        </div>
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 cursor-pointer rounded-lg border border-white/10 bg-transparent"
        />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/5 p-2">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}
