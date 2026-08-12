'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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

  /**
   * 팀 창단. **유저당 한 팀만** 가질 수 있다.
   * 골드와 인벤토리가 팀 문서에 붙어 있어서, 팀을 여러 개 만들 수 있으면 지갑을 늘려
   * 보상을 중복으로 모을 수 있게 된다.
   */
  async function createTeam() {
    if (!user) return;
    if (teams.length > 0) {
      setMsg('한 계정에는 팀을 하나만 만들 수 있습니다. 새로 시작하려면 기존 팀을 먼저 삭제하세요.');
      return;
    }
    const rng = new Rng(seedFromString(`${user.uid}-${Date.now()}`));
    // 창단은 경기를 굴릴 최소 인원(17명)만 받는다. 선수를 더 모으는 건 상점에서 한다.
    const team = generateTeam(rng, { ownerUid: user.uid, plan: 'FOUNDING' });
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
      <div className="team-page team-page-empty">
        <section className="team-foundation" aria-labelledby="team-foundation-title">
          <span className="team-kicker">FRONT OFFICE · FOUNDING DESK</span>
          <h1 id="team-foundation-title">당신의 구단을 창단하세요</h1>
          <p>
            한 계정에는 하나의 구단만 운영할 수 있습니다. 창단 즉시 경기 가능한 선수단과
            구단 운영 시스템이 준비됩니다.
          </p>
          <dl className="team-foundation-ledger">
            <Stat label="투수진" value="10명" />
            <Stat label="타자진" value="13명" />
            <Stat label="초기 등급" value="C · LV.1" />
          </dl>
          <button className="team-primary-action" onClick={() => void createTeam()} disabled={saving}>
            <span>{saving ? '창단 준비 중…' : '구단 창단 승인'}</span>
            <small>BEGIN FRANCHISE</small>
          </button>
        </section>
      </div>
    );
  }

  if (!draft) return null;

  const set = (patch: Partial<Team>) => setDraft({ ...draft, ...patch });
  const displayAbbr = draft.abbr.trim() || abbrFromName(draft.name);
  const selectedUniform = UNIFORM_DEFS.find((uniform) => uniform.id === draft.uniformType);
  const rating = teamRating(draft);
  const brandStyle = {
    '--club-primary': draft.primaryColor,
    '--club-secondary': draft.secondaryColor,
    '--club-accent': draft.accentColor,
  } as CSSProperties;

  return (
    <div className="team-page" style={brandStyle}>
      <section className="team-hero" aria-labelledby="team-page-title">
        <div className="team-hero-copy">
          <span className="team-kicker">FRONT OFFICE · BRAND STUDIO</span>
          <h1 id="team-page-title">{draft.name || '신생 구단'} 본부</h1>
          <p>구단의 이름과 상징, 유니폼을 설계하고 팬들이 기억할 하나의 정체성을 완성하세요.</p>
          <div className="team-hero-status">
            <span className={dirty ? 'is-dirty' : 'is-saved'}>
              <i aria-hidden="true" />
              {dirty ? '저장하지 않은 변경사항' : '모든 변경사항 저장됨'}
            </span>
            <span>CLUB ID · {displayAbbr}</span>
          </div>
        </div>

        <dl className="team-hero-ledger" aria-label="구단 현황">
          <div>
            <dt>CLUB FUNDS</dt>
            <dd>{draft.gold.toLocaleString()} G</dd>
          </div>
          <div>
            <dt>TEAM RATING</dt>
            <dd>{rating}</dd>
          </div>
          <div>
            <dt>ACTIVE ROSTER</dt>
            <dd>{draft.players.length}</dd>
          </div>
          <div>
            <dt>UNIFORM</dt>
            <dd>{selectedUniform?.ko ?? '클래식'}</dd>
          </div>
        </dl>
      </section>

      {msg && (
        <div className="team-notice" role="status">
          <span aria-hidden="true">✓</span>
          {msg}
        </div>
      )}

      <div className="team-studio-layout">
        <main className="team-editor" aria-label="구단 정체성 편집">
          <section className="team-config-section team-identity-section">
            <header className="team-section-heading">
              <span>01</span>
              <div>
                <small>IDENTITY</small>
                <h2>구단 기본 정보</h2>
              </div>
              <p>중계 화면과 리그 기록에 표시될 이름입니다.</p>
            </header>
            <div className="team-identity-fields">
              <div className="team-field">
                <label className="field-label">팀 이름</label>
                <input
                  type="text"
                  value={draft.name}
                  maxLength={20}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </div>
              <div className="team-field team-abbr-field">
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

          <section className="team-config-section">
            <header className="team-section-heading">
              <span>02</span>
              <div>
                <small>CREST VAULT</small>
                <h2>구단 엠블럼</h2>
              </div>
              <p>선수 카드와 전광판에 새겨질 구단의 상징입니다.</p>
            </header>
            <div className="team-logo-vault" role="list" aria-label="구단 엠블럼 선택">
              {LOGO_IDS.map((id, index) => (
                <button
                  key={id}
                  onClick={() => set({ logoId: id })}
                  className={`team-logo-option ${draft.logoId === id ? 'is-selected' : ''}`}
                  aria-pressed={draft.logoId === id}
                  aria-label={`엠블럼 ${index + 1}`}
                >
                  <span className="team-logo-option-index">{String(index + 1).padStart(2, '0')}</span>
                  <TeamLogo
                    logoId={id}
                    primary={draft.primaryColor}
                    secondary={draft.secondaryColor}
                    size={34}
                  />
                  <span className="team-logo-option-check" aria-hidden="true">✓</span>
                </button>
              ))}
            </div>
          </section>

          <section className="team-config-section">
            <header className="team-section-heading">
              <span>03</span>
              <div>
                <small>COLOR SYSTEM</small>
                <h2>구단 컬러</h2>
              </div>
              <p>홈구장과 유니폼을 하나로 연결하는 브랜드 팔레트입니다.</p>
            </header>
            <div className="team-color-fields">
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
            <div className="team-preset-bank">
              <label className="field-label">큐레이션 팔레트</label>
              <div className="team-preset-grid">
                {TEAM_COLOR_PRESETS.map((p, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      set({ primaryColor: p.primary, secondaryColor: p.secondary, accentColor: p.accent })
                    }
                    className={`team-preset-option ${
                      draft.primaryColor === p.primary &&
                      draft.secondaryColor === p.secondary &&
                      draft.accentColor === p.accent
                        ? 'is-selected'
                        : ''
                    }`}
                    aria-label={`컬러 팔레트 ${i + 1} 적용`}
                  >
                    <span style={{ background: p.primary }} />
                    <span style={{ background: p.secondary }} />
                    <span style={{ background: p.accent }} />
                    <small>{String(i + 1).padStart(2, '0')}</small>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="team-config-section">
            <header className="team-section-heading">
              <span>04</span>
              <div>
                <small>UNIFORM ARCHIVE</small>
                <h2>유니폼 실루엣</h2>
              </div>
              <p>선수단의 인상을 결정할 베이스 디자인을 선택하세요.</p>
            </header>
            <div className="team-uniform-grid">
              {UNIFORM_DEFS.map((u) => (
                <button
                  key={u.id}
                  onClick={() => set({ uniformType: u.id as UniformType })}
                  className={`team-uniform-option ${draft.uniformType === u.id ? 'is-selected' : ''}`}
                  aria-pressed={draft.uniformType === u.id}
                >
                  <div className="team-uniform-option-art">
                    <UniformPreview
                      type={u.id}
                      primary={draft.primaryColor}
                      secondary={draft.secondaryColor}
                      accent={draft.accentColor}
                      width={54}
                    />
                  </div>
                  <div className="team-uniform-option-copy">
                    <small>GAME KIT</small>
                    <strong>{u.ko}</strong>
                    <span>{u.desc}</span>
                  </div>
                  <i aria-hidden="true">✓</i>
                </button>
              ))}
            </div>
          </section>
        </main>

        <aside className="team-preview-column" aria-label="구단 브랜드 미리보기">
          <section className="team-brand-card">
            <div className="team-brand-card-topline">
              <span>LIVE CLUB IDENTITY</span>
              <span>01 / ACTIVE</span>
            </div>
            <div className="team-brand-lockup">
              <div className="team-brand-crest">
                <TeamLogo
                  logoId={draft.logoId}
                  primary={draft.primaryColor}
                  secondary={draft.secondaryColor}
                  size={104}
                />
              </div>
              <div>
                <small>PRO BASEBALL CLUB</small>
                <h2>{draft.name || '팀 이름'}</h2>
                <span>{displayAbbr}</span>
              </div>
            </div>

            <div className="team-uniform-stage">
              <div className="team-uniform-halo" aria-hidden="true" />
              <UniformPreview
                type={draft.uniformType}
                primary={draft.primaryColor}
                secondary={draft.secondaryColor}
                accent={draft.accentColor}
                width={128}
              />
              <div className="team-uniform-caption">
                <small>SELECTED KIT</small>
                <strong>{selectedUniform?.ko ?? '클래식'}</strong>
                <span>{selectedUniform?.desc}</span>
              </div>
            </div>

            <div className="team-brand-palette" aria-label="현재 구단 색상">
              <span style={{ background: draft.primaryColor }}><small>PRIMARY</small></span>
              <span style={{ background: draft.secondaryColor }}><small>SECONDARY</small></span>
              <span style={{ background: draft.accentColor }}><small>ACCENT</small></span>
            </div>

            <dl className="team-brand-stats">
              <Stat label="선수" value={`${draft.players.length}명`} />
              <Stat label="전력" value={String(rating)} />
            </dl>
          </section>

          <div className="team-action-panel">
            <button className="team-primary-action" onClick={() => void save()} disabled={!dirty || saving}>
              <span>{saving ? '저장 중…' : dirty ? '구단 아이덴티티 저장' : '모든 변경사항 저장됨'}</span>
              <small>{dirty ? 'COMMIT CHANGES' : 'IDENTITY SECURED'}</small>
            </button>
            <button
              className="team-secondary-action"
              onClick={() => setDraft({ ...draft, lineup: autoLineup(draft) })}
            >
              <span>타순 자동 편성</span>
              <small>OPTIMIZE LINEUP</small>
            </button>
            <button className="team-delete-action" onClick={() => void remove()}>
              구단 데이터 삭제
            </button>
          </div>
        </aside>
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
    <div className="team-color-field">
      <label className="field-label">{label}</label>
      <div className="team-color-control">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="team-color-picker"
          aria-label={`${label} 색상 선택`}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} 색상 코드`}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
