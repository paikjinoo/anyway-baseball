'use client';

import { useState } from 'react';
import { era, inningsText, type GameRecord, type PlayClip, type TeamBox } from '@/lib/game/record';
import { toFixed2 } from '@/lib/format';
import { ClipPlayer } from './ClipPlayer';

/**
 * 끝난 경기의 박스스코어.
 *
 * 이 화면이 생기기 전에는 경기가 끝나면 최종 스코어 말고는 전부 사라졌다.
 * 표시하는 값은 전부 GameRecord에 그대로 들어 있어서, 여기서 다시 계산하는 것은
 * 이닝 표기와 방어율뿐이다 (@see record.inningsText, record.era).
 */

function TeamTables({ box }: { box: TeamBox }) {
  const batters = box.lines.filter((l) => l.kind === 'BATTER');
  const pitchers = box.lines.filter((l) => l.kind === 'PITCHER');

  return (
    <div className="box-team">
      <h4 className="box-team-name">
        <span className="box-team-chip" style={{ background: box.primaryColor }} aria-hidden />
        {box.name}
      </h4>

      <table className="box-table">
        <thead>
          <tr>
            <th className="box-th-name">타자</th>
            <th>타수</th>
            <th>안타</th>
            <th>홈런</th>
            <th>타점</th>
            <th>득점</th>
            <th>볼넷</th>
            <th>삼진</th>
          </tr>
        </thead>
        <tbody>
          {batters.map((l) => (
            <tr key={l.playerId}>
              <td className="box-th-name">{l.name}</td>
              <td>{l.stat.ab}</td>
              <td>{l.stat.h}</td>
              <td>{l.stat.hr}</td>
              <td>{l.stat.rbi}</td>
              <td>{l.stat.r}</td>
              <td>{l.stat.bb}</td>
              <td>{l.stat.so}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="box-table">
        <thead>
          <tr>
            <th className="box-th-name">투수</th>
            <th>이닝</th>
            <th>피안타</th>
            <th>자책</th>
            <th>볼넷</th>
            <th>탈삼진</th>
            <th>투구</th>
            <th>ERA</th>
          </tr>
        </thead>
        <tbody>
          {pitchers.map((l) => (
            <tr key={l.playerId}>
              <td className="box-th-name">{l.name}</td>
              <td>{inningsText(l.stat.ip3)}</td>
              <td>{l.stat.ph}</td>
              <td>{l.stat.er}</td>
              <td>{l.stat.pbb}</td>
              <td>{l.stat.pk}</td>
              <td>{l.stat.np}</td>
              <td>{toFixed2(era(l.stat))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BoxScore({ record, onClose }: { record: GameRecord; onClose: () => void }) {
  const [playing, setPlaying] = useState<PlayClip | null>(null);
  const innings = Math.max(record.away.lineScore.length, record.home.lineScore.length);
  const rows: { box: TeamBox; label: string }[] = [
    { box: record.away, label: record.away.abbr },
    { box: record.home, label: record.home.abbr },
  ];

  return (
    <div
      className="box-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="경기 기록"
      // 배경 자체를 눌렀을 때만 닫는다. 다시 보기 플레이어가 이 안에 겹쳐 뜨므로,
      // 버블링으로 닫으면 재생 화면의 버튼을 누를 때마다 박스스코어까지 함께 사라진다.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="box-dialog">
        <div className="box-head">
          <div>
            <div className="box-head-score tabular">
              {record.away.abbr} {record.away.runs} : {record.home.runs} {record.home.abbr}
            </div>
            <div className="box-head-sub">
              {new Date(record.playedAt).toLocaleString('ko-KR')}
              {record.endedByMercy && ' · 콜드게임'}
            </div>
          </div>
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="box-scroll">
          <table className="box-table box-linescore">
            <thead>
              <tr>
                <th className="box-th-name" />
                {Array.from({ length: innings }, (_, i) => (
                  <th key={i}>{i + 1}</th>
                ))}
                <th className="box-total">R</th>
                <th className="box-total">H</th>
                <th className="box-total">E</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ box, label }) => (
                <tr key={box.teamId}>
                  <td className="box-th-name">{label}</td>
                  {Array.from({ length: innings }, (_, i) => (
                    <td key={i}>{box.lineScore[i] ?? '-'}</td>
                  ))}
                  <td className="box-total">{box.runs}</td>
                  <td className="box-total">{box.hits}</td>
                  <td className="box-total">{box.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {record.clips && record.clips.length > 0 && (
            <div className="box-clips">
              {record.clips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="box-clip"
                  onClick={() => setPlaying(c)}
                >
                  <span>{c.label}</span>
                  <span>▶ 다시 보기</span>
                </button>
              ))}
            </div>
          )}

          {record.highlights.length > 0 && (
            <div className="box-highlights">
              <h4 className="box-team-name">주요 장면</h4>
              <ul>
                {record.highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </div>
          )}

          <TeamTables box={record.away} />
          <TeamTables box={record.home} />
        </div>
      </div>

      {playing && <ClipPlayer clip={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
