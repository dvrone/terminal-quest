/**
 * audio.js — Sound effects generated with the Web Audio API.
 *
 * No audio files are needed: every sound is a short sequence of oscillator
 * notes with a soft envelope. The AudioContext is created lazily on the first
 * sound so it starts after a user gesture (browser autoplay policy).
 */
(function (global) {
  'use strict';
  const TQ = (global.TQ = global.TQ || {});

  // Each sound is a list of notes: frequency (Hz), start offset (s),
  // duration (s), oscillator type and peak volume.
  const SOUNDS = {
    success: [
      { f: 660, t: 0, d: 0.07, type: 'sine', v: 0.05 },
      { f: 880, t: 0.07, d: 0.1, type: 'sine', v: 0.045 },
    ],
    error: [
      { f: 196, t: 0, d: 0.14, type: 'sawtooth', v: 0.035 },
      { f: 147, t: 0.12, d: 0.2, type: 'sawtooth', v: 0.035 },
    ],
    mission: [
      { f: 523.25, t: 0, d: 0.12, type: 'triangle', v: 0.07 },
      { f: 659.25, t: 0.11, d: 0.12, type: 'triangle', v: 0.07 },
      { f: 783.99, t: 0.22, d: 0.12, type: 'triangle', v: 0.07 },
      { f: 1046.5, t: 0.33, d: 0.3, type: 'triangle', v: 0.07 },
    ],
    levelUp: [
      { f: 523.25, t: 0, d: 0.1, type: 'triangle', v: 0.07 },
      { f: 659.25, t: 0.09, d: 0.1, type: 'triangle', v: 0.07 },
      { f: 783.99, t: 0.18, d: 0.1, type: 'triangle', v: 0.07 },
      { f: 1046.5, t: 0.27, d: 0.1, type: 'triangle', v: 0.07 },
      { f: 1318.5, t: 0.36, d: 0.1, type: 'triangle', v: 0.07 },
      { f: 1568.0, t: 0.45, d: 0.45, type: 'triangle', v: 0.07 },
      { f: 784.0, t: 0.45, d: 0.45, type: 'sine', v: 0.04 },
    ],
  };

  class SoundEngine {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }

    setEnabled(value) { this.enabled = Boolean(value); }
    isEnabled() { return this.enabled; }

    /** Create (or resume) the AudioContext. Returns null when unsupported. */
    _context() {
      if (!this.ctx) {
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        if (!AudioCtx) return null;
        try { this.ctx = new AudioCtx(); } catch (err) { return null; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    /** Play one of: success | error | mission | levelUp. */
    play(name) {
      if (!this.enabled) return;
      const notes = SOUNDS[name];
      if (!notes) return;
      const ctx = this._context();
      if (!ctx) return;
      const now = ctx.currentTime + 0.01;
      notes.forEach((note) => this._tone(ctx, now + note.t, note));
    }

    _tone(ctx, start, note) {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = note.type;
        osc.frequency.setValueAtTime(note.f, start);
        // Quick attack and exponential release avoid clicks.
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(note.v, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.d);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + note.d + 0.03);
      } catch (err) {
        /* Audio is non-essential; ignore failures. */
      }
    }
  }

  TQ.Sound = new SoundEngine();
})(typeof window !== 'undefined' ? window : globalThis);
