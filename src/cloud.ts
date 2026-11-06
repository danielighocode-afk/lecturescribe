/* Accounts and cloud sync for LectureScribe.
   The app stays local-first: lectures are always saved on the phone first, then
   copied to the signed-in account in the background. No internet means no sync,
   never lost notes. */

import { initializeApp } from 'firebase/app';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  GoogleAuthProvider,
  signInWithCredential,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  setDoc,
  deleteDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCWA4M_VQZF9zOZyHTJmTdJ_rx22l7EqiM',
  authDomain: 'lecturescribe-13270.firebaseapp.com',
  projectId: 'lecturescribe-13270',
  storageBucket: 'lecturescribe-13270.firebasestorage.app',
  messagingSenderId: '62757005781',
  appId: '1:62757005781:web:110a56b598a85af0aaf55c',
};

/* The Web client ID of the Google sign-in. Firebase console > Authentication >
   Sign-in method > Google > Web SDK configuration > Web client ID. */
const GOOGLE_WEB_CLIENT_ID = 'PASTE_WEB_CLIENT_ID_HERE';

const SYNC_KEY = 'lecturescribe-sync-v1';
const MAX_DOC_CHARS = 900000; /* Firestore documents are limited to about 1 MB */

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'offline' | 'error';

export interface CloudHooks {
  /** Firebase finished checking who is signed in (user is null when signed out). */
  onUser(user: { uid: string; email: string; name: string } | null): void;
  /** Notes changed in the account (another phone, or first load). */
  onRemoteNotes(upsert: any[], removeIds: string[]): void;
  /** The profile in the account changed. */
  onRemoteProfile(p: any): void;
  /** Current notes and profile on this phone. */
  getNotes(): any[];
  getProfile(): any;
  /** A note is being recorded right now (or this specific note, when an id is given). */
  isBusy(id?: string): boolean;
  onStatus(s: SyncStatus, pending: number): void;
}

interface SyncState {
  uid: string;
  map: Record<string, string>; /* note id -> signature last confirmed in the account */
  del: string[]; /* notes deleted on this phone that still have to be removed from the account */
}

let hooks: CloudHooks;
let auth: Auth;
let db: Firestore;
let ready = false;
let uid = '';
let state: SyncState = { uid: '', map: {}, del: [] };
let inflight: Record<string, string> = {};
let unsubNotes: Unsubscribe | null = null;
let unsubProfile: Unsubscribe | null = null;
let pushTimer: number | undefined;
let pushDelay = 0;
let profileDirty = false;
let serverSeen = false;
let profileSeen = false;
let failed = false;
let lastProfileSig = '';

function sigOf(n: any): string {
  return n.updatedAt + ':' + n.duration + ':' + (n.segments ? n.segments.length : 0);
}

function clean<T>(v: T): T {
  /* Firestore rejects undefined values; a JSON round trip removes them. */
  return JSON.parse(JSON.stringify(v));
}

function loadState(): SyncState {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.uid === 'string' && s.map && typeof s.map === 'object') {
        return { uid: s.uid, map: s.map, del: Array.isArray(s.del) ? s.del : [] };
      }
    }
  } catch {
    /* start fresh */
  }
  return { uid: '', map: {}, del: [] };
}

function saveState(): void {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(state));
  } catch {
    /* the next push will simply repeat */
  }
}

/** Which account the notes on this phone belong to ('' if none yet). */
export function syncOwner(): string {
  return loadState().uid;
}

/** Call when the person deletes lectures, so they are removed from the account too. */
export function markDeleted(ids: string[]): void {
  if (!uid) {
    return;
  }
  for (const id of ids) {
    if (state.del.indexOf(id) < 0) {
      state.del.push(id);
    }
  }
  saveState();
  requestPush();
}

export function clearLocalSyncState(): void {
  state = { uid: '', map: {}, del: [] };
  inflight = {};
  try {
    localStorage.removeItem(SYNC_KEY);
  } catch {
    /* ignore */
  }
}

function pendingCount(): number {
  let n = state.del.length;
  for (const note of hooks.getNotes()) {
    if (state.map[note.id] !== sigOf(note)) {
      n++;
    }
  }
  return n;
}

function report(): void {
  if (!hooks) {
    return;
  }
  if (!uid) {
    hooks.onStatus('off', 0);
    return;
  }
  const p = pendingCount();
  if (failed) {
    hooks.onStatus('error', p);
  } else if (p === 0 && serverSeen) {
    hooks.onStatus('synced', 0);
  } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    hooks.onStatus('offline', p);
  } else {
    hooks.onStatus('syncing', p);
  }
}

function notesCol() {
  return collection(db, 'users', uid, 'notes');
}

function profileDoc() {
  return doc(db, 'users', uid, 'meta', 'profile');
}

/* ---------- pushing changes up ---------- */

export function requestPush(): void {
  if (!uid || !serverSeen) {
    report();
    return;
  }
  /* While a lecture is being recorded the note changes every few seconds, so
     upload it less often to keep the number of writes small. */
  const delay = hooks.isBusy() ? 30000 : 2500;
  if (pushTimer !== undefined) {
    if (delay >= pushDelay) {
      return;
    }
    window.clearTimeout(pushTimer);
  }
  pushDelay = delay;
  pushTimer = window.setTimeout(() => {
    pushTimer = undefined;
    pushNow();
  }, delay);
  report();
}

export function pushNow(): void {
  if (!uid || !serverSeen) {
    return;
  }
  if (pushTimer !== undefined) {
    window.clearTimeout(pushTimer);
    pushTimer = undefined;
  }
  const mine = uid;
  const notes = hooks.getNotes();
  for (const n of notes) {
    const sig = sigOf(n);
    if (state.map[n.id] === sig || inflight[n.id] === sig) {
      continue;
    }
    const data = clean(n);
    if (JSON.stringify(data).length > MAX_DOC_CHARS) {
      failed = true;
      continue;
    }
    inflight[n.id] = sig;
    setDoc(doc(db, 'users', mine, 'notes', n.id), data)
      .then(() => {
        if (uid !== mine) {
          return;
        }
        state.map[n.id] = sig;
        if (inflight[n.id] === sig) {
          delete inflight[n.id];
        }
        failed = false;
        saveState();
        report();
      })
      .catch(() => {
        if (inflight[n.id] === sig) {
          delete inflight[n.id];
        }
        failed = true;
        report();
      });
  }
  for (const id of state.del.slice()) {
    if (inflight[id] === 'deleting') {
      continue;
    }
    inflight[id] = 'deleting';
    deleteDoc(doc(db, 'users', mine, 'notes', id))
      .then(() => {
        if (uid !== mine) {
          return;
        }
        state.del = state.del.filter(x => x !== id);
        delete state.map[id];
        delete inflight[id];
        saveState();
        report();
      })
      .catch(() => {
        delete inflight[id];
        failed = true;
        report();
      });
  }
  report();
}

export function pushProfile(): void {
  if (!uid) {
    return;
  }
  if (!profileSeen) {
    profileDirty = true; /* edited before the account answered; sent once it does */
    return;
  }
  const p = clean(hooks.getProfile());
  lastProfileSig = JSON.stringify(p);
  setDoc(profileDoc(), p).catch(() => {
    failed = true;
    report();
  });
}

/* ---------- pulling changes down ---------- */

function startSync(forUid: string): void {
  stopSync();
  uid = forUid;
  state = loadState();
  if (state.uid !== uid) {
    /* first time this account is used on this phone: anything already here is
       treated as new and gets uploaded to the account */
    state = { uid: uid, map: {}, del: [] };
    saveState();
  }
  serverSeen = false;
  profileSeen = false;
  profileDirty = false;
  failed = false;
  report();

  unsubNotes = onSnapshot(
    notesCol(),
    snap => {
      const fromServer = !snap.metadata.fromCache;
      const upsert: any[] = [];
      const removeIds: string[] = [];
      const local: Record<string, any> = {};
      for (const n of hooks.getNotes()) {
        local[n.id] = n;
      }

      if (fromServer && !serverSeen) {
        /* First full copy from the account. Notes that were synced before but
           are gone now were deleted on another phone. */
        const remoteIds: Record<string, boolean> = {};
        snap.forEach(d => {
          remoteIds[d.id] = true;
        });
        for (const id of Object.keys(local)) {
          if (!remoteIds[id] && state.map[id] !== undefined && !hooks.isBusy(id)) {
            removeIds.push(id);
            delete state.map[id];
          }
        }
      }

      snap.docChanges().forEach(ch => {
        const id = ch.doc.id;
        if (ch.type === 'removed') {
          if (fromServer && local[id] && !hooks.isBusy(id) && inflight[id] === undefined) {
            removeIds.push(id);
            delete state.map[id];
          }
          return;
        }
        if (ch.doc.metadata.hasPendingWrites) {
          return; /* our own write coming back */
        }
        const r: any = ch.doc.data();
        r.id = id;
        if (!Array.isArray(r.segments)) {
          r.segments = [];
        }
        if (state.del.indexOf(id) >= 0) {
          return;
        }
        const l = local[id];
        if (fromServer) {
          state.map[id] = sigOf(r);
        }
        if (!l) {
          upsert.push(r);
        } else if (r.updatedAt > l.updatedAt && !hooks.isBusy(id)) {
          upsert.push(r);
        }
      });

      if (fromServer) {
        serverSeen = true;
        saveState();
      }
      if (upsert.length || removeIds.length) {
        hooks.onRemoteNotes(upsert, removeIds);
      }
      if (fromServer) {
        pushNow();
      }
      report();
    },
    () => {
      failed = true;
      report();
    }
  );

  unsubProfile = onSnapshot(
    profileDoc(),
    snap => {
      if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) {
        return;
      }
      const first = !profileSeen;
      profileSeen = true;
      if (first && profileDirty) {
        profileDirty = false;
        pushProfile();
      } else if (snap.exists()) {
        const remote = snap.data();
        const sig = JSON.stringify(clean(remote));
        if (sig !== lastProfileSig) {
          lastProfileSig = sig;
          hooks.onRemoteProfile(remote);
        }
      } else {
        const p = hooks.getProfile();
        const has = Object.keys(p).some(k => p[k]);
        if (has) {
          pushProfile();
        }
      }
    },
    () => {
      failed = true;
      report();
    }
  );
}

function stopSync(): void {
  if (unsubNotes) {
    unsubNotes();
    unsubNotes = null;
  }
  if (unsubProfile) {
    unsubProfile();
    unsubProfile = null;
  }
  if (pushTimer !== undefined) {
    window.clearTimeout(pushTimer);
    pushTimer = undefined;
  }
  uid = '';
  serverSeen = false;
  profileSeen = false;
  inflight = {};
}

/* ---------- accounts ---------- */

export function initCloud(h: CloudHooks): void {
  hooks = h;
  const app = initializeApp(firebaseConfig);
  /* initializeAuth (not getAuth) avoids the popup/redirect helpers, which do not
     work inside the Android app's web view and add a lot of code. */
  auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
  db = getFirestore(app);
  ready = true;

  onAuthStateChanged(
    auth,
    (u: User | null) => {
      if (u) {
        hooks.onUser({
          uid: u.uid,
          email: u.email || '',
          name: u.displayName || '',
        });
        startSync(u.uid);
      } else {
        stopSync();
        hooks.onUser(null);
      }
    },
    () => {
      hooks.onUser(null);
    }
  );

  window.addEventListener('online', () => {
    if (uid) {
      failed = false;
      pushNow();
      report();
    }
  });
  window.addEventListener('offline', report);
}

export function isReady(): boolean {
  return ready;
}

export async function signUp(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(auth, email, password);
}

let googleReady = false;

/** Google sign-in through the phone's own account picker (Android app only). */
export async function signInWithGoogle(): Promise<void> {
  if (GOOGLE_WEB_CLIENT_ID.indexOf('PASTE') === 0) {
    throw { code: 'app/google-not-set-up' };
  }
  const mod: any = await import('@capgo/capacitor-social-login');
  const SocialLogin = mod.SocialLogin;
  if (!googleReady) {
    await SocialLogin.initialize({ google: { webClientId: GOOGLE_WEB_CLIENT_ID } });
    googleReady = true;
  }
  const res: any = await SocialLogin.login({ provider: 'google', options: {} });
  const idToken = res && res.result && res.result.idToken;
  if (!idToken) {
    throw { code: 'app/google-no-token' };
  }
  await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

/** Resolves true if everything on this phone is safely in the account. */
export function flushPending(timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (!uid) {
      resolve(true);
      return;
    }
    pushNow();
    const started = Date.now();
    const tick = () => {
      if (pendingCount() === 0) {
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        resolve(false);
      } else {
        window.setTimeout(tick, 250);
      }
    };
    tick();
  });
}

export function unsyncedCount(): number {
  return uid ? pendingCount() : 0;
}

export async function signOutUser(): Promise<void> {
  stopSync(); /* nothing may be uploaded or deleted after this point */
  if (googleReady) {
    try {
      const mod: any = await import('@capgo/capacitor-social-login');
      await mod.SocialLogin.logout({ provider: 'google' });
    } catch {
      /* the phone's Google account stays as it was; signing out of the app still works */
    }
  }
  await signOut(auth);
}

export function friendlyAuthError(e: any): string {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || e || '');
  if (code === 'app/google-not-set-up') {
    return 'Google sign-in is not set up yet in this build.';
  }
  if (code === 'app/google-no-token') {
    return 'Google did not return a sign-in. Try again.';
  }
  if (/cancel/i.test(code + ' ' + msg)) {
    return 'Google sign-in was cancelled.';
  }
  if (/28444|developer console/i.test(msg)) {
    return 'Google sign-in is not set up correctly for this build. The signing fingerprint may be missing in Firebase.';
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return 'There is already an account with that email. Sign in with your password instead.';
  }
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address does not look right.';
    case 'auth/missing-password':
      return 'Enter your password.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'Wrong email or password.';
    case 'auth/email-already-in-use':
      return 'There is already an account with that email. Try signing in.';
    case 'auth/weak-password':
      return 'Choose a password with at least 6 characters.';
    case 'auth/network-request-failed':
      return 'No internet connection. Connect and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in is not switched on yet in Firebase.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    default:
      return 'Something went wrong (' + (code || 'unknown') + '). Try again.';
  }
}
