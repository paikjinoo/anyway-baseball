'use client';

import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { getFirebaseAuth, firebaseConfigured } from './client';
import { loadNickname } from './store';

export interface AppUser {
  uid: string;
  /** 화면과 온라인 대전에 실제로 쓰이는 이름. 닉네임을 정했으면 그 값이다. */
  displayName: string;
  /** 계정 원래 이름(구글 이름 / 게스트). 닉네임을 지우면 여기로 돌아온다. */
  accountName: string;
  /** 사용자가 직접 정한 닉네임. 없으면 null. */
  nickname: string | null;
  photoURL: string | null;
  isGuest: boolean;
}

const GUEST_KEY = 'ab:guestUid';
const GUEST_ACTIVE_KEY = 'ab:guestActive';

/** 계정 이름 위에 닉네임을 덮어쓴 사용자 정보를 만든다. */
export function withNickname(
  base: Omit<AppUser, 'displayName' | 'nickname'>,
  nickname: string | null,
): AppUser {
  return {
    ...base,
    nickname: nickname || null,
    displayName: nickname || base.accountName,
  };
}

/** 로컬 게스트 계정. Firebase 설정 여부와 무관하게 같은 uid를 유지한다. */
export function getOrCreateGuest(): AppUser {
  let uid = typeof window !== 'undefined' ? localStorage.getItem(GUEST_KEY) : null;
  if (!uid) {
    uid = 'guest_' + Math.random().toString(36).slice(2, 12);
    if (typeof window !== 'undefined') localStorage.setItem(GUEST_KEY, uid);
  }
  if (typeof window !== 'undefined') localStorage.setItem(GUEST_ACTIVE_KEY, '1');
  return withNickname(
    { uid, accountName: '게스트 감독', photoURL: null, isGuest: true },
    loadNickname(uid),
  );
}

export function toAppUser(u: User): AppUser {
  if (typeof window !== 'undefined') localStorage.removeItem(GUEST_ACTIVE_KEY);
  return withNickname(
    {
      uid: u.uid,
      accountName: u.displayName ?? '감독',
      photoURL: u.photoURL,
      isGuest: false,
    },
    loadNickname(u.uid),
  );
}

export async function signInWithGoogle(): Promise<AppUser> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase가 설정되지 않았습니다. .env.local을 확인하세요.');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  return toAppUser(cred.user);
}

export async function signOut(): Promise<void> {
  const auth = getFirebaseAuth();
  if (auth) await fbSignOut(auth);
}

/**
 * 로그인 상태 구독.
 * Firebase가 설정되지 않았으면 즉시 로컬 게스트를 돌려준다.
 */
export function watchAuth(cb: (user: AppUser | null) => void): () => void {
  if (!firebaseConfigured) {
    cb(getOrCreateGuest());
    return () => {};
  }
  const auth = getFirebaseAuth();
  if (!auth) {
    cb(
      typeof window !== 'undefined' && localStorage.getItem(GUEST_ACTIVE_KEY) === '1'
        ? getOrCreateGuest()
        : null,
    );
    return () => {};
  }
  return onAuthStateChanged(auth, (u) => {
    if (u) {
      cb(toAppUser(u));
      return;
    }
    const restoreGuest =
      typeof window !== 'undefined' && localStorage.getItem(GUEST_ACTIVE_KEY) === '1';
    cb(restoreGuest ? getOrCreateGuest() : null);
  });
}
