import './styles.css';
import * as cloud from './cloud';

interface Segment {
  id: string;
  t: number;
  text: string;
  conf: number;
  mark: boolean;
  typed?: boolean;
}

interface Note {
  id: string;
  title: string;
  course: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  segments: Segment[];
}

interface Settings {
  lang: string;
  showUnsure: boolean;
  realWave: boolean;
  waveV: number;
  theme: 'system' | 'light' | 'dark';
}

interface Profile {
  name: string;
  university: string;
  faculty: string;
  department: string;
  level: string;
  photo: string;
}

type View = 'home' | 'lectures' | 'notes' | 'profile' | 'detail' | 'live';

interface Route {
  view: View;
  id: string;
}

const NOTES_KEY = 'lecturescribe-notes-v1';
const SETTINGS_KEY = 'lecturescribe-settings-v1';
const PROFILE_KEY = 'lecturescribe-profile-v1';
const NL = String.fromCharCode(10);
/* ---------- native Android speech (only used inside the installed APK) ---------- */

const CAP: any = (window as any).Capacitor;
const NATIVE_PLUGIN: any =
  CAP && typeof CAP.isNativePlatform === 'function' && CAP.isNativePlatform() && CAP.Plugins
    ? CAP.Plugins.SpeechRecognition
    : null;
const IS_NATIVE = !!NATIVE_PLUGIN;
if (IS_NATIVE) {
  /* Safety net: if the phone does not report the status bar height to the page,
     still keep content clear of the clock and notification icons. */
  document.documentElement.style.setProperty('--top-min', '2rem');
}

/* Looks like the browser's SpeechRecognition so the recording code does not change. */
class NativeRecognition {
  continuous = true;
  interimResults = true;
  maxAlternatives = 1;
  processLocally = false;
  lang = 'en-US';
  onresult: any = null;
  onerror: any = null;
  onend: any = null;
  private handles: any[] = [];
  private last = '';
  private ended = false;
  private finished = false;
  private timer: number | undefined;

  start(): void {
    void this.run();
  }

  stop(): void {
    try {
      const p = NATIVE_PLUGIN.stop();
      if (p && p.catch) {
        p.catch(() => undefined);
      }
    } catch {
      /* not listening */
    }
    this.armFinish();
  }

  abort(): void {
    this.stop();
    this.finish(false);
  }

  private armFinish(): void {
    if (this.finished || this.timer) {
      return;
    }
    this.ended = true;
    this.timer = window.setTimeout(() => this.finish(true), 900);
  }

  private async run(): Promise<void> {
    try {
      let perm = await NATIVE_PLUGIN.checkPermissions();
      if (perm.speechRecognition !== 'granted') {
        perm = await NATIVE_PLUGIN.requestPermissions();
      }
      if (perm.speechRecognition !== 'granted') {
        this.fail('not-allowed');
        return;
      }
      if (this.finished) {
        return;
      }
      const h1 = await NATIVE_PLUGIN.addListener('partialResults', (d: any) => this.onPartial(d));
      const h2 = await NATIVE_PLUGIN.addListener('listeningState', (d: any) => {
        if (d && d.status === 'stopped') {
          this.armFinish();
        }
      });
      this.handles = [h1, h2];
      if (this.finished) {
        this.release();
        return;
      }
      await NATIVE_PLUGIN.start({
        language: this.lang,
        maxResults: 1,
        partialResults: true,
        popup: false,
      });
    } catch (e: any) {
      const msg = String((e && e.message) || e || '');
      if (/busy/i.test(msg)) {
        this.finish(false);
      } else if (/permission/i.test(msg)) {
        this.fail('not-allowed');
      } else {
        this.fail(msg || 'speech-start-failed');
      }
    }
  }

  private onPartial(d: any): void {
    const text = d && d.matches && d.matches[0] ? String(d.matches[0]) : '';
    if (!text || this.finished) {
      return;
    }
    this.last = text;
    if (this.ended) {
      /* the final answer arrives just after the engine reports it stopped */
      this.finish(true);
      return;
    }
    this.emit(text, false);
  }

  private emit(text: string, isFinal: boolean): void {
    if (!this.onresult) {
      return;
    }
    const res: any = [{ transcript: text, confidence: 0 }];
    res.isFinal = isFinal;
    this.onresult({ resultIndex: 0, results: [res] });
  }

  private fail(err: string): void {
    if (this.onerror) {
      this.onerror({ error: err });
    }
    this.finish(false);
  }

  private release(): void {
    for (const h of this.handles) {
      try {
        h.remove();
      } catch {
        /* already removed */
      }
    }
    this.handles = [];
  }

  private finish(final: boolean): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    window.clearTimeout(this.timer);
    this.release();
    if (final && this.last) {
      this.emit(this.last, true);
    }
    if (this.onend) {
      this.onend();
    }
  }
}

const SR: any = IS_NATIVE
  ? NativeRecognition
  : (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const root = document.getElementById('app') as HTMLElement;
const IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const UNSURE_BELOW = 0.8;
const SILENCE_NEW_SECTION_MS = 30000;
const DAY = 86400000;

const LANGS: string[][] = [
  ['en-NG', 'English (Nigeria)'],
  ['en-GB', 'English (UK)'],
  ['en-US', 'English (US)'],
  ['en-GH', 'English (Ghana)'],
  ['en-ZA', 'English (South Africa)'],
];

const LEVELS = [
  '100 Level',
  '200 Level',
  '300 Level',
  '400 Level',
  '500 Level',
  '600 Level',
  'Postgraduate',
];

const TONES = [
  'bg-primarysoft text-primary',
  'bg-lavsoft text-lavink',
  'bg-ambersoft text-amberink',
];

const ICONS: Record<string, string> = {
  home: "<path d='m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/><path d='M9 22V12h6v10'/>",
  book: "<path d='M4 19.5A2.5 2.5 0 0 1 6.5 17H20'/><path d='M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'/>",
  mic: "<path d='M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z'/><path d='M19 10v2a7 7 0 0 1-14 0v-2'/><path d='M12 19v3'/>",
  notes:
    "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 2v6h6M16 13H8M16 17H8M10 9H8'/>",
  user: "<path d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/><circle cx='12' cy='7' r='4'/>",
  search: "<circle cx='11' cy='11' r='8'/><path d='m21 21-4.3-4.3'/>",
  pause:
    "<rect x='6' y='4' width='4' height='16' rx='1'/><rect x='14' y='4' width='4' height='16' rx='1'/>",
  play: "<path d='M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z'/>",
  stop: "<rect x='6' y='6' width='12' height='12' rx='2'/>",
  star: "<path d='m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z'/>",
  plus: "<path d='M12 5v14M5 12h14'/>",
  back: "<path d='M19 12H5M12 19l-7-7 7-7'/>",
  chev: "<path d='m9 18 6-6-6-6'/>",
  trash:
    "<path d='M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'/>",
  download:
    "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><path d='m7 10 5 5 5-5M12 15V3'/>",
  copy: "<rect x='9' y='9' width='13' height='13' rx='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/>",
  clock: "<circle cx='12' cy='12' r='10'/><path d='M12 6v6l4 2'/>",
  calendar:
    "<rect x='3' y='4' width='18' height='18' rx='2'/><path d='M16 2v4M8 2v4M3 10h18'/>",
  edit: "<path d='M12 20h9'/><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'/>",
  globe:
    "<circle cx='12' cy='12' r='10'/><path d='M2 12h20'/><path d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/>",
  moon: "<path d='M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z'/>",
  layers:
    "<path d='m12 2 10 5-10 5L2 7z'/><path d='m2 17 10 5 10-5'/><path d='m2 12 10 5 10-5'/>",
  more: "<circle cx='5' cy='12' r='1.2'/><circle cx='12' cy='12' r='1.2'/><circle cx='19' cy='12' r='1.2'/>",
  info: "<circle cx='12' cy='12' r='10'/><path d='M12 16v-4M12 8h.01'/>",
  help: "<circle cx='12' cy='12' r='10'/><path d='M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01'/>",
  eye: "<path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'/><circle cx='12' cy='12' r='3'/>",
  wave: "<path d='M2 12h2M6 8v8M10 4v16M14 7v10M18 9v6M22 12h-2'/>",
  mail: "<rect x='2' y='4' width='20' height='16' rx='2'/><path d='m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'/>",
  lock: "<rect x='3' y='11' width='18' height='11' rx='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/>",
  eyeoff:
    "<path d='M9.9 9.9a3 3 0 1 0 4.2 4.2'/><path d='M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7'/><path d='M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6'/><path d='m2 2 20 20'/>",
  x: "<path d='M18 6 6 18M6 6l12 12'/>",
};

function ic(name: string, size = 20, fill = false): string {
  const f = fill || name === 'pause' || name === 'play' || name === 'stop';
  return `<svg width='${size}' height='${size}' viewBox='0 0 24 24' fill='${f ? 'currentColor' : 'none'}' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>${ICONS[name] || ''}</svg>`;
}

/* ---------- state ---------- */

let notes: Note[] = loadJSON<Note[]>(NOTES_KEY, []);
const savedSettings = loadJSON<any>(SETTINGS_KEY, {});
let settings: Settings = {
  lang: savedSettings.lang || 'en-NG',
  showUnsure: savedSettings.showUnsure !== false,
  realWave: !IS_NATIVE && savedSettings.waveV === 2 && savedSettings.realWave === true,
  waveV: 2,
  theme:
    savedSettings.theme === 'light' || savedSettings.theme === 'dark'
      ? savedSettings.theme
      : 'system',
};
let profile: Profile = Object.assign(
  { name: '', university: '', faculty: '', department: '', level: '', photo: '' },
  loadJSON<Partial<Profile>>(PROFILE_KEY, {})
);

let route: Route = { view: 'home', id: '' };

/* accounts */
type AuthState = 'loading' | 'out' | 'in';
let authState: AuthState = 'loading';
let account: { uid: string; email: string; name: string } | null = null;
let authMode: 'signin' | 'signup' | 'reset' = 'signin';
let authBusy = false;
let cloudOn = false;
let syncLabel = '';
let pendingName = '';
let search = '';
const RECENT_KEY = 'lecturescribe-recent-search-v1';
let recentSearches: string[] = loadJSON<string[]>(RECENT_KEY, []);
const collapsedCourses = new Set<string>();
let splashGone = false;
let timeFilter: 'all' | 'recent' | 'week' | 'month' = 'all';
let courseFilter = '';
let notesFilter: 'all' | 'starred' | 'typed' = 'all';
let notesSearch = '';
let detailTab: 'transcript' | 'points' = 'transcript';
let pendingPhoto: string | undefined;

let recording = false;
let wantRecording = false;
let recId: string | null = null;
let sessionStart = 0;
let baseDuration = 0;
let interimText = '';
let recognition: any = null;
let restartTimer: number | undefined;
let timerHandle: number | undefined;
let wakeLock: any = null;
let editingSegment = false;
let netErrors = 0;
let fastFails = 0;
let lastError = '';
let saveTimer: number | undefined;

let liveNoteId: string | null = null;
let liveSectionId: string | null = null;
let sectionBase = '';
let baseConf = 1;
let liveChunks: string[] = [];
let liveConfs: number[] = [];
let skipWords: string[] = [];
let lastSpeechAt = 0;
let lastActivityAt = 0;
let dbgRestarts = 0;
let dbgResults = 0;
let dbgErr = '';
let dbgMode = '';

/* offline (on-device) transcription */
type LocalState =
  | 'unknown'
  | 'unsupported'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';
let localState: LocalState = 'unknown';
let localLang = '';
let localSticky = false;
let iosWarned = false;
let installPrompt: any = null;
let lastRouteKey = '';
let tipEl: HTMLElement | null = null;
let tipTimer: number | undefined;

/* waveform */
const GREEN = [45, 212, 163];
const LAV = [167, 139, 250];
let waveMode: 'off' | 'real' | 'activity' = 'off';
let audioCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let waveBuf: Float32Array | null = null;
let meterToken = 0;
let waveRaf = 0;
let waveLast = 0;
let waveHist: number[][] = [];
let volSmooth = 0;
let pitchHz = 0;
let quietFrames = 0;
let flatSince = 0;
let noiseV = 0;
let infoCounter = 0;

/* ---------- helpers ---------- */

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(r) : pad(m) + ':' + pad(r);
}

function fmtDur(sec: number): string {
  const m = Math.round(sec / 60);
  if (sec > 0 && m < 1) {
    return 'Under 1 min';
  }
  if (m < 60) {
    return m + ' min';
  }
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h + ' h' + (r ? ' ' + r + ' min' : '');
}

function fmtHours(sec: number): string {
  return sec >= 3600 ? (sec / 3600).toFixed(1) + 'h' : Math.round(sec / 60) + 'm';
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveNotes(): void {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch {
    toast('Could not save. Storage is full or blocked. Export your notes.');
  }
  if (cloudOn) {
    cloud.requestPush();
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* settings just will not persist */
  }
}

function saveProfile(push = true): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    toast('Could not save your profile. Storage is full or blocked.');
  }
  if (push && cloudOn) {
    cloud.pushProfile();
  }
}

function scheduleSave(): void {
  if (saveTimer !== undefined) {
    return;
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    saveNotes();
  }, 1000);
}

function viewNote(): Note | undefined {
  return route.id ? notes.find(n => n.id === route.id) : undefined;
}

function elapsedFor(noteId: string | null): number {
  const n = notes.find(x => x.id === noteId);
  if (!n) {
    return 0;
  }
  return recording && noteId === recId
    ? baseDuration + (Date.now() - sessionStart) / 1000
    : n.duration;
}

function syncDuration(): void {
  if (recording && recId) {
    const n = notes.find(x => x.id === recId);
    if (n) {
      n.duration = elapsedFor(recId);
    }
  }
}

function toast(msg: string): void {
  const t = document.createElement('div');
  t.setAttribute('role', 'status');
  t.className =
    'toast-in fixed bottom-28 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl bg-ink px-4 py-2 text-sm font-medium text-bg shadow-lg';
  t.textContent = msg;
  document.body.appendChild(t);
  window.setTimeout(() => t.remove(), 3400);
}

function openModal(inner: string): void {
  closeModal();
  const m = document.createElement('div');
  m.id = 'modal-root';
  m.className =
    'fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-3 sm:items-center';
  m.innerHTML = `<div class='max-h-[92vh] w-full max-w-md overflow-y-auto rounded-3xl bg-surface p-5 text-ink shadow-xl' role='dialog' aria-modal='true'>${inner}</div>`;
  m.addEventListener('click', e => {
    if (e.target === m) {
      closeModal();
    }
  });
  document.body.appendChild(m);
  const first = m.querySelector('input:not([type=file]), select') as HTMLElement | null;
  if (first) {
    first.focus();
  }
}

function showTip(el: HTMLElement): void {
  const title = el.dataset.tipTitle || '';
  const val = el.dataset.tipVal || '';
  if (!title && !val) {
    return;
  }
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'chart-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.className =
      'pointer-events-none fixed z-50 max-w-[240px] rounded-xl bg-ink px-3 py-2 text-bg shadow-lg';
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = '';
  const v = document.createElement('div');
  v.className = 'text-sm font-bold';
  v.textContent = val;
  const t = document.createElement('div');
  t.className = 'text-xs opacity-80';
  t.textContent = title;
  tipEl.appendChild(v);
  tipEl.appendChild(t);
  const anchor = (el.querySelector('[data-tip-anchor]') as HTMLElement | null) || el;
  const r = anchor.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const x = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8);
  let y = r.top - h - 8;
  if (y < 8) {
    y = r.bottom + 8;
  }
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}

function hideTip(): void {
  window.clearTimeout(tipTimer);
  if (tipEl) {
    tipEl.remove();
    tipEl = null;
  }
}

function closeModal(): void {
  const m = document.getElementById('modal-root');
  if (m) {
    m.remove();
  }
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'lecture-notes';
}

function plainText(n: Note, withTime: boolean): string {
  const head =
    n.title +
    (n.course ? ' (' + n.course + ')' : '') +
    NL +
    fmtDate(n.createdAt) +
    NL +
    NL;
  const lines = n.segments.map(
    s =>
      (withTime ? '[' + fmtTime(s.t) + '] ' : '') +
      (s.mark ? '* ' : '') +
      s.text
  );
  return head + lines.join(NL + NL);
}

function courseTone(course: string): string {
  let h = 0;
  for (let i = 0; i < course.length; i++) {
    h = (h * 31 + course.charCodeAt(i)) % 997;
  }
  return TONES[h % TONES.length];
}

/* ---------- theme ---------- */

function resolvedTheme(): 'light' | 'dark' {
  if (settings.theme === 'system') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    } catch {
      return 'light';
    }
  }
  return settings.theme;
}

function applyTheme(): void {
  const t = resolvedTheme();
  document.documentElement.setAttribute('data-theme', t);
  const m = document.querySelector('meta[name=theme-color]');
  if (m) {
    m.setAttribute('content', t === 'dark' ? '#0E0B1A' : '#1B0F40');
  }
}

/* ---------- section building (spoken text becomes paragraphs) ---------- */

function wordsOf(s: string): string[] {
  return s.split(' ').filter(w => w.length > 0);
}

function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function startsWithWords(long: string[], short: string[]): boolean {
  if (!short.length || short.length > long.length) {
    return false;
  }
  for (let i = 0; i < short.length; i++) {
    if (normWord(long[i]) !== normWord(short[i])) {
      return false;
    }
  }
  return true;
}

/* Phones often resend the same sentence again and again, growing by a word
   each time. If the new text extends the last chunk, it replaces it. */
function mergeInto(
  chunks: string[],
  confs: number[],
  text: string,
  conf: number
): boolean {
  const incoming = wordsOf(text.trim());
  if (!incoming.length) {
    return false;
  }
  const joined = incoming.join(' ');
  const last = chunks.length ? wordsOf(chunks[chunks.length - 1]) : [];
  if (last.length && startsWithWords(incoming, last)) {
    chunks[chunks.length - 1] = joined;
    confs[confs.length - 1] = conf;
    return true;
  }
  if (last.length && startsWithWords(last, incoming)) {
    return false;
  }
  chunks.push(joined);
  confs.push(conf);
  return true;
}

function joinChunks(base: string, chunks: string[]): string {
  let out = base;
  for (const c of chunks) {
    const piece = capitalize(c);
    if (out) {
      const ch = out.charAt(out.length - 1);
      if ('.!?,;:'.indexOf(ch) < 0) {
        out += '.';
      }
      out += ' ' + piece;
    } else {
      out = piece;
    }
  }
  return out;
}

function avgConf(
  startConf: number,
  startWords: number,
  chunks: string[],
  confs: number[]
): number {
  let num = startConf * startWords;
  let den = startWords;
  for (let i = 0; i < chunks.length; i++) {
    const w = wordsOf(chunks[i]).length;
    num += confs[i] * w;
    den += w;
  }
  return den > 0 ? num / den : 1;
}

function composeText(): string {
  return joinChunks(sectionBase, liveChunks);
}

function composeConf(): number {
  return avgConf(baseConf, wordsOf(sectionBase).length, liveChunks, liveConfs);
}

/* Next speech goes into a brand new section. */
function startSection(): void {
  if (liveChunks.length) {
    skipWords = wordsOf(liveChunks[liveChunks.length - 1]);
  }
  liveSectionId = null;
  sectionBase = '';
  baseConf = 1;
  liveChunks = [];
  liveConfs = [];
}

/* A long silence means the lecturer moved on: start a new section. */
function noteSpeech(): void {
  const now = Date.now();
  if (
    lastSpeechAt &&
    now - lastSpeechAt >= SILENCE_NEW_SECTION_MS &&
    liveSectionId
  ) {
    startSection();
  }
  lastSpeechAt = now;
}

function liveRemainder(raw: string): string {
  let w = wordsOf(raw.trim());
  if (skipWords.length && startsWithWords(w, skipWords)) {
    w = w.slice(skipWords.length);
  }
  const last = liveChunks.length
    ? wordsOf(liveChunks[liveChunks.length - 1])
    : [];
  if (last.length && startsWithWords(w, last)) {
    w = w.slice(last.length);
  }
  return w.join(' ');
}

function addSpoken(noteId: string, transcript: string, conf: number): void {
  const n = notes.find(x => x.id === noteId);
  if (!n) {
    return;
  }
  if (liveNoteId !== noteId) {
    liveNoteId = noteId;
    liveSectionId = null;
    sectionBase = '';
    baseConf = 1;
    liveChunks = [];
    liveConfs = [];
    skipWords = [];
  }
  let incoming = wordsOf(transcript.trim());
  if (skipWords.length) {
    if (startsWithWords(incoming, skipWords)) {
      incoming = incoming.slice(skipWords.length);
    } else if (startsWithWords(skipWords, incoming)) {
      incoming = [];
    } else {
      skipWords = [];
    }
  }
  if (!incoming.length) {
    return;
  }
  let sec: Segment | undefined = liveSectionId
    ? n.segments.find(s => s.id === liveSectionId)
    : undefined;
  if (!sec) {
    sec = { id: uid(), t: elapsedFor(noteId), text: '', conf: 1, mark: false };
    n.segments.push(sec);
    liveSectionId = sec.id;
    sectionBase = '';
    baseConf = 1;
    liveChunks = [];
    liveConfs = [];
  } else if (sec.text !== composeText()) {
    sectionBase = sec.text;
    baseConf = sec.conf;
    liveChunks = [];
    liveConfs = [];
  }
  if (!mergeInto(liveChunks, liveConfs, incoming.join(' '), conf)) {
    return;
  }
  sec.text = composeText();
  sec.conf = composeConf();
  n.updatedAt = Date.now();
  scheduleSave();
  if ((route.view === 'live' || route.view === 'detail') && route.id === noteId) {
    renderTranscript();
  }
}

function addTyped(noteId: string, text: string): void {
  const n = notes.find(x => x.id === noteId);
  const clean = text.trim();
  if (!n || !clean) {
    return;
  }
  n.segments.push({
    id: uid(),
    t: elapsedFor(noteId),
    text: capitalize(clean),
    conf: 1,
    mark: false,
    typed: true,
  });
  startSection();
  n.updatedAt = Date.now();
  saveNotes();
  renderTranscript();
}

/* One-time clean-up of notes saved by the first version, which stored every
   partial update as its own line. */
function tidyOldNotes(): void {
  const key = 'lecturescribe-tidy-v2';
  try {
    if (localStorage.getItem(key)) {
      return;
    }
    for (const n of notes) {
      if (n.segments.length < 2) {
        continue;
      }
      const merged: Segment[] = [];
      let cur: Segment | null = null;
      let chunks: string[] = [];
      let confs: number[] = [];
      let prevT = 0;
      for (const s of n.segments) {
        const gap = s.t - prevT;
        if (!cur || gap >= SILENCE_NEW_SECTION_MS / 1000) {
          cur = { id: uid(), t: s.t, text: '', conf: 1, mark: false };
          merged.push(cur);
          chunks = [];
          confs = [];
        }
        prevT = s.t;
        if (s.mark) {
          cur.mark = true;
        }
        mergeInto(chunks, confs, s.text, s.conf);
        cur.text = joinChunks('', chunks);
        cur.conf = avgConf(1, 0, chunks, confs);
      }
      n.segments = merged;
    }
    localStorage.setItem(key, '1');
    saveNotes();
  } catch {
    /* leave notes as they are */
  }
}

/* ---------- speech engine ---------- */

function startRecording(noteId: string): void {
  const n = notes.find(x => x.id === noteId);
  if (!n) {
    return;
  }
  if (!SR) {
    toast('Live transcription needs Chrome or Edge. You can still type notes.');
    return;
  }
  if (IOS && !iosWarned) {
    iosWarned = true;
    toast('Live transcription on iPhone can stop unexpectedly. Typed notes always work.');
  }
  if (recording) {
    if (recId === noteId) {
      return;
    }
    stopRecording();
  }
  lastError = '';
  netErrors = 0;
  fastFails = 0;
  lastActivityAt = 0;
  recId = noteId;
  wantRecording = true;
  recording = true;
  sessionStart = Date.now();
  baseDuration = n.duration;
  beginRecognition();
  acquireWakeLock();
  timerHandle = window.setInterval(tickTimer, 1000);
  if (route.view === 'live' && route.id === noteId) {
    startMeter();
  }
  updateStatus();
}

function stopRecording(): void {
  if (recording && recId) {
    const n = notes.find(x => x.id === recId);
    if (n) {
      n.duration = elapsedFor(recId);
      n.updatedAt = Date.now();
    }
  }
  wantRecording = false;
  recording = false;
  window.clearTimeout(restartTimer);
  window.clearInterval(timerHandle);
  const r = recognition;
  recognition = null;
  if (r) {
    try {
      r.stop();
    } catch {
      /* already stopped */
    }
  }
  interimText = '';
  stopMeter();
  releaseWakeLock();
  saveNotes();
  updateInterim();
  updateStatus();
  renderTranscript();
}

function fatal(msg: string): void {
  stopRecording();
  lastError = msg;
  toast(msg);
  updateStatus();
}

function beginRecognition(): void {
  if (!SR || !wantRecording || !recId) {
    return;
  }
  const noteId = recId;
  const rec = new SR();
  const startedAt = Date.now();
  let gotResult = false;
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = settings.lang;
  rec.maxAlternatives = 1;
  const local = wantLocal();
  if (local) {
    rec.processLocally = true;
    rec.lang = localLang;
  }

  dbgMode = local ? 'On this phone (' + localLang + ')' : 'Online (' + settings.lang + ')';
  rec.onresult = (e: any) => {
    gotResult = true;
    dbgResults++;
    updateDebug();
    netErrors = 0;
    fastFails = 0;
    lastActivityAt = Date.now();
    if (lastError) {
      lastError = '';
      updateStatus();
    }
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alt = res[0];
      if (alt.transcript && alt.transcript.trim()) {
        noteSpeech();
      }
      if (res.isFinal) {
        const conf = alt.confidence > 0 ? alt.confidence : 1;
        addSpoken(noteId, alt.transcript, conf);
      } else {
        interim += alt.transcript;
      }
    }
    interimText = liveRemainder(interim);
    updateInterim();
  };

  rec.onerror = (e: any) => {
    const err = e.error;
    if (err !== 'aborted') {
      dbgErr = String(err);
      updateDebug();
    }
    if (err === 'no-speech' || err === 'aborted') {
      return;
    }
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      fatal(
        'Microphone is blocked. Allow mic access for this site in your browser settings, then try again.'
      );
      return;
    }
    if (err === 'audio-capture') {
      if (micStream) {
        disableRealWave();
        return;
      }
      fatal('No microphone found, or another app is using it.');
      return;
    }
    if (err === 'language-not-supported') {
      if (local) {
        localState = 'unavailable';
        localSticky = false;
        updateLocalRow();
        fatal(
          'Offline transcription is not installed. Connect to the internet and download it in Profile.'
        );
      } else {
        fatal('This language is not supported here. Pick another in Profile.');
      }
      return;
    }
    if (err === 'network') {
      netErrors++;
      if (netErrors >= 2 && localState === 'available') {
        localSticky = true;
      }
      lastError = navigator.onLine
        ? 'Cannot reach the speech service. Check your data connection.'
        : 'You are offline.';
      updateStatus();
      return;
    }
    lastError = 'Speech recognition error: ' + err;
    updateStatus();
  };

  rec.onend = () => {
    interimText = '';
    updateInterim();
    if (recognition === rec) {
      recognition = null;
    }
    if (!wantRecording) {
      return;
    }
    dbgRestarts++;
    updateDebug();
    if (!gotResult && Date.now() - startedAt < 1000) {
      fastFails++;
    } else {
      fastFails = 0;
    }
    if (fastFails >= 2 && micStream) {
      disableRealWave();
      fastFails = 0;
    }
    if (fastFails >= 5) {
      fatal(
        'Speech recognition keeps stopping. Check your connection and microphone, then start again.'
      );
      return;
    }
    restartTimer = window.setTimeout(beginRecognition, netErrors > 0 ? 1500 : 200);
  };

  recognition = rec;
  try {
    rec.start();
  } catch {
    restartTimer = window.setTimeout(beginRecognition, 500);
  }
}

/* ---------- offline transcription (Chrome on-device speech) ---------- */

function wantLocal(): boolean {
  return localState === 'available' && !!localLang && (!navigator.onLine || localSticky);
}

function localLangs(): string[] {
  const out = [settings.lang];
  if (out.indexOf('en-US') < 0) {
    out.push('en-US');
  }
  return out;
}

async function refreshLocalState(): Promise<void> {
  const api: any = SR;
  if (!api || typeof api.available !== 'function') {
    localState = 'unsupported';
    updateLocalRow();
    return;
  }
  let best: LocalState = 'unavailable';
  let bestLang = '';
  for (const lang of localLangs()) {
    try {
      const r = await api.available({ langs: [lang], processLocally: true });
      if (r === 'available') {
        localState = 'available';
        localLang = lang;
        updateLocalRow();
        return;
      }
      if ((r === 'downloadable' || r === 'downloading') && best === 'unavailable') {
        best = r;
        bestLang = lang;
      }
    } catch {
      /* try the next language */
    }
  }
  localState = best;
  localLang = bestLang;
  updateLocalRow();
}

async function installLocal(): Promise<void> {
  const api: any = SR;
  if (!api || typeof api.install !== 'function' || !localLang) {
    return;
  }
  localState = 'downloading';
  updateLocalRow();
  try {
    const ok = await api.install({ langs: [localLang], processLocally: true });
    if (ok) {
      toast('Offline transcription is ready');
    } else {
      toast('Could not download the pack. Check your connection and try again.');
    }
  } catch {
    toast('Could not download the pack. Check your connection and try again.');
  }
  await refreshLocalState();
}

function localRowHtml(): string {
  let sub = 'Checking what this phone supports...';
  let btn = '';
  if (IS_NATIVE) {
    sub =
      "Using your phone's own speech service. For offline use, download your language in Android settings (Google, then Speech, then Offline speech recognition).";
  } else if (localState === 'unsupported') {
    sub =
      'This browser cannot transcribe on the phone yet, so live transcription needs internet. Typed notes always work offline.';
  } else if (localState === 'available') {
    sub = 'Ready. LectureScribe switches to on-device transcription when you have no internet.';
  } else if (localState === 'downloadable') {
    sub = 'Download a small language pack once while online. After that, transcription works offline.';
    btn = `<button data-action='install-local' class='btn-primary mt-3 w-full !py-3'>Download offline pack</button>`;
  } else if (localState === 'downloading') {
    sub = 'Downloading the language pack. Keep this page open.';
  } else if (localState === 'unavailable') {
    sub = 'On-device transcription is not available for this language on this phone.';
  }
  return `<span class='block font-semibold'>Offline transcription</span><span class='mt-0.5 block text-xs text-muted'>${sub}</span>${btn}`;
}

function updateLocalRow(): void {
  const el = document.getElementById('local-row');
  if (el) {
    el.innerHTML = localRowHtml();
  }
}

function restartEngine(): void {
  if (recording && recognition) {
    try {
      recognition.abort();
    } catch {
      /* it will restart on its own */
    }
  }
}

async function acquireWakeLock(): Promise<void> {
  try {
    const nav = navigator as any;
    if (nav.wakeLock) {
      wakeLock = await nav.wakeLock.request('screen');
    }
  } catch {
    /* optional */
  }
}

function releaseWakeLock(): void {
  try {
    if (wakeLock) {
      wakeLock.release();
    }
  } catch {
    /* optional */
  }
  wakeLock = null;
}

function tickTimer(): void {
  const live = document.getElementById('live-timer');
  if (live) {
    live.textContent = fmtTime(elapsedFor(route.id));
  }
  const mini = document.getElementById('mini-timer');
  if (mini) {
    mini.textContent = fmtTime(elapsedFor(recId));
  }
}

/* ---------- waveform: real volume and pitch, or speech activity ---------- */

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function teardownMeter(): void {
  analyser = null;
  waveBuf = null;
  if (micStream) {
    micStream.getTracks().forEach(t => {
      t.onended = null;
      (t as any).onmute = null;
      t.stop();
    });
    micStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => undefined);
    audioCtx = null;
  }
}

function stopMeter(): void {
  meterToken++;
  teardownMeter();
  waveMode = 'off';
  volSmooth = 0;
  pitchHz = 0;
}

function switchToActivity(): void {
  if (waveMode !== 'real') {
    return;
  }
  meterToken++;
  teardownMeter();
  waveMode = 'activity';
  refreshWaveInfo();
}

function disableRealWave(): void {
  settings.realWave = false;
  saveSettings();
  switchToActivity();
  toast('This phone cannot share its microphone with transcription. Showing a simple waveform instead.');
}

async function startMeter(): Promise<void> {
  const token = ++meterToken;
  teardownMeter();
  waveMode = 'activity';
  volSmooth = 0;
  pitchHz = 0;
  flatSince = 0;
  refreshWaveInfo();
  if (!settings.realWave) {
    return;
  }
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return;
  }
  try {
    const ctx: AudioContext = new AC();
    audioCtx = ctx;
    await sleep(700);
    if (token !== meterToken || !recording) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== meterToken || !recording) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    micStream = stream;
    try {
      await ctx.resume();
    } catch {
      /* may stay suspended */
    }
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    analyser = an;
    waveBuf = new Float32Array(an.fftSize);
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => switchToActivity();
      (track as any).onmute = () => switchToActivity();
    }
    waveMode = 'real';
    refreshWaveInfo();
  } catch {
    if (token === meterToken) {
      teardownMeter();
      waveMode = 'activity';
      refreshWaveInfo();
    }
  }
}

/* Finds the pitch of a voice in Hz, or 0 when there is no clear pitch. */
function detectPitch(buf: Float32Array, sr: number): number {
  const n = buf.length;
  const minLag = Math.floor(sr / 400);
  const maxLag = Math.min(Math.floor(sr / 70), n - 2);
  const rs = new Float32Array(maxLag + 2);
  let best = -1;
  let bestR = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let e1 = 0;
    let e2 = 0;
    const lim = n - lag;
    for (let i = 0; i < lim; i++) {
      const a = buf[i];
      const b = buf[i + lag];
      sum += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const r = sum / (Math.sqrt(e1 * e2) + 1e-9);
    rs[lag] = r;
    if (r > bestR) {
      bestR = r;
      best = lag;
    }
  }
  if (best < 0 || bestR < 0.55) {
    return 0;
  }
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (rs[lag] >= 0.9 * bestR && rs[lag] > rs[lag - 1] && rs[lag] >= rs[lag + 1]) {
      best = lag;
      break;
    }
  }
  return sr / best;
}

function volLabel(): string {
  if (volSmooth < 0.1) {
    return 'Silent';
  }
  if (volSmooth < 0.35) {
    return 'Faint';
  }
  return volSmooth < 0.7 ? 'Normal' : 'Loud';
}

function pitchLabel(): string {
  if (pitchHz <= 0) {
    return 'None';
  }
  return pitchHz < 125 ? 'Low' : pitchHz < 185 ? 'Mid' : 'High';
}

function updateDebug(): void {
  const el = document.getElementById('dbg');
  if (!el) {
    return;
  }
  const ago = lastActivityAt ? Math.round((Date.now() - lastActivityAt) / 1000) + 's ago' : 'none yet';
  el.textContent =
    'Engine: ' + (dbgMode || 'not started') +
    ' | Phrases heard: ' + dbgResults +
    ' | Last speech: ' + ago +
    ' | Restarts: ' + dbgRestarts +
    ' | Last error: ' + (dbgErr || 'none') +
    ' | Second mic stream: ' + (waveMode === 'real' ? 'on' : 'off');
}

function refreshWaveInfo(): void {
  updateDebug();
  const info = document.getElementById('wave-info');
  const legend = document.getElementById('wave-legend');
  const title = document.getElementById('wave-title');
  if (!info) {
    return;
  }
  const active = recording && recId === route.id;
  let text = 'Paused';
  if (active) {
    if (waveMode === 'real') {
      text = 'Volume: ' + volLabel() + ' | Pitch: ' + pitchLabel();
    } else {
      text = Date.now() - lastActivityAt < 1800 ? 'Speech detected' : 'Waiting for speech';
    }
  }
  info.textContent = text;
  if (legend) {
    legend.style.display = active && waveMode === 'real' ? 'flex' : 'none';
  }
  if (title) {
    title.textContent = active ? 'Listening to your lecturer' : 'Not listening';
  }
}

function waveFrame(ts: number): void {
  waveRaf = requestAnimationFrame(waveFrame);
  if (ts - waveLast < 50) {
    return;
  }
  waveLast = ts;
  const cv = document.getElementById('wave-canvas') as HTMLCanvasElement | null;
  if (!cv) {
    return;
  }
  let amp = 0;
  let pit = -1;
  const active = recording && recId === route.id;
  if (active) {
    if (waveMode === 'real' && analyser && waveBuf) {
      analyser.getFloatTimeDomainData(waveBuf as any);
      let sum = 0;
      for (let i = 0; i < waveBuf.length; i++) {
        sum += waveBuf[i] * waveBuf[i];
      }
      const rms = Math.sqrt(sum / waveBuf.length);
      const db = 20 * Math.log10(rms + 1e-8);
      const target = clamp((db + 60) / 45, 0, 1);
      volSmooth = target > volSmooth ? target * 0.7 + volSmooth * 0.3 : volSmooth * 0.8 + target * 0.2;
      amp = volSmooth;
      if (rms < 0.0003 && Date.now() - lastActivityAt < 1500) {
        if (!flatSince) {
          flatSince = Date.now();
        } else if (Date.now() - flatSince > 4000) {
          switchToActivity();
        }
      } else {
        flatSince = 0;
      }
      if (target > 0.2) {
        quietFrames = 0;
        const hz = detectPitch(waveBuf, audioCtx ? audioCtx.sampleRate : 44100);
        if (hz > 0) {
          pitchHz = pitchHz ? pitchHz * 0.6 + hz * 0.4 : hz;
        }
      } else {
        quietFrames++;
        if (quietFrames > 20) {
          pitchHz = 0;
        }
      }
      pit = pitchHz > 0 ? clamp((pitchHz - 80) / 200, 0, 1) : 0.45;
    } else {
      const speaking = Date.now() - lastActivityAt < 1800;
      noiseV = noiseV * 0.55 + Math.random() * 0.45;
      amp = speaking ? 0.3 + noiseV * 0.55 : 0.03;
    }
  }
  waveHist.push([amp, pit]);
  if (waveHist.length > 400) {
    waveHist.splice(0, waveHist.length - 400);
  }
  drawWave(cv);
  infoCounter++;
  if (infoCounter % 5 === 0) {
    refreshWaveInfo();
  }
}

function drawWave(cv: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) {
    return;
  }
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const step = 6;
  const count = Math.floor(w / step);
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.5;
  for (let i = 0; i < count; i++) {
    const idx = waveHist.length - 1 - i;
    const x = w - 4 - i * step;
    const s = idx >= 0 ? waveHist[idx] : null;
    const a = s ? s[0] : 0;
    const p = s ? s[1] : -1;
    const bh = Math.max(3, a * (h - 6));
    let r = LAV[0];
    let g = LAV[1];
    let b = LAV[2];
    if (waveMode === 'real' && p >= 0) {
      r = GREEN[0] + (LAV[0] - GREEN[0]) * p;
      g = GREEN[1] + (LAV[1] - GREEN[1]) * p;
      b = GREEN[2] + (LAV[2] - GREEN[2]) * p;
    }
    ctx.strokeStyle =
      'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + (a < 0.06 ? 0.35 : 0.95) + ')';
    ctx.beginPath();
    ctx.moveTo(x, h / 2 - bh / 2);
    ctx.lineTo(x, h / 2 + bh / 2);
    ctx.stroke();
  }
}

function startWaveLoop(): void {
  stopWaveLoop();
  waveHist = [];
  waveRaf = requestAnimationFrame(waveFrame);
}

function stopWaveLoop(): void {
  cancelAnimationFrame(waveRaf);
  waveRaf = 0;
}

/* ---------- routing ---------- */

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/');
  const a = parts[0];
  const id = parts[1] || '';
  if (a === 'lectures') {
    return { view: 'lectures', id: '' };
  }
  if (a === 'notes') {
    return { view: 'notes', id: '' };
  }
  if (a === 'profile') {
    return { view: 'profile', id: '' };
  }
  if ((a === 'lecture' || a === 'live') && id && notes.some(n => n.id === id)) {
    return { view: a === 'live' ? 'live' : 'detail', id: id };
  }
  return { view: 'home', id: '' };
}

function go(path: string): void {
  const target = '#/' + path;
  if (location.hash === target) {
    render();
  } else {
    location.hash = target;
  }
}

function hideSplash(): void {
  if (splashGone) {
    return;
  }
  splashGone = true;
  const el = document.getElementById('splash');
  if (!el) {
    return;
  }
  /* show the opening animation for at least a moment so it never just flashes */
  const wait = Math.max(0, 1000 - performance.now());
  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 700);
  }, wait);
}

function staggerIn(): void {
  let i = 0;
  root.querySelectorAll<HTMLElement>('.card, .btn-ghost').forEach(el => {
    if (i < 14) {
      el.classList.add('stagger-in');
      el.style.setProperty('--i', String(i));
    }
    i++;
  });
}

function render(): void {
  if (authState !== 'loading') {
    hideSplash();
  }
  if (authState !== 'in') {
    closeModal();
    hideTip();
    stopWaveLoop();
    if (authState === 'loading') {
      root.innerHTML = '';
    } else {
      renderAuth();
    }
    return;
  }
  closeModal();
  hideTip();
  stopWaveLoop();
  route = parseRoute();
  editingSegment = false;
  if (route.view !== 'live') {
    if (waveMode !== 'off') {
      meterToken++;
      teardownMeter();
      waveMode = 'off';
    }
  }
  switch (route.view) {
    case 'lectures':
      renderLectures();
      break;
    case 'notes':
      renderNotes();
      break;
    case 'profile':
      renderProfile();
      break;
    case 'detail':
      renderDetail();
      break;
    case 'live':
      renderLive();
      break;
    default:
      renderHome();
      break;
  }
  window.scrollTo(0, 0);
  const key = route.view + ':' + route.id;
  if (key !== lastRouteKey) {
    lastRouteKey = key;
    const first = root.firstElementChild;
    if (first) {
      first.classList.add('screen-in');
    }
    staggerIn();
  }
}

/* ---------- shell: bottom nav and recording bar ---------- */

function navBtn(to: string, label: string, icon: string): string {
  const on = route.view === to || (to === 'lectures' && route.view === 'detail');
  return `<button data-action='nav' data-to='${to}' class='flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-semibold ${on ? 'text-primary' : 'text-muted'}' ${on ? "aria-current='page'" : ''}>${ic(icon, 22)}<span>${label}</span></button>`;
}

function navHtml(): string {
  return `<nav class='fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur' style='padding-bottom:env(safe-area-inset-bottom)'>
    <div class='mx-auto flex max-w-xl items-end px-2'>
      ${navBtn('home', 'Home', 'home')}
      ${navBtn('lectures', 'Lectures', 'book')}
      <div class='flex flex-1 flex-col items-center'>
        <button data-action='record-nav' aria-label='Record a lecture' class='aurora-btn -mt-6 flex h-16 w-16 items-center justify-center rounded-full shadow-lg ring-4 ring-bg'>${ic('mic', 28)}</button>
        <span class='pb-2.5 pt-1 text-xs font-semibold text-muted'>Record</span>
      </div>
      ${navBtn('notes', 'Notes', 'notes')}
      ${navBtn('profile', 'Profile', 'user')}
    </div>
  </nav>`;
}

function miniBar(navShown: boolean): string {
  if (!recording || !recId || route.view === 'live') {
    return '';
  }
  const n = notes.find(x => x.id === recId);
  if (!n) {
    return '';
  }
  return `<button id='mini-rec' data-action='open-live' class='rise-in fixed inset-x-4 ${navShown ? 'bottom-24' : 'bottom-4'} z-30 mx-auto flex max-w-xl items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-left text-bg shadow-lg'>
      <span class='pulse-dot h-2.5 w-2.5 shrink-0 rounded-full bg-coral'></span>
      <span class='min-w-0 flex-1 truncate text-sm font-semibold'>Recording: ${esc(n.title)}</span>
      <span id='mini-timer' class='text-sm font-semibold tabular-nums'>${fmtTime(elapsedFor(recId))}</span>
    </button>`;
}

function shell(inner: string, navShown: boolean): string {
  return inner + miniBar(navShown) + (navShown ? navHtml() : '');
}

/* ---------- screens ---------- */

const UNSUPPORTED = `<div class='mt-4 rounded-2xl border border-amber/50 bg-ambersoft p-4 text-sm text-amberink'>Live transcription is not available in this browser. Open LectureScribe in <b>Chrome</b> (Android or desktop) or <b>Edge</b> to turn speech into notes. You can still type notes.</div>`;

const IOS_NOTE = `<div class='mt-4 rounded-2xl border border-amber/50 bg-ambersoft p-4 text-sm text-amberink'>Live transcription on iPhone is limited and can stop without warning. If it does, tap Resume, or type your notes. They save on this phone either way.</div>`;

const TIPS = `<ul class='list-disc space-y-2 pl-5 text-sm text-muted'>
    <li>Sit as close to the lecturer as you can and point your phone's microphone towards them.</li>
    <li>Wired earphones with a mic, or a clip-on mic, pick up faint voices far better than a phone on a desk.</li>
    <li>Watch the waveform while the lecturer speaks. If it barely moves, move closer.</li>
    <li>Keep your data connection on. Chrome's speech engine works online.</li>
    <li>Sections marked <b>check</b> had low confidence. Tap one to correct it after class.</li>
    <li>Tap <b>Section</b> when the lecturer starts a new topic. A pause of 30 seconds or more also starts a new section.</li>
    <li>Tap <b>Mark</b> to star the section being written, such as an exam hint.</li>
  </ul>`;

function greeting(): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = profile.name.trim().split(' ')[0];
  return first ? part + ', ' + esc(first) : part;
}

function avatar(size: string): string {
  const inner = profile.photo
    ? `<img src='${profile.photo}' alt='' class='h-full w-full object-cover'>`
    : profile.name.trim()
      ? `<span class='font-display text-lg font-bold'>${esc(profile.name.trim().charAt(0).toUpperCase())}</span>`
      : ic('user', 22);
  return `<span class='flex ${size} items-center justify-center overflow-hidden rounded-full bg-lavsoft text-lavink'>${inner}</span>`;
}

function courseTile(course: string): string {
  const label = course ? esc(course.replace(/\s+/g, '').slice(0, 3)) : '?';
  return `<span class='flex h-11 w-11 shrink-0 items-center justify-center rounded-xl font-display text-sm font-bold ${course ? courseTone(course) : 'bg-surface2 text-muted'}'>${label}</span>`;
}

function stats(): { count: number; secs: number; saved: number } {
  let secs = 0;
  let saved = 0;
  for (const n of notes) {
    secs += n.duration;
    for (const s of n.segments) {
      if (s.mark || s.typed) {
        saved++;
      }
    }
  }
  return { count: notes.length, secs: secs, saved: saved };
}

function recentCard(n: Note): string {
  const text = n.segments.map(s => s.text).join(' ');
  const snippet = text.length > 90 ? text.slice(0, 90) + '...' : text;
  return `<button data-action='open-lecture' data-id='${n.id}' class='card block w-[78%] shrink-0 snap-start p-4 text-left'>
      <div class='flex items-center gap-3'>${courseTile(n.course)}<div class='min-w-0'><p class='truncate text-sm font-semibold text-muted'>${esc(n.course || 'No course code')}</p><p class='text-xs text-muted'>${fmtDate(n.createdAt)}</p></div></div>
      <h3 class='mt-3 truncate text-base font-bold'>${esc(n.title)}</h3>
      <p class='mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-muted'>${snippet ? esc(snippet) : 'No text yet.'}</p>
      <p class='mt-2 flex items-center gap-1.5 text-xs font-semibold text-muted'>${ic('clock', 14)} ${fmtDur(n.duration)}</p>
    </button>`;
}

/* ---------- charts (inline SVG-free, built from your own lectures) ---------- */

interface DayBar {
  label: string;
  full: string;
  mins: number;
  today: boolean;
}

const AXIS_STEPS = [10, 20, 30, 60, 90, 120, 180, 240, 360, 480, 720, 960];

function niceMax(mins: number): number {
  for (const s of AXIS_STEPS) {
    if (mins <= s) {
      return s;
    }
  }
  return Math.ceil(mins / 240) * 240;
}

function axisLabel(m: number): string {
  if (m === 0) {
    return '0';
  }
  if (m < 60) {
    return m + 'm';
  }
  const h = m / 60;
  return (h % 1 === 0 ? String(h) : h.toFixed(1)) + 'h';
}

function shortDur(mins: number): string {
  if (mins < 1) {
    return '<1m';
  }
  if (mins < 60) {
    return Math.round(mins) + 'm';
  }
  const h = mins / 60;
  return (h % 1 < 0.05 ? String(Math.round(h)) : h.toFixed(1)) + 'h';
}

function weekData(): DayBar[] {
  const out: DayBar[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const end = new Date(d.getTime());
    end.setDate(d.getDate() + 1);
    let secs = 0;
    for (const n of notes) {
      if (n.createdAt >= d.getTime() && n.createdAt < end.getTime()) {
        secs += n.duration;
      }
    }
    out.push({
      label: d.toLocaleDateString('en-GB', { weekday: 'short' }),
      full: d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }),
      mins: secs / 60,
      today: i === 0,
    });
  }
  return out;
}

function weekChart(): string {
  const days = weekData();
  const total = days.reduce((a, d) => a + d.mins, 0);
  const maxMin = Math.max(...days.map(d => d.mins));
  const head = `<div class='flex items-start justify-between gap-3'>
      <div class='min-w-0'><h2 class='font-display text-lg font-bold'>Study time this week</h2><p class='text-sm text-muted'>Recorded time by day</p></div>
      <p class='shrink-0 whitespace-nowrap font-display text-xl font-bold'>${fmtDur(total * 60)}</p>
    </div>`;
  if (total <= 0) {
    return `<section class='card mt-5 p-4'>${head}<p class='mt-4 rounded-xl bg-surface2 px-4 py-6 text-center text-sm text-muted'>No lectures recorded in the last 7 days. Tap Record to start one.</p></section>`;
  }
  const top = niceMax(maxMin);
  const cols = days
    .map((d, i) => {
      const h = d.mins > 0 ? Math.max(3, Math.round((d.mins / top) * 100)) : 0;
      const isMax = d.mins === maxMin && d.mins > 0;
      const tipVal = d.mins > 0 ? fmtDur(d.mins * 60) : 'No recording';
      return `<button type='button' class='chart-hit relative flex h-full flex-1 items-end justify-center' data-tip-title='${esc(d.full)}' data-tip-val='${esc(tipVal)}' aria-label='${esc(d.full)}: ${esc(tipVal)}'>
        ${isMax ? `<span class='absolute left-0 right-0 text-center text-xs font-semibold text-ink' style='bottom:calc(${h}% + 4px)'>${shortDur(d.mins)}</span>` : ''}
        <span data-tip-anchor class='bar-y block w-full max-w-[24px] rounded-t-[4px] bg-m1' style='height:${h}%;--i:${i}'></span>
      </button>`;
    })
    .join('');
  const labels = days
    .map(
      d =>
        `<span class='flex-1 text-center text-xs ${d.today ? 'font-bold text-ink' : 'text-muted'}'>${esc(d.label)}</span>`
    )
    .join('');
  const rows = days
    .map(d => `<tr><th scope='row'>${esc(d.full)}</th><td>${esc(fmtDur(d.mins * 60))}</td></tr>`)
    .join('');
  return `<section class='card mt-5 p-4'>
    ${head}
    <div class='mt-7 flex gap-2'>
      <div class='relative h-36 w-9 shrink-0 text-xs text-muted'>
        <span class='absolute right-0 top-0 -translate-y-1/2'>${axisLabel(top)}</span>
        <span class='absolute right-0 top-1/2 -translate-y-1/2'>${axisLabel(top / 2)}</span>
        <span class='absolute bottom-0 right-0 translate-y-1/2'>0</span>
      </div>
      <div class='relative h-36 flex-1'>
        <div class='absolute inset-x-0 top-0 border-t border-line'></div>
        <div class='absolute inset-x-0 top-1/2 border-t border-line'></div>
        <div class='absolute inset-x-0 bottom-0 border-t border-line'></div>
        <div class='absolute inset-0 flex gap-1'>${cols}</div>
      </div>
    </div>
    <div class='flex gap-2'><div class='w-9 shrink-0'></div><div class='flex flex-1 gap-1 pt-2'>${labels}</div></div>
    <table class='sr-only'><caption>Recorded time by day, last 7 days</caption><tbody>${rows}</tbody></table>
  </section>`;
}

function courseChart(): string {
  const map: Record<string, { mins: number; count: number }> = {};
  for (const n of notes) {
    if (n.duration <= 0) {
      continue;
    }
    const k = n.course || 'No course code';
    if (!map[k]) {
      map[k] = { mins: 0, count: 0 };
    }
    map[k].mins += n.duration / 60;
    map[k].count++;
  }
  const all = Object.keys(map)
    .map(k => ({ name: k, mins: map[k].mins, count: map[k].count }))
    .sort((a, b) => b.mins - a.mins);
  if (all.length < 2) {
    return '';
  }
  let rows = all.slice(0, 5);
  if (all.length > 5) {
    const rest = all.slice(5);
    rows = rows.concat([
      {
        name: 'Other',
        mins: rest.reduce((a, r) => a + r.mins, 0),
        count: rest.reduce((a, r) => a + r.count, 0),
      },
    ]);
  }
  const max = Math.max(...rows.map(r => r.mins));
  const bars = rows
    .map((r, i) => {
      const pct = Math.max(2, Math.round((r.mins / max) * 100));
      const tipVal = fmtDur(r.mins * 60);
      const tipTitle = r.name + ', ' + r.count + (r.count === 1 ? ' lecture' : ' lectures');
      return `<button type='button' class='chart-hit flex w-full items-center gap-3 py-1.5 text-left' data-tip-title='${esc(tipTitle)}' data-tip-val='${esc(tipVal)}' aria-label='${esc(tipTitle)}: ${esc(tipVal)}'>
        <span class='w-20 shrink-0 truncate text-sm font-semibold'>${esc(r.name)}</span>
        <span class='relative h-2.5 flex-1'><span data-tip-anchor class='bar-x absolute inset-y-0 left-0 rounded-r-[4px] bg-m1' style='width:${pct}%;--i:${i}'></span></span>
        <span class='w-14 shrink-0 text-right text-sm text-muted tabular-nums'>${shortDur(r.mins)}</span>
      </button>`;
    })
    .join('');
  const trows = rows
    .map(r => `<tr><th scope='row'>${esc(r.name)}</th><td>${esc(fmtDur(r.mins * 60))}</td></tr>`)
    .join('');
  return `<section class='card mt-4 p-4'>
    <h2 class='font-display text-lg font-bold'>Where your time goes</h2>
    <p class='text-sm text-muted'>Recorded time per course</p>
    <div class='mt-3'>${bars}</div>
    <table class='sr-only'><caption>Recorded time per course</caption><tbody>${trows}</tbody></table>
  </section>`;
}

function timelineCard(n: Note): string {
  const secs = n.segments;
  let total = n.duration;
  for (const s of secs) {
    total = Math.max(total, s.t);
  }
  if (secs.length < 2 || total < 30) {
    return '';
  }
  let said = 0;
  let starred = 0;
  let typed = 0;
  const marks = secs
    .map(s => {
      const left = clamp((s.t / total) * 100, 0, 100);
      let shape = `<i data-tip-anchor class='block h-2.5 w-2.5 rounded-full bg-m1 ring-2 ring-surface'></i>`;
      let kind = 'Spoken';
      if (s.mark) {
        shape = `<i data-tip-anchor class='block h-2.5 w-2.5 rotate-45 bg-m2 ring-2 ring-surface'></i>`;
        kind = 'Starred';
        starred++;
      } else if (s.typed) {
        shape = `<i data-tip-anchor class='block h-2.5 w-2.5 rounded-[2px] bg-m3 ring-2 ring-surface'></i>`;
        kind = 'Typed';
        typed++;
      } else {
        said++;
      }
      const snippet = s.text.length > 80 ? s.text.slice(0, 80) + '...' : s.text;
      const title = fmtTime(s.t) + ' - ' + kind;
      return `<button type='button' class='chart-hit absolute top-1/2 flex h-6 w-6 items-center justify-center' style='left:calc(${left.toFixed(2)}% - 12px);margin-top:-12px' data-tip-title='${esc(title)}' data-tip-val='${esc(snippet)}' aria-label='${esc(title)}: ${esc(snippet)}'>${shape}</button>`;
    })
    .join('');
  const key = (shape: string, label: string, count: number) =>
    count ? `<span class='inline-flex items-center gap-1.5'>${shape}${label} (${count})</span>` : '';
  const legend = [
    key(`<i class='block h-2.5 w-2.5 rounded-full bg-m1'></i>`, 'Spoken', said),
    key(`<i class='block h-2.5 w-2.5 rotate-45 bg-m2'></i>`, 'Starred', starred),
    key(`<i class='block h-2.5 w-2.5 rounded-[2px] bg-m3'></i>`, 'Typed', typed),
  ].join('');
  return `<section class='card mt-4 p-4'>
    <h2 class='font-display text-lg font-bold'>Lecture timeline</h2>
    <p class='text-sm text-muted'>When each section was captured</p>
    <div class='relative mx-3 mt-3 h-8'>
      <div class='absolute inset-x-0 top-1/2 border-t border-line'></div>
      ${marks}
    </div>
    <div class='mx-3 flex justify-between text-xs tabular-nums text-muted'><span>0:00</span><span>${fmtTime(total / 2)}</span><span>${fmtTime(total)}</span></div>
    <p class='mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted'>${legend}</p>
  </section>`;
}

function renderHome(): void {
  const st = stats();
  const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const statCard = (label: string, value: string) =>
    `<div class='card p-3.5'><p class='text-xs font-semibold text-muted'>${label}</p><p class='mt-1 font-display text-2xl font-bold'>${value}</p></div>`;
  root.innerHTML = shell(
    `<div class='pb-32'>
      <div class='aurora px-5 pb-24 pt-safe-6 text-white'>
        <div class='mx-auto flex max-w-xl items-center justify-between'>
          <div class='flex items-center gap-3'>
            <img src='./icon-192.png' alt='LectureScribe logo' width='44' height='44' class='h-11 w-11 shrink-0 rounded-2xl bg-white object-cover'>
            <div><p class='font-display text-lg font-bold leading-tight'>LectureScribe</p><p class='text-sm text-white/75'>${greeting()}</p></div>
          </div>
          <button data-action='nav' data-to='profile' aria-label='Open profile' class='rounded-full ring-2 ring-white/30'>${avatar('h-11 w-11')}</button>
        </div>
      </div>
      <div class='mx-auto -mt-[4.25rem] max-w-xl px-5'>
        <section class='card p-5 shadow-sm'>
          <h1 class='font-display text-2xl font-bold leading-tight'>Your lectures, made clearer.</h1>
          <p class='mt-1.5 text-sm text-muted'>Capture every word, even from the back of a crowded hall.</p>
          <button data-action='new-lecture' class='aurora-btn mt-4 inline-flex items-center gap-2 rounded-2xl px-5 py-3.5 font-bold'>${ic('mic', 20)} Start recording</button>
          ${SR ? (IOS ? IOS_NOTE : '') : UNSUPPORTED}
        </section>
        <div class='mt-4 grid grid-cols-3 gap-3'>
          ${statCard('Lectures recorded', String(st.count))}
          ${statCard('Time transcribed', fmtHours(st.secs))}
          ${statCard('Notes saved', String(st.saved))}
        </div>
        ${notes.length ? weekChart() + courseChart() : ''}
        <h2 class='mt-7 font-display text-lg font-bold'>Quick actions</h2>
        <div class='mt-3 grid grid-cols-3 gap-3'>
          <button data-action='resume-last' class='btn-ghost flex-col !gap-1.5 !px-2 !py-3 text-sm'>${ic('play', 20)}<span>Resume last</span></button>
          <button data-action='nav' data-to='notes' class='btn-ghost flex-col !gap-1.5 !px-2 !py-3 text-sm'>${ic('notes', 20)}<span>My notes</span></button>
          <button data-action='tips' class='btn-ghost flex-col !gap-1.5 !px-2 !py-3 text-sm'>${ic('help', 20)}<span>Mic tips</span></button>
        </div>
        <div class='mt-7 flex items-center justify-between'>
          <h2 class='font-display text-lg font-bold'>Recent lectures</h2>
          ${notes.length ? `<button data-action='nav' data-to='lectures' class='text-sm font-semibold text-primary'>View all</button>` : ''}
        </div>
        ${
          recent.length
            ? `<div class='no-scrollbar -mx-5 mt-3 flex snap-x gap-3 overflow-x-auto px-5 pb-1'>${recent.map(recentCard).join('')}</div>`
            : `<div class='card mt-3 p-5'><h3 class='font-bold'>No lectures yet</h3><p class='mb-3 mt-1 text-sm text-muted'>Start a lecture and LectureScribe types what the lecturer says. Tips for a crowded hall:</p>${TIPS}</div>`
        }
      </div>
    </div>`,
    true
  );
}

function inTime(n: Note): boolean {
  const age = Date.now() - n.createdAt;
  if (timeFilter === 'recent') {
    return age < 3 * DAY;
  }
  if (timeFilter === 'week') {
    return age < 7 * DAY;
  }
  if (timeFilter === 'month') {
    return age < 30 * DAY;
  }
  return true;
}

/* ---------- search with helper ---------- */

type SearchScope = 'lectures' | 'notes';

const SEARCH_CFG: Record<SearchScope, { input: string; ph: string; label: string }> = {
  lectures: {
    input: 'search',
    ph: 'Search courses, lectures or dates',
    label: 'Search lectures',
  },
  notes: { input: 'notes-search', ph: 'Search your notes', label: 'Search notes' },
};

function getQ(sc: SearchScope): string {
  return sc === 'notes' ? notesSearch : search;
}

function setQ(sc: SearchScope, v: string): void {
  if (sc === 'notes') {
    notesSearch = v;
  } else {
    search = v;
  }
}

function runSearch(sc: SearchScope): void {
  if (sc === 'notes') {
    renderNotesList();
  } else {
    renderLectureList();
  }
}

function saveRecent(): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches));
  } catch {
    /* recent searches just will not persist */
  }
}

function addRecent(q: string): void {
  const t = q.trim();
  if (t.length < 2) {
    return;
  }
  recentSearches = [t].concat(recentSearches.filter(r => r.toLowerCase() !== t.toLowerCase())).slice(0, 6);
  saveRecent();
}

function dateHay(n: Note): string {
  return (
    fmtDate(n.createdAt) +
    ' ' +
    new Date(n.createdAt).toLocaleDateString('en-GB', { weekday: 'long', month: 'long' })
  );
}

/* escapes the text and marks the first place the search words appear */
function hl(text: string, q: string): string {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    return esc(text);
  }
  return (
    esc(text.slice(0, i)) +
    "<mark class='hl'>" +
    esc(text.slice(i, i + q.length)) +
    '</mark>' +
    esc(text.slice(i + q.length))
  );
}

function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, i - 28);
  const end = Math.min(text.length, i + q.length + 60);
  return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
}

function helperHtml(sc: SearchScope): string {
  const q = getQ(sc).trim();
  const ql = q.toLowerCase();
  const row = (icon: string, title: string, sub: string, attrs: string) =>
    `<button type='button' ${attrs} data-scope='${sc}' class='help-row'><span class='help-ico'>${ic(icon, 16)}</span><span class='min-w-0 flex-1'><span class='block truncate text-sm font-semibold'>${title}</span><span class='block truncate text-xs text-muted'>${sub}</span></span></button>`;
  const counts = new Map<string, number>();
  for (const n of notes) {
    if (n.course) {
      counts.set(n.course, (counts.get(n.course) || 0) + 1);
    }
  }
  const courseList = Array.from(counts.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));

  if (!q) {
    let out = '';
    if (recentSearches.length) {
      out += `<div class='flex items-center justify-between px-2 pt-1'><p class='help-label'>Recent searches</p><button type='button' data-action='recent-clear' data-scope='${sc}' class='text-xs font-semibold text-primary'>Clear</button></div>
        <div class='flex flex-wrap gap-2 px-2 pb-2'>${recentSearches
          .map(
            r =>
              `<button type='button' data-action='search-pick' data-scope='${sc}' data-v='${esc(r)}' class='help-chip'>${ic('clock', 12)}${esc(r)}</button>`
          )
          .join('')}</div>`;
    }
    if (courseList.length) {
      out += `<p class='help-label px-2 pt-1'>Browse by course</p>
        <div class='flex flex-wrap gap-2 px-2 pb-2'>${courseList
          .map(
            c =>
              `<button type='button' data-action='search-pick' data-scope='${sc}' data-v='${esc(c[0])}' class='help-chip'>${esc(c[0])}<span class='text-muted'>${c[1]}</span></button>`
          )
          .join('')}</div>`;
    }
    out += `<p class='px-2 pb-1 pt-1 text-xs leading-relaxed text-muted'>Try a course code, a lecture title, a month like "Oct", or a word your lecturer said.</p>`;
    return out;
  }

  const courseHits = courseList.filter(c => c[0].toLowerCase().includes(ql)).slice(0, 4);
  const byRecent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
  const lectureHits = byRecent.filter(n => (n.title + ' ' + dateHay(n)).toLowerCase().includes(ql)).slice(0, 4);
  const textHits: { n: Note; s: Segment }[] = [];
  for (const n of byRecent) {
    if (textHits.length >= 4) {
      break;
    }
    for (const s of n.segments) {
      if (sc === 'notes' && !(s.mark || s.typed)) {
        continue;
      }
      if (s.text.toLowerCase().includes(ql)) {
        textHits.push({ n: n, s: s });
        break;
      }
    }
  }

  let out = '';
  if (courseHits.length) {
    out += `<p class='help-label px-2 pt-1'>Courses</p>${courseHits
      .map(c =>
        row('layers', hl(c[0], q), c[1] + (c[1] === 1 ? ' lecture' : ' lectures'), `data-action='search-pick' data-v='${esc(c[0])}'`)
      )
      .join('')}`;
  }
  if (lectureHits.length) {
    out += `<p class='help-label px-2 pt-2'>Lectures and dates</p>${lectureHits
      .map(n =>
        row('book', hl(n.title, q), (n.course ? esc(n.course) + ' - ' : '') + hl(fmtDate(n.createdAt), q), `data-action='search-open' data-id='${n.id}'`)
      )
      .join('')}`;
  }
  if (textHits.length) {
    out += `<p class='help-label px-2 pt-2'>What was said</p>${textHits
      .map(h =>
        row('notes', hl(snippet(h.s.text, q), q), esc(h.n.title) + ' - ' + fmtTime(h.s.t), `data-action='search-open' data-id='${h.n.id}'`)
      )
      .join('')}`;
  }
  if (!out) {
    return `<p class='px-3 py-4 text-center text-sm text-muted'>Nothing matches "${esc(q)}". Check the spelling or try fewer letters.</p>`;
  }
  out += `<button type='button' data-action='search-pick' data-scope='${sc}' data-v='${esc(q)}' class='help-all'>Show all results for "${esc(q)}"</button>`;
  return out;
}

function showHelper(sc: SearchScope): void {
  const el = document.getElementById(SEARCH_CFG[sc].input + '-help');
  if (el) {
    el.innerHTML = helperHtml(sc);
    el.hidden = false;
  }
}

function hideHelper(sc: SearchScope): void {
  const el = document.getElementById(SEARCH_CFG[sc].input + '-help');
  if (el) {
    el.hidden = true;
  }
}

function syncClear(sc: SearchScope): void {
  const btn = document.querySelector(`[data-action='search-clear'][data-scope='${sc}']`);
  if (btn) {
    btn.classList.toggle('hidden', !getQ(sc));
  }
}

function searchBar(sc: SearchScope): string {
  const cfg = SEARCH_CFG[sc];
  const val = getQ(sc);
  return `<div class='relative mt-5'>
    <span class='pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted'>${ic('search', 18)}</span>
    <input id='${cfg.input}' type='text' inputmode='search' enterkeyhint='search' autocomplete='off' autocapitalize='none' spellcheck='false' value='${esc(val)}' placeholder='${cfg.ph}' class='field !pl-10 !pr-11' aria-label='${cfg.label}'>
    <button type='button' data-action='search-clear' data-scope='${sc}' aria-label='Clear search' class='absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-muted ${val ? '' : 'hidden'}'>${ic('x', 16)}</button>
    <div id='${cfg.input}-help' class='search-help' hidden></div>
  </div>`;
}

function renderLectures(): void {
  const courses = Array.from(new Set(notes.map(n => n.course).filter(c => !!c))).sort();
  const pill = (v: string, label: string) =>
    `<button data-action='set-time' data-v='${v}' class='pill ${timeFilter === v ? 'pill-on' : ''}'>${label}</button>`;
  root.innerHTML = shell(
    `<div class='mx-auto max-w-xl px-5 pb-32 pt-safe-6'>
      <h1 class='font-display text-3xl font-bold'>My lectures</h1>
      <p class='mt-1 text-sm text-muted'>Your lectures, organised by course with the dates each was recorded.</p>
      ${searchBar('lectures')}
      <div class='no-scrollbar mt-3 flex gap-2 overflow-x-auto'>
        ${pill('all', 'All')}${pill('recent', 'Recent')}${pill('week', 'This week')}${pill('month', 'This month')}
      </div>
      ${
        courses.length
          ? `<select id='course-filter' class='field mt-3' aria-label='Filter by course'><option value=''>All courses</option>${courses.map(c => `<option value='${esc(c)}' ${c === courseFilter ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`
          : ''
      }
      <div id='lecture-list' class='mt-4 space-y-3'></div>
    </div>`,
    true
  );
  renderLectureList();
}

function renderLectureList(): void {
  const el = document.getElementById('lecture-list');
  if (!el) {
    return;
  }
  const q = search.trim().toLowerCase();
  const list = notes.filter(n => {
    if (courseFilter && n.course !== courseFilter) {
      return false;
    }
    if (!inTime(n)) {
      return false;
    }
    if (!q) {
      return true;
    }
    const hay = (n.title + ' ' + n.course + ' ' + dateHay(n) + ' ' + n.segments.map(s => s.text).join(' ')).toLowerCase();
    return hay.includes(q);
  });
  if (!list.length) {
    el.innerHTML = notes.length
      ? `<p class='py-10 text-center text-muted'>No lectures match your search.</p>`
      : `<div class='card p-5 text-center'><h2 class='font-bold'>No lectures yet</h2><p class='mt-1 text-sm text-muted'>Tap the Record button to start your first lecture.</p></div>`;
    return;
  }
  const groups = new Map<string, Note[]>();
  for (const n of list) {
    const k = n.course || '';
    const g = groups.get(k);
    if (g) {
      g.push(n);
    } else {
      groups.set(k, [n]);
    }
  }
  const newest = (g: Note[]) => Math.max(...g.map(n => n.createdAt));
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (!a) {
      return 1;
    }
    if (!b) {
      return -1;
    }
    return newest(groups.get(b) as Note[]) - newest(groups.get(a) as Note[]);
  });
  const dayMon = (ts: number) =>
    new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const year = (ts: number) => String(new Date(ts).getFullYear());

  const sections = keys
    .map(k => {
      const g = (groups.get(k) as Note[]).sort((a, b) => b.createdAt - a.createdAt);
      const first = g[g.length - 1].createdAt;
      const last = g[0].createdAt;
      const range = g.length === 1 ? fmtDate(last) : fmtDate(first) + ' - ' + fmtDate(last);
      const closed = !q && collapsedCourses.has(k);
      const rows = g
        .map(n => {
          const stars = n.segments.filter(s => s.mark).length;
          return `<tr class='lec-row' data-action='open-lecture' data-id='${n.id}'>
            <td class='lec-date'><span class='block font-semibold tabular-nums'>${dayMon(n.createdAt)}</span><span class='block text-[11px] text-muted'>${year(n.createdAt)}</span></td>
            <td class='lec-title'><button type='button' data-action='open-lecture' data-id='${n.id}' class='block w-full text-left font-semibold leading-snug'>${hl(n.title, q)}</button><span class='mt-0.5 block text-xs text-muted'>${n.segments.length} ${n.segments.length === 1 ? 'section' : 'sections'}${stars ? ' - ' + stars + ' starred' : ''}</span></td>
            <td class='lec-dur'>${fmtDur(n.duration)}</td>
            <td class='lec-more'><button type='button' data-action='lecture-menu' data-id='${n.id}' aria-label='More options for ${esc(n.title)}' class='flex h-9 w-9 items-center justify-center rounded-full text-muted active:bg-surface2'>${ic('more', 18)}</button></td>
          </tr>`;
        })
        .join('');
      return `<section class='card overflow-hidden ${closed ? 'is-closed' : ''}'>
        <button type='button' data-action='toggle-course' data-v='${esc(k)}' aria-expanded='${closed ? 'false' : 'true'}' class='flex w-full items-center gap-3 p-4 text-left'>
          ${courseTile(k)}
          <span class='min-w-0 flex-1'>
            <span class='block truncate font-display text-lg font-bold leading-tight'>${hl(k || 'No course code', q)}</span>
            <span class='block text-xs text-muted'>${g.length} ${g.length === 1 ? 'lecture' : 'lectures'} - ${range}</span>
          </span>
          <span class='chev-rot text-muted'>${ic('chev', 18)}</span>
        </button>
        <div class='fold'><div class='fold-in'>
          <table class='lec-table'>
            <thead><tr><th>Date</th><th>Lecture</th><th class='text-right'>Time</th><th><span class='sr-only'>Options</span></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div></div>
      </section>`;
    })
    .join('');
  el.innerHTML = `<p class='px-1 text-xs font-semibold text-muted'>${keys.length} ${keys.length === 1 ? 'course' : 'courses'} - ${list.length} ${list.length === 1 ? 'lecture' : 'lectures'}</p>${sections}`;
}

function sectionCard(s: Segment, live: boolean): string {
  const unsure = settings.showUnsure && !s.typed && s.conf < UNSURE_BELOW;
  const tone = s.mark ? 'bg-ambersoft ring-1 ring-amber/60' : 'bg-surface ring-1 ring-line';
  const editable = !(live && recording);
  const side = live
    ? s.mark
      ? `<span class='shrink-0 text-amber'>${ic('star', 18, true)}</span>`
      : ''
    : `<div class='flex shrink-0 flex-col gap-1'>
        <button data-action='star-seg' data-id='${s.id}' class='flex h-9 w-9 items-center justify-center rounded-lg ${s.mark ? 'text-amber' : 'text-muted'}' aria-label='${s.mark ? 'Remove star' : 'Star this section'}'>${ic('star', 18, s.mark)}</button>
        <button data-action='del-seg' data-id='${s.id}' class='flex h-9 w-9 items-center justify-center rounded-lg text-muted' aria-label='Delete this section'>${ic('trash', 18)}</button>
      </div>`;
  return `<div class='flex gap-3 rounded-2xl p-3.5 ${tone} ${unsure ? 'border-l-4 border-amber' : ''}'>
      <div class='w-11 shrink-0 pt-1'>
        <span class='block text-xs font-semibold tabular-nums text-muted'>${fmtTime(s.t)}</span>
        ${unsure ? `<span class='mt-1 block text-xs font-bold text-amberink'>check</span>` : ''}
        ${s.typed ? `<span class='mt-1 block text-xs font-bold text-lavink'>typed</span>` : ''}
      </div>
      <p class='seg-text min-w-0 flex-1 break-words text-[17px] leading-relaxed' ${editable ? "contenteditable='true'" : ''} data-seg='${s.id}'>${esc(s.text)}</p>
      ${side}
    </div>`;
}

function emptyTranscript(live: boolean): string {
  return live
    ? `<p class='py-8 text-center text-muted'>Nothing here yet. Words appear as soon as they are heard. Move your phone closer to the lecturer.</p>`
    : `<p class='py-8 text-center text-muted'>Nothing here yet. Resume recording, or type a note below.</p>`;
}

function renderTranscript(): void {
  const el = document.getElementById('transcript');
  const n = viewNote();
  if (!el || !n || editingSegment) {
    return;
  }
  const live = route.view === 'live';
  const box = live ? document.getElementById('live-scroll') : null;
  const stick = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 80 : false;
  el.innerHTML = n.segments.length
    ? n.segments.map(s => sectionCard(s, live)).join('')
    : emptyTranscript(live);
  if (box && recording && stick) {
    box.scrollTop = box.scrollHeight;
  }
}

function updateInterim(): void {
  const el = document.getElementById('interim');
  if (!el) {
    return;
  }
  el.textContent = interimText;
  el.classList.toggle('hidden', !interimText);
  const box = document.getElementById('live-scroll');
  if (box && interimText && recording) {
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (near) {
      box.scrollTop = box.scrollHeight;
    }
  }
}

function renderDetail(): void {
  const n = viewNote();
  if (!n) {
    go('lectures');
    return;
  }
  const stars = n.segments.filter(s => s.mark).length;
  const tab = (v: string, label: string) =>
    `<button data-action='set-tab' data-v='${v}' class='flex-1 border-b-2 px-2 py-3 text-sm font-bold ${detailTab === v ? 'border-primary text-ink' : 'border-transparent text-muted'}'>${label}</button>`;
  root.innerHTML = shell(
    `<div class='mx-auto max-w-xl px-5 pb-16 pt-safe-5'>
      <div class='flex items-center justify-between'>
        <button data-action='nav' data-to='lectures' class='iconbtn' aria-label='Back to lectures'>${ic('back')}</button>
        <h1 class='font-display text-lg font-bold'>Lecture details</h1>
        <button data-action='lecture-menu' data-id='${n.id}' class='iconbtn' aria-label='More options'>${ic('more')}</button>
      </div>
      <section class='card mt-5 p-5'>
        <input id='course' value='${esc(n.course)}' maxlength='20' placeholder='Course code, e.g. CSC 201' aria-label='Course code' class='w-full bg-transparent text-sm font-semibold text-primary outline-none placeholder:text-muted/70'>
        <input id='title' value='${esc(n.title)}' maxlength='80' aria-label='Lecture title' class='mt-1 w-full bg-transparent font-display text-2xl font-bold outline-none'>
        <p class='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted'>
          <span class='inline-flex items-center gap-1.5'>${ic('calendar', 16)} ${fmtDate(n.createdAt)}</span>
          <span class='inline-flex items-center gap-1.5'>${ic('clock', 16)} ${fmtDur(n.duration)}</span>
          <span>${n.segments.length} ${n.segments.length === 1 ? 'section' : 'sections'}</span>
        </p>
        <div class='mt-4 grid grid-cols-[1fr_auto_auto] gap-2'>
          <button data-action='resume-lecture' data-id='${n.id}' class='btn-primary whitespace-nowrap !px-3'>${ic('mic', 18)} Resume recording</button>
          <button data-action='copy' class='btn-ghost !px-3' aria-label='Copy text'>${ic('copy', 18)}</button>
          <button data-action='download' class='btn-ghost !px-3' aria-label='Download as text file'>${ic('download', 18)}</button>
        </div>
      </section>
      ${timelineCard(n)}
      <div class='mt-6 flex border-b border-line'>${tab('transcript', 'Transcript')}${tab('points', 'Key points' + (stars ? ' (' + stars + ')' : ''))}</div>
      <div id='detail-body' class='mt-4'></div>
    </div>`,
    false
  );
  renderDetailBody();
}

function renderDetailBody(): void {
  const body = document.getElementById('detail-body');
  const n = viewNote();
  if (!body || !n) {
    return;
  }
  if (detailTab === 'points') {
    const starred = n.segments.filter(s => s.mark);
    body.innerHTML = starred.length
      ? `<div class='space-y-3'>${starred.map(s => sectionCard(s, false)).join('')}</div>`
      : `<p class='py-8 text-center text-muted'>No starred sections yet. Tap the star on a section, or press Mark while recording.</p>`;
    return;
  }
  body.innerHTML = `<div id='transcript' class='space-y-3'></div>
    <form id='typed-form' class='mt-5 flex gap-2'>
      <input id='typed' autocomplete='off' placeholder='Type a note' aria-label='Type a note' class='field min-w-0 flex-1'>
      <button type='submit' class='btn-primary !px-5'>Add</button>
    </form>`;
  renderTranscript();
}

function noteItems(): { n: Note; s: Segment }[] {
  const out: { n: Note; s: Segment }[] = [];
  const q = notesSearch.trim().toLowerCase();
  for (const n of [...notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    for (const s of n.segments) {
      if (!(s.mark || s.typed)) {
        continue;
      }
      if (notesFilter === 'starred' && !s.mark) {
        continue;
      }
      if (notesFilter === 'typed' && !s.typed) {
        continue;
      }
      if (q && !(s.text + ' ' + n.title + ' ' + n.course).toLowerCase().includes(q)) {
        continue;
      }
      out.push({ n: n, s: s });
    }
  }
  return out;
}

function renderNotes(): void {
  const pill = (v: string, label: string) =>
    `<button data-action='set-notes-filter' data-v='${v}' class='pill ${notesFilter === v ? 'pill-on' : ''}'>${label}</button>`;
  root.innerHTML = shell(
    `<div class='mx-auto max-w-xl px-5 pb-32 pt-safe-6'>
      <div class='flex items-start justify-between gap-3'>
        <div><h1 class='font-display text-3xl font-bold'>My notes</h1><p class='mt-1 text-sm text-muted'>Starred sections and typed notes from every lecture.</p></div>
        <button data-action='export-notes' class='iconbtn mt-1' aria-label='Download these notes'>${ic('download', 18)}</button>
      </div>
      ${searchBar('notes')}
      <div class='no-scrollbar mt-3 flex gap-2 overflow-x-auto'>${pill('all', 'All')}${pill('starred', 'Starred')}${pill('typed', 'Typed')}</div>
      <div id='notes-list' class='mt-4 space-y-3'></div>
    </div>`,
    true
  );
  renderNotesList();
}

function renderNotesList(): void {
  const el = document.getElementById('notes-list');
  if (!el) {
    return;
  }
  const items = noteItems();
  if (!items.length) {
    el.innerHTML = `<div class='card p-5 text-center'><h2 class='font-bold'>No notes here yet</h2><p class='mt-1 text-sm text-muted'>Press Mark while recording, star a section, or type a note inside a lecture. It will show up here.</p></div>`;
    return;
  }
  const q = notesSearch.trim();
  const groups = new Map<string, { n: Note; s: Segment }[]>();
  for (const it of items) {
    const k = it.n.course || '';
    const g = groups.get(k);
    if (g) {
      g.push(it);
    } else {
      groups.set(k, [it]);
    }
  }
  const keys = Array.from(groups.keys()).sort((a, b) => (!a ? 1 : !b ? -1 : a < b ? -1 : 1));
  el.innerHTML = keys
    .map(k => {
      const g = groups.get(k) as { n: Note; s: Segment }[];
      const cards = g
        .map(
          it => `<div class='card relative'>
      <button data-action='open-lecture' data-id='${it.n.id}' class='block w-full p-4 pr-14 text-left'>
        <p class='text-[16px] leading-relaxed'>${hl(it.s.text, q)}</p>
        <p class='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted'>
          <span>${esc(it.n.title)}</span><span>${fmtDate(it.n.createdAt)}</span><span class='tabular-nums'>${fmtTime(it.s.t)}</span>
          ${it.s.typed ? `<span class='rounded-full bg-lavsoft px-2 py-0.5 font-semibold text-lavink'>typed</span>` : ''}
        </p>
      </button>
      <button data-action='star-seg' data-id='${it.s.id}' data-nid='${it.n.id}' class='absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-full ${it.s.mark ? 'text-amber' : 'text-muted'}' aria-label='${it.s.mark ? 'Remove star' : 'Star this note'}'>${ic('star', 20, it.s.mark)}</button>
    </div>`
        )
        .join('');
      return `<div class='space-y-3'>
        <div class='flex items-center gap-3 px-1 pt-2'>${courseTile(k)}<div class='min-w-0 flex-1'><p class='truncate font-display text-lg font-bold leading-tight'>${esc(k || 'No course code')}</p><p class='text-xs text-muted'>${g.length} ${g.length === 1 ? 'note' : 'notes'}</p></div></div>
        ${cards}
      </div>`;
    })
    .join('');
}

function toggleRow(id: string, title: string, sub: string, on: boolean): string {
  return `<label class='flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5'>
      <span><span class='block font-semibold'>${title}</span><span class='block text-xs text-muted'>${sub}</span></span>
      <span class='relative inline-flex shrink-0'>
        <input id='${id}' type='checkbox' class='peer sr-only' ${on ? 'checked' : ''}>
        <span class='h-7 w-12 rounded-full bg-line transition peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:absolute after:left-0.5 after:top-0.5 after:h-6 after:w-6 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5'></span>
      </span>
    </label>`;
}

function renderProfile(): void {
  const row = (label: string, value: string) =>
    `<div class='flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0'><span class='text-sm font-semibold text-muted'>${label}</span><span class='text-right font-semibold'>${value ? esc(value) : '<span class=\'font-normal text-muted\'>Not set</span>'}</span></div>`;
  const themeBtn = (v: string, label: string) =>
    `<button data-action='set-theme' data-v='${v}' class='flex-1 rounded-xl px-3 py-2 text-sm font-semibold ${settings.theme === v ? 'bg-primary text-onprimary' : 'text-muted'}'>${label}</button>`;
  const link = (action: string, icon: string, label: string) =>
    `<button data-action='${action}' class='flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-left font-semibold last:border-b-0'><span class='flex h-9 w-9 items-center justify-center rounded-xl bg-lavsoft text-lavink'>${ic(icon, 18)}</span><span class='flex-1'>${label}</span><span class='text-muted'>${ic('chev', 18)}</span></button>`;
  root.innerHTML = shell(
    `<div class='mx-auto max-w-xl px-5 pb-32 pt-safe-6'>
      <h1 class='font-display text-3xl font-bold'>Profile</h1>
      <p class='mt-1 text-sm text-muted'>Manage your details and preferences. Your lectures are saved to your account and kept on this phone for offline use.</p>
      <section class='card mt-5 flex items-center gap-4 p-4'>
        ${avatar('h-16 w-16')}
        <div class='min-w-0 flex-1'>
          <p class='truncate font-display text-xl font-bold'>${profile.name ? esc(profile.name) : 'Add your name'}</p>
          <p class='truncate text-sm text-muted'>${esc(profile.university || 'Tell us where you study')}</p>
          ${profile.level ? `<p class='text-sm text-muted'>${esc(profile.level)}</p>` : ''}
        </div>
        <button data-action='edit-profile' class='btn-primary !px-4 !py-2.5 text-sm'>Edit</button>
      </section>
      <section class='card mt-4'>
        ${row('University', profile.university)}${row('Faculty', profile.faculty)}${row('Department', profile.department)}${row('Current level', profile.level)}
      </section>
      ${accountSection()}
      <h2 class='mt-7 font-display text-lg font-bold'>Preferences</h2>
      <section class='card mt-3 divide-y divide-line'>
        <div class='px-4 py-3.5'>
          <label for='set-lang' class='block font-semibold'>Transcription language</label>
          <span class='block text-xs text-muted'>Pick the accent closest to your lecturer. Applies next time you start recording.</span>
          <select id='set-lang' class='field mt-2'>${LANGS.map(l => `<option value='${l[0]}' ${l[0] === settings.lang ? 'selected' : ''}>${l[1]}</option>`).join('')}</select>
        </div>
        <div class='px-4 py-3.5'>
          <span class='block font-semibold'>Theme</span>
          <div class='mt-2 flex gap-1 rounded-2xl border border-line bg-bg p-1'>${themeBtn('system', 'System')}${themeBtn('light', 'Light')}${themeBtn('dark', 'Dark')}</div>
        </div>
        ${toggleRow('set-unsure', 'Flag sections to double-check', 'Marks sections the speech engine was not sure about.', settings.showUnsure)}
        ${toggleRow('set-wave', 'Show real volume and pitch', 'Off by default. It opens the microphone a second time, which can stop transcription on some phones.', settings.realWave)}
        <div id='local-row' class='px-4 py-3.5'>${localRowHtml()}</div>
      </section>
      <h2 class='mt-7 font-display text-lg font-bold'>Help and data</h2>
      <section class='card mt-3'>
        ${link('tips', 'mic', 'Tips for better pickup')}
        ${link('install-app', 'home', 'Add to home screen')}
        ${link('export-all', 'download', 'Download all lectures')}
        ${link('about', 'info', 'About LectureScribe')}
        ${link('wipe-all', 'trash', 'Delete all lectures')}
      </section>
    </div>`,
    true
  );
}

function renderLive(): void {
  const n = viewNote();
  if (!n) {
    go('');
    return;
  }
  const ctl = (label: string, btn: string) =>
    `<div class='flex flex-col items-center gap-1.5'>${btn}<span class='text-xs font-semibold text-muted'>${label}</span></div>`;
  root.innerHTML = `<div class='h-screen-safe mx-auto flex max-w-xl flex-col px-4 pb-3 pt-safe-4'>
      <div class='flex items-center justify-between'>
        <button data-action='nav' data-to='home' class='iconbtn' aria-label='Back to home'>${ic('back')}</button>
        <h1 class='font-display text-lg font-bold'>Live lecture</h1>
        <span id='live-status'></span>
      </div>
      <section class='card mt-3 px-4 py-3'>
        <div class='flex items-center justify-between gap-3'>
          <input id='course' value='${esc(n.course)}' maxlength='20' placeholder='Course code' aria-label='Course code' class='w-28 bg-transparent text-sm font-bold text-primary outline-none placeholder:text-muted/70'>
          <span id='live-timer' class='font-display text-xl font-bold tabular-nums'>${fmtTime(elapsedFor(n.id))}</span>
        </div>
        <input id='title' value='${esc(n.title)}' maxlength='80' aria-label='Lecture title' class='mt-0.5 w-full bg-transparent font-display text-xl font-bold outline-none'>
      </section>
      <section class='card mt-3 px-4 py-3'>
        <p id='wave-title' class='text-sm font-semibold'>Not listening</p>
        <canvas id='wave-canvas' class='mt-2 h-16 w-full' aria-hidden='true'></canvas>
        <div class='mt-1.5 flex items-center justify-between gap-2 text-xs text-muted'>
          <span id='wave-info' aria-live='polite'></span>
          <span id='wave-legend' class='items-center gap-1.5' style='display:none'>Low <i class='inline-block h-1.5 w-12 rounded-full' style='background:linear-gradient(90deg,#2DD4A3,#A78BFA)'></i> High</span>
        </div>
        <details class='mt-1 text-xs text-muted'><summary class='cursor-pointer font-semibold'>Mic check</summary><p id='dbg' class='mt-1 break-words'></p></details>
      </section>
      <section class='card mt-3 flex min-h-0 flex-1 flex-col'>
        <div class='flex items-center gap-2 px-4 pt-3 text-sm font-semibold'>Live transcription <span id='live-dot' class='h-2 w-2 rounded-full bg-teal'></span></div>
        <div id='live-scroll' class='min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2'>
          <p id='error-line' class='mb-2 hidden rounded-xl bg-coralsoft px-3 py-2 text-sm text-coral'></p>
          <div id='transcript' class='space-y-3'></div>
          <div id='interim' class='mt-3 hidden rounded-xl bg-primarysoft px-3.5 py-2.5 text-[17px] italic text-primary'></div>
        </div>
      </section>
      <div class='mt-3 grid grid-cols-4 items-end'>
        ${ctl('Section', `<button data-action='new-section' class='ctl-sm' aria-label='Start a new section'>${ic('layers', 22)}</button>`)}
        ${ctl('Pause', `<button id='rec-btn' data-action='toggle-record' class='ctl-big aurora-btn'></button>`).replace("<span class='text-xs font-semibold text-muted'>Pause</span>", "<span id='rec-label' class='text-xs font-semibold text-muted'>Pause</span>")}
        ${ctl('Stop', `<button data-action='stop-lecture' class='ctl-sm !border-transparent !bg-coral text-onprimary' aria-label='Stop and review notes'>${ic('stop', 22)}</button>`)}
        ${ctl('Mark', `<button data-action='mark' class='ctl-sm text-amber' aria-label='Star the current section'>${ic('star', 22)}</button>`)}
      </div>
      <p id='foot' class='mt-2 text-center text-xs text-muted'></p>
    </div>`;
  renderTranscript();
  updateStatus();
  updateInterim();
  startWaveLoop();
  refreshWaveInfo();
  if (recording && recId === n.id) {
    startMeter();
  }
}

function updateStatus(): void {
  const n = viewNote();
  const mini = document.getElementById('mini-rec');
  if (mini && !recording) {
    mini.remove();
  }
  const st = document.getElementById('live-status');
  if (st && n) {
    const active = recording && recId === n.id;
    if (active) {
      st.innerHTML = `<span class='inline-flex items-center gap-1.5 rounded-full bg-coralsoft px-3 py-1.5 text-sm font-bold text-coral'><span class='pulse-dot h-2 w-2 rounded-full bg-coral'></span>Recording</span>`;
    } else if (n.duration > 0 || n.segments.length) {
      st.innerHTML = `<span class='inline-flex items-center rounded-full bg-ambersoft px-3 py-1.5 text-sm font-bold text-amberink'>Paused</span>`;
    } else {
      st.innerHTML = `<span class='inline-flex items-center rounded-full bg-lavsoft px-3 py-1.5 text-sm font-bold text-lavink'>Ready</span>`;
    }
    const rb = document.getElementById('rec-btn');
    const rl = document.getElementById('rec-label');
    if (rb) {
      rb.innerHTML = ic(active ? 'pause' : 'play', 30);
      rb.setAttribute('aria-label', active ? 'Pause recording' : 'Start recording');
    }
    if (rl) {
      rl.textContent = active ? 'Pause' : n.duration > 0 || n.segments.length ? 'Resume' : 'Start';
    }
    const foot = document.getElementById('foot');
    if (foot) {
      foot.textContent = active
        ? navigator.onLine
          ? 'Your lecture is being transcribed automatically.'
          : localState === 'available'
            ? 'Offline: transcribing on your phone.'
            : 'Offline: live transcription resumes when you reconnect. Typed notes still save.'
        : 'Paused. Tap Resume to keep listening, or Stop to review your notes.';
    }
    const dot = document.getElementById('live-dot');
    if (dot) {
      dot.classList.toggle('pulse-dot', active);
      dot.classList.toggle('bg-teal', active);
      dot.classList.toggle('bg-muted', !active);
    }
    const err = document.getElementById('error-line');
    if (err) {
      err.textContent = lastError;
      err.classList.toggle('hidden', !lastError);
    }
    refreshWaveInfo();
  }
}

/* ---------- dialogs ---------- */

function openNewLecture(): void {
  const courses = Array.from(new Set(notes.map(n => n.course).filter(c => !!c))).sort();
  openModal(`
    <h2 class='font-display text-xl font-bold'>New lecture</h2>
    <form id='new-form' class='mt-3 space-y-3'>
      <div>
        <label for='new-title' class='mb-1 block text-sm font-semibold'>Lecture title</label>
        <input id='new-title' name='title' maxlength='80' placeholder='e.g. Introduction to Algorithms' class='field'>
      </div>
      <div>
        <label for='new-course' class='mb-1 block text-sm font-semibold'>Course code</label>
        <input id='new-course' name='course' list='course-options' maxlength='20' placeholder='e.g. CSC 201' class='field'>
        <datalist id='course-options'>${courses.map(c => `<option value='${esc(c)}'></option>`).join('')}</datalist>
      </div>
      <div class='flex gap-2 pt-1'>
        <button type='button' data-action='close-modal' class='btn-ghost flex-1'>Cancel</button>
        <button type='submit' class='btn-primary flex-1'>Start lecture</button>
      </div>
    </form>`);
}

function openLectureMenu(id: string): void {
  const n = notes.find(x => x.id === id);
  if (!n) {
    return;
  }
  openModal(`
    <h2 class='font-display text-xl font-bold'>${esc(n.title)}</h2>
    <div class='mt-4 space-y-2'>
      <button data-action='open-lecture' data-id='${n.id}' class='btn-ghost w-full'>Open lecture</button>
      <button data-action='download-id' data-id='${n.id}' class='btn-ghost w-full'>${ic('download', 18)} Download as text</button>
      <button data-action='delete-note' data-id='${n.id}' class='btn-ghost w-full !text-coral'>${ic('trash', 18)} Delete lecture</button>
      <button data-action='close-modal' class='w-full py-3 text-sm font-semibold text-muted'>Close</button>
    </div>`);
}

function openDeleteConfirm(id: string): void {
  openModal(`
    <h2 class='font-display text-xl font-bold'>Delete this lecture?</h2>
    <p class='mt-2 text-sm text-muted'>The notes and transcript will be removed from this phone. This cannot be undone.</p>
    <div class='mt-5 flex gap-2'>
      <button data-action='close-modal' class='btn-ghost flex-1'>Cancel</button>
      <button data-action='confirm-delete' data-id='${id}' class='btn-danger flex-1'>Delete</button>
    </div>`);
}

function openTips(): void {
  openModal(`
    <h2 class='font-display text-xl font-bold'>Tips for better pickup</h2>
    <div class='mt-3'>${TIPS}</div>
    <button data-action='close-modal' class='btn-primary mt-5 w-full'>Got it</button>`);
}

function openAbout(): void {
  openModal(`
    <h2 class='font-display text-xl font-bold'>About LectureScribe</h2>
    <p class='mt-2 text-sm text-muted'>LectureScribe turns what your lecturer says into notes while you listen, so you can follow along even when you cannot hear every word.</p>
    <ul class='mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted'>
      <li>Your lectures and profile are saved to your account and kept on this phone, so they work offline and sync when you are back online. Download lectures you want a copy of.</li>
      <li>Transcription uses your browser's speech engine. It works best in Chrome or Edge with an internet connection.</li>
      <li>Speech engines can mishear technical terms and spoken equations. Check sections marked <b>check</b>.</li>
    </ul>
    <button data-action='close-modal' class='btn-primary mt-5 w-full'>Close</button>`);
}

function openProfileEdit(): void {
  pendingPhoto = undefined;
  const field = (id: string, label: string, value: string, ph: string) =>
    `<div><label for='${id}' class='mb-1 block text-sm font-semibold'>${label}</label><input id='${id}' name='${id}' value='${esc(value)}' maxlength='60' placeholder='${ph}' class='field'></div>`;
  openModal(`
    <h2 class='font-display text-xl font-bold'>Edit profile</h2>
    <form id='profile-form' class='mt-3 space-y-3'>
      <div class='flex items-center gap-4'>
        <span id='photo-preview' class='flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-lavsoft text-lavink'>${profile.photo ? `<img src='${profile.photo}' alt='' class='h-full w-full object-cover'>` : ic('user', 26)}</span>
        <div class='flex flex-wrap gap-2'>
          <label class='btn-ghost cursor-pointer !px-3.5 !py-2 text-sm'>Choose photo<input id='photo-file' type='file' accept='image/*' class='sr-only'></label>
          <button type='button' data-action='photo-remove' class='btn-ghost !px-3.5 !py-2 text-sm'>Remove</button>
        </div>
      </div>
      ${field('p-name', 'Name', profile.name, 'Your name')}
      ${field('p-university', 'University', profile.university, 'e.g. University of Benin')}
      ${field('p-faculty', 'Faculty', profile.faculty, 'e.g. Science')}
      ${field('p-department', 'Department', profile.department, 'e.g. Chemistry')}
      <div><label for='p-level' class='mb-1 block text-sm font-semibold'>Current level</label>
        <select id='p-level' name='p-level' class='field'><option value=''>Not set</option>${LEVELS.map(l => `<option ${l === profile.level ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class='flex gap-2 pt-1'>
        <button type='button' data-action='close-modal' class='btn-ghost flex-1'>Cancel</button>
        <button type='submit' class='btn-primary flex-1'>Save profile</button>
      </div>
    </form>`);
}

function readPhoto(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 192;
      const cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      const ctx = cv.getContext('2d');
      if (!ctx) {
        return;
      }
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      pendingPhoto = cv.toDataURL('image/jpeg', 0.82);
      const prev = document.getElementById('photo-preview');
      if (prev) {
        prev.innerHTML = `<img src='${pendingPhoto}' alt='' class='h-full w-full object-cover'>`;
      }
    };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(file);
}

/* ---------- accounts ---------- */

const EMPTY_PROFILE: Profile = {
  name: '',
  university: '',
  faculty: '',
  department: '',
  level: '',
  photo: '',
};

function wipeLocalData(): void {
  /* Used when someone signs out: their lectures live in their account, and the
     next person to use this phone must not see them. Nothing here touches the
     account itself. */
  notes = [];
  recId = null;
  profile = Object.assign({}, EMPTY_PROFILE);
  try {
    localStorage.removeItem(NOTES_KEY);
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* ignore */
  }
  cloud.clearLocalSyncState();
}

function syncText(): string {
  if (!cloudOn) {
    return 'Account sync is unavailable.';
  }
  return syncLabel || 'Checking your account...';
}

function accountSection(): string {
  if (!account) {
    return '';
  }
  return `<h2 class='mt-7 font-display text-lg font-bold'>Account</h2>
      <section class='card mt-3'>
        <div class='flex items-center justify-between gap-4 border-b border-line px-4 py-3'><span class='text-sm font-semibold text-muted'>Signed in as</span><span class='min-w-0 truncate text-right font-semibold'>${esc(account.email)}</span></div>
        <div class='border-b border-line px-4 py-3'><span id='sync-row' class='text-sm text-muted'>${esc(syncText())}</span></div>
        <button data-action='sign-out' class='flex w-full items-center gap-3 px-4 py-3.5 text-left font-semibold'><span class='flex h-9 w-9 items-center justify-center rounded-xl bg-lavsoft text-lavink'>${ic('user', 18)}</span><span class='flex-1'>Sign out</span><span class='text-muted'>${ic('chev', 18)}</span></button>
      </section>`;
}

function authCopy(): { title: string; sub: string } {
  if (authMode === 'reset') {
    return {
      title: 'Reset your password',
      sub: 'Enter your email and we will send you a link to choose a new one.',
    };
  }
  if (authMode === 'signup') {
    return {
      title: 'Create your account',
      sub: 'Your lectures are saved to your account, so you never lose them and can open them on any phone.',
    };
  }
  return { title: 'Welcome back', sub: 'Sign in to open your lectures and notes.' };
}

function authFormHtml(): string {
  const signup = authMode === 'signup';
  const reset = authMode === 'reset';
  let n = 0;
  const item = (html: string) => `<div class='auth-item' style='--i:${n++}'>${html}</div>`;
  const label = (id: string, text: string) =>
    `<label for='${id}' class='mb-1.5 block text-sm font-semibold'>${text}</label>`;
  const parts: string[] = [];
  if (signup) {
    parts.push(
      item(
        `${label('a-name', 'Name')}<div class='relative'><span class='auth-ico'>${ic('user', 18)}</span><input id='a-name' name='a-name' autocomplete='name' maxlength='60' placeholder='Your name' class='field !pl-11'></div>`
      )
    );
  }
  parts.push(
    item(
      `${label('a-email', 'Email')}<div class='relative'><span class='auth-ico'>${ic('mail', 18)}</span><input id='a-email' name='a-email' type='email' inputmode='email' autocomplete='email' autocapitalize='none' placeholder='you@example.com' class='field !pl-11'></div>`
    )
  );
  if (!reset) {
    parts.push(
      item(
        `${label('a-pass', 'Password')}<div class='relative'><span class='auth-ico'>${ic('lock', 18)}</span><input id='a-pass' name='a-pass' type='password' autocomplete='${signup ? 'new-password' : 'current-password'}' placeholder='${signup ? 'At least 6 characters' : 'Your password'}' class='field !pl-11 !pr-12'><button type='button' data-action='auth-pw-toggle' aria-label='Show password' class='absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-muted'>${ic('eye', 18)}</button></div>${signup ? `<div class='auth-meter'><i id='auth-meter-bar'></i></div><p id='auth-meter-text' class='mt-1.5 text-xs text-muted'>Use 6 or more characters. A mix of letters and numbers is stronger.</p>` : ''}`
      )
    );
  }
  parts.push(
    item(
      `<p id='auth-err' role='alert' class='hidden rounded-xl bg-coralsoft px-3.5 py-2.5 text-sm font-semibold text-coral'></p><p id='auth-ok' role='status' class='hidden rounded-xl bg-primarysoft px-3.5 py-2.5 text-sm font-semibold text-primary'></p>`
    )
  );
  parts.push(
    item(
      `<button id='auth-submit' type='submit' class='btn-primary auth-btn w-full'><span class='auth-btn-label'>${reset ? 'Send reset link' : signup ? 'Create account' : 'Sign in'}</span><span class='auth-spin' aria-hidden='true'></span></button>`
    )
  );
  const link = reset
    ? `<button type='button' data-action='auth-mode' data-v='signin' class='w-full py-2 text-center text-sm font-semibold text-muted'>Back to sign in</button>`
    : signup
      ? `<p class='text-center text-xs text-muted'>Your lectures are private to your account.</p>`
      : `<button type='button' data-action='auth-mode' data-v='reset' class='w-full py-2 text-center text-sm font-semibold text-muted'>Forgot your password?</button>`;
  parts.push(item(link));
  return `<form id='auth-form' class='space-y-4' novalidate>${parts.join('')}</form>`;
}

function renderAuth(): void {
  const c = authCopy();
  const tab = (mode: string, text: string) =>
    `<button type='button' data-action='auth-mode' data-v='${mode}' class='relative z-10 flex-1 py-2.5 text-sm font-semibold'>${text}</button>`;
  root.innerHTML = `<div id='auth-frame' class='flex min-h-screen flex-col'>
    <div class='aurora relative overflow-hidden px-6 pb-20 pt-safe-6 text-white'>
      <span class='auth-blob b1'></span><span class='auth-blob b2'></span><span class='auth-blob b3'></span>
      <div class='relative mx-auto max-w-md'>
        <div class='auth-rise flex items-center gap-3' style='--i:0'>
          <img src='./icon-192.png' alt='' width='48' height='48' class='h-12 w-12 rounded-2xl bg-white object-cover shadow-lg'>
          <p class='font-display text-xl font-bold'>LectureScribe</p>
        </div>
        <h1 id='auth-title' class='auth-rise mt-8 font-display text-[1.75rem] font-bold leading-tight' style='--i:1'>${c.title}</h1>
        <p id='auth-sub' class='auth-rise mt-2 text-[15px] leading-relaxed text-white/75' style='--i:2'>${c.sub}</p>
      </div>
    </div>
    <div class='auth-sheet relative -mt-10 flex-1 rounded-t-[2rem] bg-bg px-6 pb-10 pt-6'>
      <div class='mx-auto max-w-md'>
        <div id='auth-tabs-wrap' class='fold ${authMode === 'reset' ? 'closed' : ''}'>
          <div class='fold-in'>
            <div id='auth-tabs' data-mode='${authMode === 'signup' ? 'signup' : 'signin'}' class='auth-tabs relative flex rounded-2xl border border-line bg-surface p-1'>
              <span class='auth-ind'></span>${tab('signin', 'Sign in')}${tab('signup', 'Create account')}
            </div>
          </div>
        </div>
        <div id='auth-card' class='mt-5'>${authFormHtml()}</div>
      </div>
    </div>
  </div>`;
}

function updateAuthMode(): void {
  if (!document.getElementById('auth-frame')) {
    renderAuth();
    return;
  }
  const prev = document.getElementById('a-email') as HTMLInputElement | null;
  const email = prev ? prev.value : '';
  const tabs = document.getElementById('auth-tabs');
  if (tabs) {
    tabs.dataset.mode = authMode === 'signup' ? 'signup' : 'signin';
  }
  const wrap = document.getElementById('auth-tabs-wrap');
  if (wrap) {
    wrap.classList.toggle('closed', authMode === 'reset');
  }
  const c = authCopy();
  for (const [id, text] of [
    ['auth-title', c.title],
    ['auth-sub', c.sub],
  ]) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
      el.classList.remove('auth-swap');
      void el.offsetWidth;
      el.classList.add('auth-swap');
    }
  }
  const card = document.getElementById('auth-card');
  if (card) {
    card.innerHTML = authFormHtml();
    const e = document.getElementById('a-email') as HTMLInputElement | null;
    if (e && email) {
      e.value = email;
    }
  }
}

function updateMeter(pw: string): void {
  const bar = document.getElementById('auth-meter-bar') as HTMLElement | null;
  const txt = document.getElementById('auth-meter-text');
  if (!bar || !txt) {
    return;
  }
  let score = 0;
  if (pw.length >= 6) {
    score++;
  }
  if (pw.length >= 10) {
    score++;
  }
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw)) {
    score++;
  }
  if (/[^A-Za-z0-9]/.test(pw)) {
    score++;
  }
  const levels = [
    ['4%', 'rgb(var(--c-coral))', 'Use 6 or more characters. A mix of letters and numbers is stronger.'],
    ['30%', 'rgb(var(--c-coral))', 'Weak. Add more characters.'],
    ['58%', 'rgb(var(--c-amber))', 'Okay. Add numbers or capital letters.'],
    ['82%', 'rgb(var(--c-teal))', 'Good password.'],
    ['100%', 'rgb(var(--c-teal))', 'Strong password.'],
  ];
  const lv = pw.length === 0 ? levels[0] : levels[Math.max(1, score)];
  bar.style.width = lv[0];
  bar.style.background = lv[1];
  txt.textContent = lv[2];
}

async function submitAuth(): Promise<void> {
  if (authBusy) {
    return;
  }
  const val = (id: string) =>
    ((document.getElementById(id) as HTMLInputElement | null) || { value: '' }).value;
  const email = val('a-email').trim();
  const pass = val('a-pass');
  const name = val('a-name').trim();
  const err = document.getElementById('auth-err');
  const ok = document.getElementById('auth-ok');
  const btn = document.getElementById('auth-submit') as HTMLButtonElement | null;
  const form = document.getElementById('auth-form');
  const say = (el: HTMLElement | null, msg: string) => {
    if (el) {
      el.textContent = msg;
      el.classList.toggle('hidden', !msg);
      if (msg) {
        el.classList.remove('auth-swap');
        void el.offsetWidth;
        el.classList.add('auth-swap');
      }
    }
  };
  const fail = (msg: string) => {
    say(err, msg);
    if (form) {
      form.classList.remove('shake');
      void (form as HTMLElement).offsetWidth;
      form.classList.add('shake');
    }
  };
  say(err, '');
  say(ok, '');
  if (!email) {
    fail('Enter your email address.');
    return;
  }
  if (authMode !== 'reset' && !pass) {
    fail('Enter your password.');
    return;
  }
  if (authMode === 'signup' && pass.length < 6) {
    fail('Choose a password with at least 6 characters.');
    return;
  }
  authBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    if (authMode === 'reset') {
      await cloud.resetPassword(email);
      say(ok, 'If an account exists for that email, a reset link is on its way. Check your inbox and spam.');
    } else if (authMode === 'signup') {
      pendingName = name;
      await cloud.signUp(email, pass);
    } else {
      await cloud.signIn(email, pass);
    }
  } catch (e) {
    pendingName = '';
    fail(cloud.friendlyAuthError(e));
  } finally {
    authBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

function openSignOut(): void {
  const n = cloud.unsyncedCount();
  openModal(`
    <h2 class='font-display text-xl font-bold'>Sign out?</h2>
    <p class='mt-2 text-sm text-muted'>Your lectures stay safe in your account. They are removed from this phone and come back when you sign in again.</p>
    ${n > 0 ? `<p class='mt-3 rounded-xl bg-ambersoft p-3 text-sm text-amberink'>Some changes have not uploaded yet. Stay online for a moment first, or they will be lost.</p>` : ''}
    <div class='mt-5 flex gap-2'>
      <button data-action='close-modal' class='btn-ghost flex-1'>Cancel</button>
      <button data-action='confirm-sign-out' class='btn-danger flex-1'>Sign out</button>
    </div>`);
}

async function doSignOut(force: boolean): Promise<void> {
  if (recording) {
    stopRecording();
  }
  if (!force) {
    toast('Saving your lectures...');
    const saved = await cloud.flushPending(6000);
    if (!saved) {
      openModal(`
        <h2 class='font-display text-xl font-bold'>Not fully uploaded</h2>
        <p class='mt-2 text-sm text-muted'>Some lectures have not reached your account yet, probably because there is no internet. If you sign out now they will be lost. Connect to the internet and try again to keep them.</p>
        <div class='mt-5 flex gap-2'>
          <button data-action='close-modal' class='btn-primary flex-1'>Stay signed in</button>
          <button data-action='force-sign-out' class='btn-danger flex-1'>Sign out anyway</button>
        </div>`);
      return;
    }
  }
  try {
    await cloud.signOutUser();
  } catch {
    toast('Could not sign out. Try again.');
    return;
  }
  wipeLocalData();
  closeModal();
  authMode = 'signin';
  if (location.hash) {
    location.hash = '';
  }
  if (authState === 'in') {
    authState = 'out';
    account = null;
    render();
  }
}

function afterRemoteNotes(): void {
  if (document.getElementById('modal-root')) {
    return;
  }
  const ae = document.activeElement as HTMLElement | null;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
    return;
  }
  if (route.view === 'detail' || route.view === 'live') {
    if (!notes.some(n => n.id === route.id)) {
      go('lectures');
    } else if (route.view === 'detail') {
      renderDetailBody();
    }
    return;
  }
  if (route.view === 'lectures') {
    renderLectureList();
  } else if (route.view === 'notes') {
    renderNotesList();
  } else {
    render();
  }
}

function initAccounts(): void {
  try {
    cloud.initCloud({
      onUser(user) {
        if (user) {
          const owner = cloud.syncOwner();
          if (owner && owner !== user.uid) {
            wipeLocalData();
          }
          account = user;
          if (pendingName && !profile.name) {
            profile.name = pendingName;
            saveProfile(false);
          }
          pendingName = '';
          authState = 'in';
        } else {
          account = null;
          authState = 'out';
        }
        render();
      },
      onRemoteNotes(upsert, removeIds) {
        for (const r of upsert) {
          const i = notes.findIndex(n => n.id === r.id);
          if (i >= 0) {
            notes[i] = r as Note;
          } else {
            notes.push(r as Note);
          }
        }
        if (removeIds.length) {
          notes = notes.filter(n => removeIds.indexOf(n.id) < 0);
        }
        saveNotes();
        afterRemoteNotes();
      },
      onRemoteProfile(p) {
        profile = Object.assign({}, EMPTY_PROFILE, p);
        saveProfile(false);
        if (route.view === 'profile' && !document.getElementById('modal-root')) {
          renderProfile();
        }
      },
      getNotes: () => notes,
      getProfile: () => profile,
      isBusy: (id?: string) => recording && (!id || id === recId),
      onStatus(st, pending) {
        if (st === 'synced') {
          syncLabel = 'All lectures are saved to your account.';
        } else if (st === 'syncing') {
          syncLabel = 'Saving to your account...';
        } else if (st === 'offline') {
          syncLabel = 'Offline. ' + pending + ' waiting to upload.';
        } else if (st === 'error') {
          syncLabel = 'Could not sync right now. It will try again.';
        } else {
          syncLabel = '';
        }
        const row = document.getElementById('sync-row');
        if (row) {
          row.textContent = syncText();
        }
      },
    });
    cloudOn = true;
    window.setTimeout(() => {
      if (authState === 'loading') {
        authState = 'out';
        render();
      }
    }, 10000);
  } catch {
    /* Firebase could not start: keep the app working on this phone only. */
    cloudOn = false;
    authState = 'in';
    render();
  }
}

/* ---------- events ---------- */

function refreshView(): void {
  if (route.view === 'notes') {
    renderNotesList();
  } else if (route.view === 'detail') {
    renderDetailBody();
  } else {
    renderTranscript();
  }
}

function handleAction(action: string, el: HTMLElement): void {
  const id = el.dataset.id || '';
  const v = el.dataset.v || '';
  const n = viewNote();
  switch (action) {
    case 'nav':
      go(el.dataset.to === 'home' ? '' : el.dataset.to || '');
      break;
    case 'record-nav':
      if (recording && recId) {
        go('live/' + recId);
      } else {
        openNewLecture();
      }
      break;
    case 'open-live':
      if (recId) {
        go('live/' + recId);
      }
      break;
    case 'new-lecture':
      openNewLecture();
      break;
    case 'open-lecture':
      closeModal();
      go('lecture/' + id);
      break;
    case 'lecture-menu':
      openLectureMenu(id);
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'resume-lecture':
      go('live/' + id);
      startRecording(id);
      break;
    case 'resume-last': {
      const last = [...notes].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (last) {
        go('live/' + last.id);
        startRecording(last.id);
      } else {
        toast('No lectures yet. Tap Start recording to begin.');
      }
      break;
    }
    case 'toggle-record':
      if (recording && recId === route.id) {
        stopRecording();
      } else {
        startRecording(route.id);
      }
      break;
    case 'stop-lecture': {
      const nid = route.id;
      stopRecording();
      go('lecture/' + nid);
      break;
    }
    case 'new-section':
      if (n) {
        startSection();
        toast('New section started');
      }
      break;
    case 'mark':
      if (n && n.segments.length) {
        n.segments[n.segments.length - 1].mark = true;
        n.updatedAt = Date.now();
        saveNotes();
        renderTranscript();
        toast('Current section starred');
      } else {
        toast('Nothing to mark yet');
      }
      break;
    case 'star-seg': {
      const target = el.dataset.nid ? notes.find(x => x.id === el.dataset.nid) : n;
      const seg = target ? target.segments.find(s => s.id === id) : undefined;
      if (target && seg) {
        seg.mark = !seg.mark;
        target.updatedAt = Date.now();
        saveNotes();
        editingSegment = false;
        refreshView();
      }
      break;
    }
    case 'del-seg':
      if (n) {
        n.segments = n.segments.filter(s => s.id !== id);
        n.updatedAt = Date.now();
        saveNotes();
        editingSegment = false;
        refreshView();
        toast('Section deleted');
      }
      break;
    case 'copy':
      if (n) {
        const text = plainText(n, false);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => toast('Notes copied'),
            () => toast('Could not copy. Use Download instead.')
          );
        } else {
          toast('Could not copy. Use Download instead.');
        }
      }
      break;
    case 'download':
      if (n) {
        downloadText(slug(n.title) + '.txt', plainText(n, true));
      }
      break;
    case 'download-id': {
      const dn = notes.find(x => x.id === id);
      if (dn) {
        downloadText(slug(dn.title) + '.txt', plainText(dn, true));
      }
      closeModal();
      break;
    }
    case 'delete-note':
      openDeleteConfirm(id || (n ? n.id : ''));
      break;
    case 'confirm-delete':
      if (recording && recId === id) {
        stopRecording();
      }
      if (cloudOn) {
        cloud.markDeleted([id]);
      }
      notes = notes.filter(x => x.id !== id);
      saveNotes();
      closeModal();
      toast('Lecture deleted');
      go('lectures');
      break;
    case 'set-time':
      timeFilter = v as typeof timeFilter;
      renderLectures();
      break;
    case 'set-tab':
      detailTab = v as typeof detailTab;
      renderDetail();
      break;
    case 'set-notes-filter':
      notesFilter = v as typeof notesFilter;
      renderNotes();
      break;
    case 'set-theme':
      settings.theme = v as Settings['theme'];
      saveSettings();
      applyTheme();
      renderProfile();
      break;
    case 'tips':
      openTips();
      break;
    case 'install-local':
      installLocal();
      break;
    case 'install-app':
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt = null;
      } else {
        openModal(`
          <h2 class='font-display text-xl font-bold'>Add to home screen</h2>
          <ul class='mt-3 list-disc space-y-2 pl-5 text-sm text-muted'>
            <li><b>Android (Chrome):</b> tap the three-dot menu, then <b>Add to Home screen</b> or <b>Install app</b>.</li>
            <li><b>iPhone (Safari):</b> tap the Share button, then <b>Add to Home Screen</b>.</li>
            <li>Open the app once with internet first. After that it opens even without a connection.</li>
          </ul>
          <button data-action='close-modal' class='btn-primary mt-5 w-full'>Got it</button>`);
      }
      break;
    case 'about':
      openAbout();
      break;
    case 'edit-profile':
      openProfileEdit();
      break;
    case 'photo-remove': {
      pendingPhoto = '';
      const prev = document.getElementById('photo-preview');
      if (prev) {
        prev.innerHTML = ic('user', 26);
      }
      break;
    }
    case 'export-all':
      if (notes.length) {
        downloadText(
          'lecturescribe-all-lectures.txt',
          notes.map(x => plainText(x, true)).join(NL + NL + '----------' + NL + NL)
        );
      } else {
        toast('No lectures to download yet.');
      }
      break;
    case 'export-notes': {
      const items = noteItems();
      if (!items.length) {
        toast('No notes to download yet.');
        break;
      }
      downloadText(
        'lecturescribe-my-notes.txt',
        items
          .map(it => (it.n.course ? it.n.course + ' - ' : '') + it.n.title + ' [' + fmtTime(it.s.t) + ']' + NL + it.s.text)
          .join(NL + NL)
      );
      break;
    }
    case 'wipe-all':
      openModal(`
        <h2 class='font-display text-xl font-bold'>Delete all lectures?</h2>
        <p class='mt-2 text-sm text-muted'>Every lecture and note will be removed from this phone and from your account, on all your devices. Your profile and settings stay. This cannot be undone.</p>
        <div class='mt-5 flex gap-2'>
          <button data-action='close-modal' class='btn-ghost flex-1'>Cancel</button>
          <button data-action='confirm-wipe' class='btn-danger flex-1'>Delete all</button>
        </div>`);
      break;
    case 'auth-mode': {
      const next = v === 'signup' ? 'signup' : v === 'reset' ? 'reset' : 'signin';
      if (next !== authMode) {
        authMode = next;
        updateAuthMode();
      }
      break;
    }
    case 'auth-pw-toggle': {
      const pw = document.getElementById('a-pass') as HTMLInputElement | null;
      if (pw) {
        pw.type = pw.type === 'password' ? 'text' : 'password';
        el.innerHTML = ic(pw.type === 'password' ? 'eye' : 'eyeoff', 18);
        el.setAttribute('aria-label', pw.type === 'password' ? 'Show password' : 'Hide password');
      }
      break;
    }
    case 'toggle-course': {
      const sec = el.closest('section');
      if (sec) {
        const closed = !sec.classList.contains('is-closed');
        sec.classList.toggle('is-closed', closed);
        el.setAttribute('aria-expanded', closed ? 'false' : 'true');
        if (closed) {
          collapsedCourses.add(v);
        } else {
          collapsedCourses.delete(v);
        }
      }
      break;
    }
    case 'search-pick': {
      const sc = (el.dataset.scope === 'notes' ? 'notes' : 'lectures') as SearchScope;
      setQ(sc, v);
      const inp = document.getElementById(SEARCH_CFG[sc].input) as HTMLInputElement | null;
      if (inp) {
        inp.value = v;
        inp.blur();
      }
      addRecent(v);
      syncClear(sc);
      runSearch(sc);
      hideHelper(sc);
      break;
    }
    case 'search-open': {
      const sc = (el.dataset.scope === 'notes' ? 'notes' : 'lectures') as SearchScope;
      addRecent(getQ(sc));
      hideHelper(sc);
      go('lecture/' + id);
      break;
    }
    case 'search-clear': {
      const sc = (el.dataset.scope === 'notes' ? 'notes' : 'lectures') as SearchScope;
      setQ(sc, '');
      const inp = document.getElementById(SEARCH_CFG[sc].input) as HTMLInputElement | null;
      if (inp) {
        inp.value = '';
        inp.focus();
      }
      syncClear(sc);
      runSearch(sc);
      showHelper(sc);
      break;
    }
    case 'recent-clear': {
      const sc = (el.dataset.scope === 'notes' ? 'notes' : 'lectures') as SearchScope;
      recentSearches = [];
      saveRecent();
      showHelper(sc);
      break;
    }
    case 'sign-out':
      openSignOut();
      break;
    case 'confirm-sign-out':
      void doSignOut(false);
      break;
    case 'force-sign-out':
      void doSignOut(true);
      break;
    case 'confirm-wipe':
      if (recording) {
        stopRecording();
      }
      if (cloudOn) {
        cloud.markDeleted(notes.map(x => x.id));
      }
      notes = [];
      recId = null;
      saveNotes();
      closeModal();
      toast('All lectures deleted');
      renderProfile();
      break;
    default:
      break;
  }
}

document.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (el && el.dataset.action) {
    handleAction(el.dataset.action, el);
  }
});

document.addEventListener('submit', e => {
  const form = e.target as HTMLFormElement;
  e.preventDefault();
  if (form.id === 'auth-form') {
    void submitAuth();
  } else if (form.id === 'new-form') {
    const data = new FormData(form);
    const title =
      String(data.get('title') || '').trim() || 'Lecture on ' + fmtDate(Date.now());
    const course = String(data.get('course') || '').trim().toUpperCase();
    const note: Note = {
      id: uid(),
      title: title,
      course: course,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 0,
      segments: [],
    };
    notes.push(note);
    saveNotes();
    closeModal();
    go('live/' + note.id);
    startRecording(note.id);
  } else if (form.id === 'typed-form') {
    const input = document.getElementById('typed') as HTMLInputElement;
    const text = input.value.trim();
    if (!text) {
      toast('Type something first');
      return;
    }
    addTyped(route.id, text);
    input.value = '';
    input.focus();
  } else if (form.id === 'profile-form') {
    const val = (id: string) => ((document.getElementById(id) as HTMLInputElement | null) || { value: '' }).value.trim();
    profile = {
      name: val('p-name'),
      university: val('p-university'),
      faculty: val('p-faculty'),
      department: val('p-department'),
      level: val('p-level'),
      photo: pendingPhoto !== undefined ? pendingPhoto : profile.photo,
    };
    saveProfile();
    closeModal();
    toast('Profile saved');
    renderProfile();
  }
});

document.addEventListener('input', e => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'search' || t.id === 'notes-search') {
    const sc: SearchScope = t.id === 'search' ? 'lectures' : 'notes';
    setQ(sc, t.value);
    syncClear(sc);
    runSearch(sc);
    showHelper(sc);
  } else if (t.id === 'a-pass' && authMode === 'signup') {
    updateMeter(t.value);
  } else if (t.id === 'title' || t.id === 'course') {
    const n = viewNote();
    if (n) {
      if (t.id === 'title') {
        n.title = t.value;
      } else {
        n.course = t.value.trim().toUpperCase();
      }
      n.updatedAt = Date.now();
      scheduleSave();
    }
  }
});

document.addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'course-filter') {
    courseFilter = t.value;
    renderLectureList();
  } else if (t.id === 'set-lang') {
    settings.lang = t.value;
    saveSettings();
    refreshLocalState();
  } else if (t.id === 'set-unsure') {
    settings.showUnsure = t.checked;
    saveSettings();
  } else if (t.id === 'set-wave') {
    settings.realWave = t.checked;
    saveSettings();
  } else if (t.id === 'photo-file' && t.files && t.files[0]) {
    readPhoto(t.files[0]);
  }
});

document.addEventListener('focusin', e => {
  const t = e.target as HTMLElement;
  if (t.classList && t.classList.contains('seg-text')) {
    editingSegment = true;
  }
  if (t.id === 'search' || t.id === 'notes-search') {
    showHelper(t.id === 'search' ? 'lectures' : 'notes');
  }
});

document.addEventListener('focusout', e => {
  const t = e.target as HTMLElement;
  if (t.id === 'search' || t.id === 'notes-search') {
    const sc: SearchScope = t.id === 'search' ? 'lectures' : 'notes';
    window.setTimeout(() => hideHelper(sc), 220);
  }
});

document.addEventListener('keydown', e => {
  const t = e.target as HTMLInputElement;
  if (t.id !== 'search' && t.id !== 'notes-search') {
    return;
  }
  const sc: SearchScope = t.id === 'search' ? 'lectures' : 'notes';
  if (e.key === 'Enter') {
    e.preventDefault();
    addRecent(t.value);
    hideHelper(sc);
    t.blur();
  } else if (e.key === 'Escape') {
    hideHelper(sc);
    t.blur();
  }
});

document.addEventListener('focusout', e => {
  const t = e.target as HTMLElement;
  if (!t.classList || !t.classList.contains('seg-text')) {
    return;
  }
  editingSegment = false;
  const n = viewNote();
  const id = t.dataset.seg;
  if (n && id) {
    const seg = n.segments.find(s => s.id === id);
    if (seg) {
      const text = (t.textContent || '').trim();
      if (!text) {
        n.segments = n.segments.filter(s => s.id !== id);
      } else if (text !== seg.text) {
        seg.text = text;
        seg.conf = 1;
      }
      n.updatedAt = Date.now();
      saveNotes();
    }
  }
  window.setTimeout(() => {
    if (!editingSegment) {
      refreshView();
    }
  }, 250);
});

document.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.key === 'Escape') {
    closeModal();
  }
  if (e.key === 'Enter' && t.classList && t.classList.contains('seg-text')) {
    e.preventDefault();
    t.blur();
  }
});

document.addEventListener('paste', e => {
  const t = e.target as HTMLElement;
  if (t.classList && t.classList.contains('seg-text')) {
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    document.execCommand('insertText', false, text);
  }
});

document.addEventListener('pointerover', e => {
  if ((e as PointerEvent).pointerType !== 'mouse') {
    return;
  }
  const el = (e.target as HTMLElement).closest('[data-tip-title]') as HTMLElement | null;
  if (el) {
    showTip(el);
  }
});

document.addEventListener('pointerout', e => {
  if ((e as PointerEvent).pointerType !== 'mouse') {
    return;
  }
  if ((e.target as HTMLElement).closest('[data-tip-title]')) {
    hideTip();
  }
});

document.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest('[data-tip-title]') as HTMLElement | null;
  if (!el) {
    hideTip();
    return;
  }
  showTip(el);
  if ((e as PointerEvent).pointerType !== 'mouse') {
    window.clearTimeout(tipTimer);
    tipTimer = window.setTimeout(hideTip, 2600);
  }
});

document.addEventListener('focusin', e => {
  const el = (e.target as HTMLElement).closest ? ((e.target as HTMLElement).closest('[data-tip-title]') as HTMLElement | null) : null;
  if (el) {
    showTip(el);
  }
});

document.addEventListener('focusout', e => {
  const t = e.target as HTMLElement;
  if (t.closest && t.closest('[data-tip-title]')) {
    hideTip();
  }
});

window.addEventListener('scroll', hideTip, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && recording) {
    acquireWakeLock();
  }
  if (document.visibilityState === 'hidden') {
    syncDuration();
    saveNotes();
    if (cloudOn) {
      cloud.pushNow();
    }
  }
});

window.addEventListener('hashchange', render);
window.addEventListener('online', () => {
  localSticky = false;
  refreshLocalState();
  restartEngine();
  updateStatus();
});
window.addEventListener('offline', () => {
  restartEngine();
  updateStatus();
});
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
});

/* Lets the app open with no internet: a small service worker keeps a copy of
   the files, and we ask it to save everything this page already loaded. */
function registerOffline(): void {
  if (!('serviceWorker' in navigator) || IS_NATIVE) {
    return;
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(reg => {
        const urls = performance
          .getEntriesByType('resource')
          .map(e => e.name)
          .filter(u => /^https?:/.test(u));
        urls.push(location.href.split('#')[0]);
        if (reg.active) {
          reg.active.postMessage({ type: 'cache', urls: urls });
        }
      })
      .catch(() => undefined);
  });
}
window.addEventListener('pagehide', () => {
  syncDuration();
  saveNotes();
  if (cloudOn) {
    cloud.pushNow();
  }
});
window.setInterval(() => {
  syncDuration();
  saveNotes();
}, 15000);

try {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (settings.theme === 'system') {
        applyTheme();
      }
    });
} catch {
  /* older browsers */
}

applyTheme();
tidyOldNotes();
render();
initAccounts();
refreshLocalState();
registerOffline();
