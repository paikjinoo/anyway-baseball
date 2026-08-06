import type {
  GameSettings,
  GameState,
  MatchRules,
  OffenseCommand,
  PitchCommand,
  PitchResult,
  Side,
  Team,
} from '../game/types';

// ---------------------------------------------------------------------------
// 2대2 (올스타전) 관련 타입
// ---------------------------------------------------------------------------

/**
 * 2대2 방의 좌석. 한 side(원정/홈)에 slot 0·1 두 사람이 앉는다.
 * slot 0이 타순 1·3·5·7·9번, slot 1이 2·4·6·8번을 맡는다.
 */
export interface PartySeat {
  uid: string;
  name: string;
  side: Side;
  slot: 0 | 1;
  teamId: string;
  teamName: string;
  teamAbbr: string;
  primaryColor: string;
  secondaryColor: string;
  logoId: string;
  /** 선수 선택을 마쳤는가 */
  ready: boolean;
  connected: boolean;
  /** 표시용. 실제 선수 데이터는 경기 시작 시 PARTY_START로 한 번에 전달된다. */
  pickedBatters: string[];
  pickedPitchers: string[];
}

/** 각자 자기 팀에서 고른 선수 id 목록 */
export interface PartyPicks {
  batters: string[];
  pitchers: string[];
}

/**
 * 선수 id -> 조작 권한을 가진 사람의 uid.
 * 타석에 선 선수와 마운드에 선 선수의 주인만 그 장면을 조작할 수 있다.
 */
export type OwnerMap = Record<string, string>;

// ---------------------------------------------------------------------------

/**
 * WebRTC 데이터채널로 오가는 메시지.
 *
 * 권한 모델은 호스트 권위(host-authoritative)다.
 * 게스트는 자기 입력만 보내고, 판정은 전부 호스트가 수행한 뒤 결과를 브로드캐스트한다.
 * 엔진이 시드 기반 결정론이므로 게스트도 같은 상태에서 같은 결과를 재현·검증할 수 있다.
 *
 * 2대2에서는 호스트가 나머지 3명과 각각 연결한 별 구조(star)이고,
 * 게스트끼리는 직접 연결하지 않는다. 모든 메시지는 호스트를 거쳐 중계된다.
 */
export type NetMessage =
  /** 접속 직후 신원/팀 교환 */
  | { t: 'HELLO'; uid: string; name: string; team: Team }
  /**
   * 호스트 -> 게스트: 이 방의 경기 규칙.
   * 방장이 대기실에서 규칙을 바꿀 때마다 다시 보낸다. 게스트는 시작 전에
   * 어떤 조건으로 붙는 경기인지 알아야 하고, 투구 체감 속도처럼 화면에
   * 바로 영향을 주는 값도 여기 들어 있다.
   */
  | { t: 'ROOM_RULES'; rules: MatchRules }
  /** 호스트 -> 게스트: 경기 시작. 초기 상태를 통째로 전달한다. */
  | { t: 'START'; state: GameState; settings: GameSettings; guestSide: Side }
  /** 수비측 -> 호스트: 구종/코스 결정 */
  | { t: 'PITCH'; cmd: PitchCommand }
  /** 호스트 -> 전원: 이번 투구의 궤적 (연출 시작 신호) */
  | { t: 'PITCH_GO'; cmd: PitchCommand; serverTime: number }
  /**
   * 공격측 -> 호스트: 스윙 입력.
   * 도루 지시는 투구와 동시에 판정되므로 같은 메시지에 실어 보낸다.
   * (따로 보내면 호스트가 판정 시점에 상대 도루 명령을 알 수 없다)
   */
  | { t: 'SWING'; cmd: OffenseCommand['swing']; steal: number[] }
  /** 호스트 -> 전원: 투구 해석 결과 + 갱신된 상태 */
  | { t: 'RESULT'; result: PitchResult }
  /** 투수 교체 */
  | { t: 'SUB_PITCHER'; side: Side; pitcherId: string }
  /** 채팅 */
  | { t: 'CHAT'; from: string; text: string }
  /** 상태 재동기화 요청/응답 (데이터채널 재연결 대비) */
  | { t: 'RESYNC_REQ' }
  | { t: 'RESYNC'; state: GameState }
  /** 상대가 경기를 떠남 */
  | { t: 'LEAVE'; reason: string }
  /** 연결 유지 */
  | { t: 'PING'; ts: number }
  | { t: 'PONG'; ts: number }
  // --- 2대2 전용 ---
  /** 호스트 -> 전원: 좌석/준비 상태 브로드캐스트 */
  | { t: 'PARTY_SEATS'; seats: PartySeat[]; hostUid: string }
  /** 게스트 -> 호스트: 내가 고른 선수 */
  | { t: 'PARTY_PICK'; uid: string; picks: PartyPicks; ready: boolean }
  /** 호스트 -> 전원: 2대2 경기 시작 */
  | {
      t: 'PARTY_START';
      state: GameState;
      settings: GameSettings;
      seats: PartySeat[];
      owners: OwnerMap;
    }
  /** 호스트 -> 전원: 조작 권한 변경 (연결이 끊긴 사람의 선수를 호스트가 인계받을 때) */
  | { t: 'PARTY_OWNERS'; owners: OwnerMap; notice?: string };

export function encode(msg: NetMessage): string {
  return JSON.stringify(msg);
}

export function decode(raw: string): NetMessage | null {
  try {
    const v = JSON.parse(raw) as NetMessage;
    return v && typeof v === 'object' && 't' in v ? v : null;
  } catch {
    return null;
  }
}
