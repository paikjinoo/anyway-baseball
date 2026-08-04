'use client';

/**
 * 경기 효과음과 관중음은 Web Audio API로 합성한다.
 * 메뉴 BGM만 public/audio/bgm/menu.mp3 파일을 사용한다.
 */

export interface AudioConfig {
  sfxEnabled: boolean;
  crowdEnabled: boolean;
  bgmEnabled: boolean;
  sfxVolume: number;
  crowdVolume: number;
  bgmVolume: number;
}

const MENU_BGM_SRC = '/audio/bgm/menu.mp3';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let crowdBus: GainNode | null = null;
let crowdSource: { stop: () => void } | null = null;
let crowdWanted = false;
let menuBgm: HTMLAudioElement | null = null;
let menuBgmWanted = false;
let menuBgmUnavailable = false;
let umpireSpeaking = false;
const umpireTimers = new Set<ReturnType<typeof setTimeout>>();

let config: AudioConfig = {
  sfxEnabled: true,
  crowdEnabled: true,
  bgmEnabled: true,
  sfxVolume: 0.7,
  crowdVolume: 0.45,
  bgmVolume: 0.3,
};

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function syncBusGains() {
  if (!ctx) return;
  const t = ctx.currentTime;
  sfxBus?.gain.setTargetAtTime(config.sfxEnabled ? config.sfxVolume : 0, t, 0.015);
  crowdBus?.gain.setTargetAtTime(config.crowdEnabled ? config.crowdVolume : 0, t, 0.04);
}

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    sfxBus = ctx.createGain();
    crowdBus = ctx.createGain();
    sfxBus.connect(master);
    crowdBus.connect(master);
    master.connect(ctx.destination);
    syncBusGains();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function configureAudio(opts: AudioConfig) {
  config = {
    ...opts,
    sfxVolume: clampVolume(opts.sfxVolume),
    crowdVolume: clampVolume(opts.crowdVolume),
    bgmVolume: clampVolume(opts.bgmVolume),
  };
  syncBusGains();

  if (!config.sfxEnabled) {
    for (const timer of umpireTimers) clearTimeout(timer);
    umpireTimers.clear();
    if (umpireSpeaking && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      umpireSpeaking = false;
    }
  }

  if (!config.crowdEnabled) stopCrowdPlayback();
  else if (crowdWanted) ensureCrowd();

  if (menuBgm) menuBgm.volume = config.bgmVolume;
  if (!config.bgmEnabled) menuBgm?.pause();
  else if (menuBgmWanted) ensureMenuBgm();
}

/** 사용자 제스처 이후에 호출해 오디오 컨텍스트와 메뉴 BGM을 활성화한다. */
export function unlockAudio() {
  ac();
  if (menuBgmWanted) ensureMenuBgm();
}

function bus(channel: 'sfx' | 'crowd'): GainNode | null {
  return channel === 'sfx' ? sfxBus : crowdBus;
}

function env(
  node: AudioNode,
  gain: number,
  attack: number,
  decay: number,
  when: number,
  channel: 'sfx' | 'crowd' = 'sfx',
): GainNode | null {
  const c = ac();
  const target = bus(channel);
  if (!c || !target) return null;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  node.connect(g);
  g.connect(target);
  return g;
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// ---------------------------------------------------------------------------
// 경기 효과음
// ---------------------------------------------------------------------------

/** 투수가 공을 놓는 순간의 손가락 스냅과 공기 가르는 소리. */
export function playPitchRelease(delaySeconds = 0) {
  if (!config.sfxEnabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime + Math.max(0, delaySeconds);

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.18);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(360, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.1);
  bp.Q.value = 1.7;
  src.connect(bp);
  env(bp, 0.25, 0.003, 0.13, t);
  src.start(t);
  src.stop(t + 0.2);

  const snap = c.createOscillator();
  snap.type = 'triangle';
  snap.frequency.setValueAtTime(190, t);
  snap.frequency.exponentialRampToValueAtTime(75, t + 0.06);
  env(snap, 0.16, 0.002, 0.07, t);
  snap.start(t);
  snap.stop(t + 0.09);
}

/** 배트에 맞는 소리. power 0~1로 강도를 조절한다. */
export function playBatCrack(power = 0.6, delaySeconds = 0) {
  if (!config.sfxEnabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime + Math.max(0, delaySeconds);

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.12);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400 - power * 500;
  bp.Q.value = 1.2;
  src.connect(bp);
  env(bp, 0.55 * (0.6 + power * 0.7), 0.002, 0.09, t);
  src.start(t);
  src.stop(t + 0.14);

  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220 - power * 90, t);
  osc.frequency.exponentialRampToValueAtTime(70, t + 0.1);
  env(osc, 0.35 * (0.5 + power), 0.003, 0.13, t);
  osc.start(t);
  osc.stop(t + 0.16);
}

/** 번트/빗맞은 타구의 짧고 둔한 접촉음. */
export function playWeakContact(delaySeconds = 0) {
  if (!config.sfxEnabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime + Math.max(0, delaySeconds);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.08);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  src.connect(lp);
  env(lp, 0.3, 0.002, 0.06, t);
  src.start(t);
  src.stop(t + 0.1);
}

/** 포수 미트에 공이 들어가는 소리. */
export function playMitt(velocity = 140, delaySeconds = 0) {
  if (!config.sfxEnabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime + Math.max(0, delaySeconds);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.09);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 600 + (velocity - 120) * 8;
  bp.Q.value = 0.9;
  src.connect(bp);
  env(bp, 0.4, 0.001, 0.07, t);
  src.start(t);
  src.stop(t + 0.11);
}

/** 헛스윙 때의 바람 가르는 소리. */
export function playWhiff(delaySeconds = 0) {
  if (!config.sfxEnabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime + Math.max(0, delaySeconds);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.22);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.14);
  bp.Q.value = 3;
  src.connect(bp);
  env(bp, 0.22, 0.03, 0.13, t);
  src.start(t);
  src.stop(t + 0.24);
}

/** UI 클릭. */
export function playClick() {
  if (!config.sfxEnabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(440, t + 0.05);
  env(osc, 0.08, 0.002, 0.05, t);
  osc.start(t);
  osc.stop(t + 0.07);
}

export type UmpireCall = 'strike' | 'ball' | 'foul';

function playCallTone(kind: UmpireCall) {
  if (!config.sfxEnabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const freqs = kind === 'strike' ? [520, 760] : kind === 'foul' ? [680, 520] : [420];
  freqs.forEach((f, i) => {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    env(osc, 0.08, 0.012, 0.13, t + i * 0.08);
    osc.start(t + i * 0.08);
    osc.stop(t + i * 0.08 + 0.17);
  });
}

/** 브라우저 음성으로 심판의 Ball / Strike / Foul 선언을 재생한다. */
export function playUmpireCall(kind: UmpireCall, delaySeconds = 0) {
  if (!config.sfxEnabled || typeof window === 'undefined') return;
  if (delaySeconds > 0) {
    const timer = setTimeout(() => {
      umpireTimers.delete(timer);
      playUmpireCall(kind);
    }, delaySeconds * 1000);
    umpireTimers.add(timer);
    return;
  }

  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
    playCallTone(kind);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(
    kind === 'strike' ? 'Strike!' : kind === 'foul' ? 'Foul ball!' : 'Ball!',
  );
  utterance.lang = 'en-US';
  utterance.volume = config.sfxVolume;
  utterance.rate = kind === 'strike' ? 0.78 : 0.88;
  utterance.pitch = 0.62;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice =
    voices.find((v) => v.lang.startsWith('en-US') && /Daniel|Alex|Fred|Aaron/i.test(v.name)) ??
    voices.find((v) => v.lang.startsWith('en-US')) ??
    null;
  utterance.onstart = () => {
    umpireSpeaking = true;
  };
  utterance.onend = utterance.onerror = () => {
    umpireSpeaking = false;
  };
  window.speechSynthesis.speak(utterance);
}

/** 이전 코드에서 사용하던 이름을 위한 호환 별칭. */
export const playCall = playUmpireCall;

// ---------------------------------------------------------------------------
// 관중석
// ---------------------------------------------------------------------------

/** 관중 함성. intensity 0~1. */
export function playCheer(intensity = 0.7, duration = 2.2, delaySeconds = 0) {
  if (!config.crowdEnabled) return;
  const c = ac();
  if (!c || !crowdBus) return;
  const target = crowdBus;
  const t = c.currentTime + Math.max(0, delaySeconds);

  // 서로 다른 대역의 관중 군집을 겹쳐 단순한 백색소음처럼 들리지 않게 한다.
  [430, 780, 1350].forEach((frequency, i) => {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, duration);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = frequency + intensity * 180;
    bp.Q.value = 0.55 + i * 0.18;
    const g = c.createGain();
    const peak = intensity * [0.2, 0.16, 0.1][i];
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.18 + i * 0.04);
    g.gain.setValueAtTime(peak * 0.88, t + duration * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(bp);
    bp.connect(g);
    g.connect(target);
    src.start(t);
    src.stop(t + duration);
  });
}

/** 안타 때의 짧은 관중 환호. */
export function playHitCheer(extraBases = 0, delaySeconds = 0) {
  const strength = Math.min(0.9, 0.62 + extraBases * 0.11);
  playCheer(strength, 1.7 + extraBases * 0.35, delaySeconds);
}

/** 홈런 때의 큰 함성과 구장 축하 팡파르. */
export function playHomeRunCelebration(delaySeconds = 0) {
  if (!config.crowdEnabled) return;
  playCheer(1, 4.2, delaySeconds);
  const c = ac();
  if (!c) return;
  const t = c.currentTime + Math.max(0, delaySeconds) + 0.22;
  [392, 523.25, 659.25, 783.99].forEach((frequency, i) => {
    const osc = c.createOscillator();
    osc.type = 'square';
    osc.frequency.value = frequency;
    env(osc, 0.045, 0.025, 0.34, t + i * 0.13, 'crowd');
    osc.start(t + i * 0.13);
    osc.stop(t + i * 0.13 + 0.4);
  });
}

function ensureCrowd() {
  if (!crowdWanted || !config.crowdEnabled || crowdSource) return;
  const c = ac();
  if (!c || !crowdBus) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 6);
  src.loop = true;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 620;
  const g = c.createGain();
  g.gain.value = 0.1;
  const lfo = c.createOscillator();
  const lfoDepth = c.createGain();
  lfo.frequency.value = 0.17;
  lfoDepth.gain.value = 0.018;
  lfo.connect(lfoDepth);
  lfoDepth.connect(g.gain);
  src.connect(lp);
  lp.connect(g);
  g.connect(crowdBus);
  src.start();
  lfo.start();
  crowdSource = {
    stop: () => {
      try {
        src.stop();
        lfo.stop();
      } catch {
        /* 이미 정지된 노드는 무시한다. */
      }
    },
  };
}

/** 경기 내내 흐르는 낮은 관중 응원과 웅성거림. */
export function startCrowd() {
  crowdWanted = true;
  stopMenuBgm();
  ensureCrowd();
}

function stopCrowdPlayback() {
  crowdSource?.stop();
  crowdSource = null;
}

export function stopCrowd() {
  crowdWanted = false;
  stopCrowdPlayback();
}

// ---------------------------------------------------------------------------
// 메뉴 배경음
// ---------------------------------------------------------------------------

function ensureMenuBgm() {
  if (
    typeof window === 'undefined' ||
    !menuBgmWanted ||
    !config.bgmEnabled ||
    menuBgmUnavailable
  ) {
    return;
  }
  if (!menuBgm) {
    menuBgm = new Audio(MENU_BGM_SRC);
    menuBgm.loop = true;
    menuBgm.preload = 'auto';
    menuBgm.addEventListener('error', () => {
      menuBgmUnavailable = true;
      menuBgm?.pause();
    });
  }
  menuBgm.volume = config.bgmVolume;
  void menuBgm.play().catch(() => {
    // 자동 재생이 막힌 경우 unlockAudio()가 첫 사용자 입력 때 다시 시도한다.
  });
}

/** 메인/팀/선수/설정 화면에서 메뉴 BGM 재생을 요청한다. */
export function startMenuBgm() {
  menuBgmWanted = true;
  ensureMenuBgm();
}

/** 경기 진입 때 메뉴 BGM을 멈춘다. */
export function stopMenuBgm() {
  menuBgmWanted = false;
  menuBgm?.pause();
}
