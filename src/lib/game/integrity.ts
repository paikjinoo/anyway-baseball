import { isTeamShaped } from './migrate';
import type { Player, Team } from './types';

/**
 * 저장된 팀 문서의 위·변조 감지.
 *
 * 배경: 이 게임은 판정이 전부 클라이언트에 있고 팀 문서가 localStorage(`ab:teams`)에
 * 평문 JSON으로 놓여 있다. 그래서 상점 화면에서 콘솔에 열 줄짜리 스니펫을 붙여 넣어
 * `team.gold = 300000`으로 바꾸고 새로고침하는 방법이 돌아다녔다.
 *
 * **먼저 분명히 해 둘 것: 이 파일은 그 스니펫을 막을 뿐, 치트를 막지 못한다.**
 * 서명 키가 클라이언트 번들 안에 있으므로 번들을 뒤질 의지가 있는 사람은 언제든
 * 위조할 수 있다. 진짜 방어는 서버가 보상과 구매를 판정하는 것뿐이고, 이 게임은
 * "경기 1회당 Firestore 쓰기 0"이라는 설계를 지키려고 그 길을 택하지 않았다.
 * 여기서 세우는 것은 **복붙 한 번의 문턱**이다. 그게 목적의 전부다.
 * 서버 쪽에서 실제로 강제되는 것은 firestore.rules의 골드 증가 상한 하나뿐이다.
 *
 * 세 겹으로 나눠 둔다.
 *   1) 서명(seal)   — 저장할 때 경제 상태에 HMAC을 찍고, 읽을 때 다시 계산해 맞춰 본다.
 *   2) 앵커(anchor) — "이 기기는 이 팀의 서명본을 본 적이 있다"는 표식(@see SealContext).
 *                     서명을 통째로 지우고 옛 문서인 척하는 우회를 막는다.
 *   3) 증가 상한    — 한 번의 저장으로 늘 수 있는 골드의 최대치(@see MAX_GOLD_GAIN_PER_SAVE).
 *                     메모리 위의 팀 객체를 직접 고쳐 정상 경로로 저장시키는 우회를 막는다.
 */

// ---------------------------------------------------------------------------
// SHA-256 / HMAC — 동기 구현
//
// WebCrypto(crypto.subtle)는 비동기다. 팀을 읽는 경로(store.readTeamDoc)가 전부 동기라
// 여기에 비동기를 들이면 저장소 API 전체가 Promise로 물든다. 해시 대상은 5KB 남짓이고
// 팀을 읽고 쓸 때만 도므로 순수 구현으로 충분하다 (측정상 0.3ms 미만).
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256. 입력은 바이트열, 출력은 32바이트. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // 패딩: 0x80 한 바이트 + 0으로 채우고 마지막 8바이트에 비트 길이(빅엔디언).
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLen = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let x = h[7];

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (x + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      x = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + x) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

const BLOCK = 64;

/** HMAC-SHA256. 출력은 32바이트. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const short = key.length > BLOCK ? sha256(key) : key;
  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    const k = i < short.length ? short[i] : 0;
    inner[i] = k ^ 0x36;
    outer[i] = k ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(sha256(inner), BLOCK);
  return sha256(outer);
}

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * 서명 키.
 *
 * **비밀이 아니다.** 클라이언트 번들에 그대로 실려 나가므로 devtools에서 찾아낼 수 있다.
 * 환경 변수로 빼도 값은 똑같이 번들에 박히므로 보안이 늘지 않고, 대신 빌드마다 키가 달라져
 * 멀쩡한 유저의 팀이 통째로 조작 판정을 받는 사고만 생긴다. 그래서 상수로 둔다.
 *
 * 이 값을 바꾸면 **기존에 저장된 모든 서명이 한 번에 무효가 된다.** 그때는
 * checkTeamSeal의 앵커 때문에 정상 유저까지 조작으로 잡히므로, 정말 바꿔야 한다면
 * 앵커 저장소(`ab:sealed`)도 같이 비우는 마이그레이션을 함께 넣어야 한다.
 */
const SEAL_KEY = encoder.encode('anyway-baseball/team-seal/v1');

/** 서명 문자열 앞에 붙는 표식. 지문 규칙이 바뀌면 여기를 올린다. */
const SEAL_PREFIX = 'v1';

/**
 * 서명을 앞 16바이트(32자)로 자른다.
 *
 * 46명짜리 팀 문서에 64자를 더 얹는 것보다, 위조 난이도가 이미 "키를 알아냈는가" 하나로
 * 결정되는 상황에서 길이를 줄이는 편이 낫다. 128비트면 우연한 충돌은 없다.
 */
const SEAL_BYTES = 16;

/** 리그에 끼워 넣는 CPU 팀의 소유자 uid. 지갑이 없으므로 서명 대상이 아니다. */
export const CPU_OWNER_UID = 'cpu';

/**
 * 한 번의 저장으로 늘 수 있는 골드의 상한.
 *
 * 정상 경로의 최댓값은 능력치초기화권의 구종 골드 환급이다 — S 투수가 구종 슬롯을 꽉 채워
 * 배웠을 때 3만G 남짓이고, 그다음이 최대 레벨 S 방출(18,880G)과 리그 우승(8,000G)이다.
 * 5만이면 정상 플레이를 막지 않으면서 "한 번에 30만" 같은 값은 걸러낸다.
 *
 * **firestore.rules의 같은 이름 상수와 반드시 같은 값이어야 한다.** 로컬은 이 한도를
 * 넘는 저장을 무시하고, 원격은 같은 한도로 쓰기를 거절한다.
 * 새 보상이 이 값을 넘게 되면 두 곳을 같이 올려야 한다.
 */
export const MAX_GOLD_GAIN_PER_SAVE = 50_000;

// ---------------------------------------------------------------------------
// 경제 지문
// ---------------------------------------------------------------------------

function n(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '0';
}

/**
 * 선수 한 명에서 **골드로 살 수 있는 것**만 뽑는다.
 *
 * 시즌 기록·부상·피로는 넣지 않는다. 그쪽을 고쳐 봐야 이득이 없고, 경기마다 바뀌는 값을
 * 넣으면 지문이 무의미하게 커진다.
 *
 * 타자의 `pitching`은 **일부러 뺀다.** migrate.stripBatterPitching이 읽는 도중에 그 필드를
 * 떼어 내므로, 넣으면 정규화 한 번에 서명이 깨진다 (@see economyFingerprint).
 */
function playerPrint(p: Player): string {
  const b = p.batting ?? {};
  const parts = [
    p.id,
    p.kind,
    p.tier,
    n(p.level),
    n(p.exp),
    n(p.potential),
    n(p.trainingPoints),
    n(p.spentPoints),
    n(p.spentGold ?? 0),
    [b.contact, b.power, b.eye, b.speed, b.fielding, b.arm].map(n).join(','),
  ];

  if (p.kind === 'PITCHER' && p.pitching) {
    parts.push(n(p.pitching.stamina));
    const arsenal = Object.entries(p.pitching.arsenal ?? {})
      .sort(([a], [b2]) => (a < b2 ? -1 : a > b2 ? 1 : 0))
      .map(([type, a]) => `${type}=${n(a?.velocity)},${n(a?.control)},${n(a?.movement)}`);
    parts.push(arsenal.join('+'));
  }

  return parts.join('|');
}

/**
 * 팀의 경제 상태를 한 줄 문자열로 만든다. 같은 상태면 언제나 같은 문자열이어야 한다.
 *
 * **읽기 경로의 정규화를 견뎌야 한다는 것이 이 함수의 유일하게 까다로운 제약이다.**
 * 팀은 저장될 때와 읽힐 때의 모양이 미묘하게 다르다 — migrate.normalizeTeam이 빈
 * inventory를 채우고 타자의 투구 능력을 떼어 내며, season.repairTeam이 스플릿을 손본다.
 * 그 변환들이 건드리는 값이 지문에 들어가면, 아무도 조작하지 않은 팀이 새로고침 한 번에
 * 조작 판정을 받는다. 그래서 지문에 넣는 값은 다음 셋을 모두 만족하는 것만 고른다.
 *
 *   - 정규화가 건드리지 않는다 (그래서 seasonNo·splits·base가 빠져 있다)
 *   - 골드로 사거나 골드로 바뀐다 (그래서 이름·등번호·유니폼이 빠져 있다)
 *   - 없을 수도 있는 필드는 없는 것과 기본값이 같은 문자열이 된다 (spentGold, 빈 아이템)
 */
export function economyFingerprint(team: Team): string {
  const inventory = Object.entries(team.inventory ?? {})
    // 0개짜리 항목은 아예 없는 것과 같게 본다. items.ts가 마지막 하나를 쓰면 0을 남기고,
    // Firestore를 한 번 왕복하면 그 키가 사라지기도 한다. 둘이 다른 지문이 되면 안 된다.
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, count]) => `${id}=${count}`)
    .join(',');

  const players = [...(team.players ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(playerPrint)
    .join(';');

  return [SEAL_PREFIX, team.id, team.ownerUid, n(team.gold), inventory, players].join('\n');
}

/** 이 팀에 붙어야 할 서명 값 */
export function teamSeal(team: Team): string {
  const mac = hmacSha256(SEAL_KEY, encoder.encode(economyFingerprint(team)));
  return `${SEAL_PREFIX}.${hex(mac.subarray(0, SEAL_BYTES))}`;
}

/**
 * 서명을 새로 찍은 팀을 돌려준다. 저장 직전과, 읽어서 정규화한 직후에 부른다.
 *
 * `seal`에 undefined를 넣는 일이 없어야 한다 — Firestore는 undefined 필드가 하나라도 있으면
 * 문서를 통째로 거부한다 (@see firebase/client.getDb).
 */
export function sealTeam(team: Team): Team {
  return { ...team, seal: teamSeal(team) };
}

// ---------------------------------------------------------------------------
// 검사
// ---------------------------------------------------------------------------

export type SealVerdict =
  /** 서명이 맞다 */
  | 'OK'
  /** 검사 대상이 아니다 — CPU 팀이거나, 이 기기가 처음 보는 서명 이전 문서다 */
  | 'EXEMPT'
  /** 서명이 없거나 맞지 않는다 */
  | 'TAMPERED';

export interface SealContext {
  /**
   * 이 기기가 이 팀의 **서명된** 문서를 마지막으로 저장한 시각. 본 적이 없으면 null.
   *
   * 이 값이 하는 일은 하나다: 서명이 없는 문서를 언제까지 봐 주는지 정한다. 서명이 들어오기
   * 전에 저장된 팀은 서명이 없는 게 정상이므로 한 번은 통과시켜야 하는데, 그 예외를 날짜로
   * 두면 `updatedAt`을 과거로 적어 영원히 예외에 머무를 수 있다. 기기에 "봤다"를 남기면
   * 예외가 기기마다 딱 한 번으로 끝난다.
   *
   * 물론 이 표식도 localStorage에 있으니 지울 수 있다. 그때는 앵커가 사라진 만큼만 되돌아갈
   * 뿐이고(예외 한 번), 골드는 여전히 서명이 지킨다.
   */
  anchoredAt: number | null;
}

/**
 * 저장돼 있던 문서를 믿어도 되는지 판정한다.
 *
 * 팀의 형태가 아닌 문서는 여기서 판단하지 않는다 — 그건 스키마의 일이고
 * (@see migrate.migrateTeamDoc), 여기서 같이 처리하면 사용자에게 "손상"과 "조작"이
 * 뒤섞인 안내가 나간다.
 */
export function checkTeamSeal(raw: unknown, ctx: SealContext): SealVerdict {
  if (!isTeamShaped(raw)) return 'EXEMPT';
  const doc = raw as Team;
  if (doc.ownerUid === CPU_OWNER_UID) return 'EXEMPT';

  const seal = typeof doc.seal === 'string' ? doc.seal : null;
  if (seal) return seal === teamSeal(doc) ? 'OK' : 'TAMPERED';

  // 서명이 없는 문서. 이 기기가 이 팀을 서명해 저장한 적이 있다면 누군가 지운 것이다.
  return ctx.anchoredAt === null ? 'EXEMPT' : 'TAMPERED';
}

/**
 * 저장하려는 골드가 직전 저장본에서 한 번에 늘 수 있는 양을 넘는지 본다.
 *
 * 서명은 **저장된 문서**를 지킨다. 메모리 위의 팀 객체를 고친 뒤(zustand 스토어를 직접
 * 건드리는 식으로) 뽑기 한 번을 정상적으로 돌리면, 그 조작된 값이 정상 경로를 타고 새 서명을
 * 받아 버린다. 서명만으로는 그 세탁을 못 막으므로 증가폭을 따로 본다.
 *
 * @returns 허용할 골드. 상한을 넘으면 이전 값 그대로(= 이번 저장에서는 한 푼도 늘지 않는다).
 */
export function clampGoldGain(previous: number, next: number): number {
  if (!Number.isFinite(next) || next < 0) return previous;
  if (next <= previous) return next;
  return next - previous > MAX_GOLD_GAIN_PER_SAVE ? previous : next;
}
