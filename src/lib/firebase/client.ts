'use client';

import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, initializeFirestore, type Firestore } from 'firebase/firestore';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/** 환경변수가 채워져 있는지. 없으면 로컬(오프라인) 모드로 동작한다. */
export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

function ensureApp(): FirebaseApp | null {
  if (!firebaseConfigured) return null;
  if (!app) app = getApps().length ? getApp() : initializeApp(config);
  return app;
}

export function getFirebaseAuth(): Auth | null {
  const a = ensureApp();
  if (!a) return null;
  if (!authInstance) authInstance = getAuth(a);
  return authInstance;
}

/**
 * Firestore 인스턴스. **`ignoreUndefinedProperties`가 이 함수의 존재 이유다.**
 *
 * 기본 설정의 setDoc은 값이 `undefined`인 필드를 만나면 문서 전체를 거부하고, 그것도
 * 프로미스가 아니라 **동기 예외로** 던진다. 이 프로젝트의 도메인 객체는 그 조건을 상시
 * 만족한다 — 야수의 `role`, 기록이 없는 선수의 `splits`/`zoneSplits`, CPU 팀을 못 찾은
 * 리그의 `cpuTeams`가 전부 `undefined`로 **존재하는** 속성이다.
 *
 * 로컬 저장은 JSON.stringify가 그 속성들을 알아서 떨어뜨리므로 멀쩡했고, 원격 쓰기만
 * 조용히 전멸했다(@see store.syncRemote). 그래서 "창단은 됐는데 Firestore에는 팀이 없는"
 * 계정이 생겼다 — 새로고침 후에 저장한 사람만 JSON을 한 번 거친 깨끗한 객체를 올렸다.
 *
 * 이 옵션은 그 속성들을 **필드 자체를 빼고** 쓴다. 우리 스키마에서 선택 필드의 부재는
 * 원래 "기록이 없다"는 뜻이라(@see game/season) 의미가 정확히 일치한다.
 */
export function getDb(): Firestore | null {
  const a = ensureApp();
  if (!a) return null;
  if (!dbInstance) {
    try {
      dbInstance = initializeFirestore(a, { ignoreUndefinedProperties: true });
    } catch {
      // 이미 다른 곳에서 초기화됐다면 그 인스턴스를 쓴다.
      dbInstance = getFirestore(a);
    }
  }
  return dbInstance;
}

/** WebRTC ICE 서버 설정 */
export function iceServers(): RTCIceServer[] {
  const stun = (process.env.NEXT_PUBLIC_STUN_URLS ?? 'stun:stun.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const servers: RTCIceServer[] = [{ urls: stun }];

  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}
