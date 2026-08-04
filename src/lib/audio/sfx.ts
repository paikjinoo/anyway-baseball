'use client';

/**
 * Web Audio API로 사운드를 그때그때 합성한다.
 * 외부 오디오 파일이 없으므로 다운로드 용량이 0이고 로딩도 없다.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let crowdSource: { stop: () => void } | null = null;

let enabled = true;
let sfxVolume = 0.7;
let bgmVolume = 0.3;

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function configureAudio(opts: { enabled: boolean; sfxVolume: number; bgmVolume: number }) {
  enabled = opts.enabled;
  sfxVolume = opts.sfxVolume;
  bgmVolume = opts.bgmVolume;
  if (!enabled) stopCrowd();
}

/** 사용자 제스처 이후에 호출해 오디오 컨텍스트를 활성화한다 */
export function unlockAudio() {
  ac();
}

function env(
  node: AudioNode,
  gain: number,
  attack: number,
  decay: number,
  when: number,
): GainNode | null {
  const c = ac();
  if (!c || !master) return null;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  node.connect(g);
  g.connect(master);
  return g;
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// ---------------------------------------------------------------------------
// 개별 효과음
// ---------------------------------------------------------------------------

/** 배트에 맞는 소리. power 0~1 로 강도 조절 (홈런일수록 크고 낮다) */
export function playBatCrack(power = 0.6) {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;

  // 나무 타격의 임팩트: 짧은 노이즈 버스트 + 밴드패스
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.12);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400 - power * 500;
  bp.Q.value = 1.2;
  src.connect(bp);
  env(bp, 0.55 * sfxVolume * (0.6 + power * 0.7), 0.002, 0.09, t);
  src.start(t);
  src.stop(t + 0.14);

  // 저역 "쿵"
  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220 - power * 90, t);
  osc.frequency.exponentialRampToValueAtTime(70, t + 0.1);
  env(osc, 0.35 * sfxVolume * (0.5 + power), 0.003, 0.13, t);
  osc.start(t);
  osc.stop(t + 0.16);
}

/** 번트/빗맞은 타구 */
export function playWeakContact() {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.08);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  src.connect(lp);
  env(lp, 0.3 * sfxVolume, 0.002, 0.06, t);
  src.start(t);
  src.stop(t + 0.1);
}

/** 포수 미트 소리 */
export function playMitt(velocity = 140) {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.09);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 600 + (velocity - 120) * 8;
  bp.Q.value = 0.9;
  src.connect(bp);
  env(bp, 0.4 * sfxVolume, 0.001, 0.07, t);
  src.start(t);
  src.stop(t + 0.11);
}

/** 헛스윙 (바람 가르는 소리) */
export function playWhiff() {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.22);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.14);
  bp.Q.value = 3;
  src.connect(bp);
  env(bp, 0.22 * sfxVolume, 0.03, 0.13, t);
  src.start(t);
  src.stop(t + 0.24);
}

/** UI 클릭 */
export function playClick() {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(440, t + 0.05);
  env(osc, 0.08 * sfxVolume, 0.002, 0.05, t);
  osc.start(t);
  osc.stop(t + 0.07);
}

/** 심판 콜 느낌의 삐 소리 (스트라이크/아웃) */
export function playCall(kind: 'strike' | 'ball' | 'out') {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const freqs = kind === 'strike' ? [660, 880] : kind === 'out' ? [520, 392] : [440];
  freqs.forEach((f, i) => {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    env(osc, 0.12 * sfxVolume, 0.01, 0.12, t + i * 0.09);
    osc.start(t + i * 0.09);
    osc.stop(t + i * 0.09 + 0.16);
  });
}

/** 관중 함성. intensity 0~1 */
export function playCheer(intensity = 0.7, duration = 2.2) {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, duration);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 700 + intensity * 500;
  bp.Q.value = 0.6;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35 * sfxVolume * intensity, t + 0.25);
  g.gain.setValueAtTime(0.35 * sfxVolume * intensity, t + duration * 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(bp);
  bp.connect(g);
  if (master) g.connect(master);
  src.start(t);
  src.stop(t + duration);
}

/** 경기 내내 흐르는 낮은 관중 웅성거림 */
export function startCrowd() {
  if (!enabled || bgmVolume <= 0) return;
  const c = ac();
  if (!c || !master || crowdSource) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 4);
  src.loop = true;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 520;
  const g = c.createGain();
  g.gain.value = 0.07 * bgmVolume;
  src.connect(lp);
  lp.connect(g);
  g.connect(master);
  src.start();
  crowdSource = {
    stop: () => {
      try {
        src.stop();
      } catch {
        /* noop */
      }
    },
  };
}

export function stopCrowd() {
  crowdSource?.stop();
  crowdSource = null;
}
