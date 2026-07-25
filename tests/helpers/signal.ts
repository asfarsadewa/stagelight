/**
 * Deterministic test signal generation.
 *
 * Every test in this suite must produce the same numbers on every machine and
 * every run, so there is no `Math.random` anywhere — noise comes from a seeded
 * generator and all synthetic audio is built from closed-form maths.
 */

/** mulberry32: small, fast, and identical everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClickTrackOptions {
  bpm: number;
  seconds: number;
  sampleRate?: number;
  /** Add a quieter hat between beats, as most real music does. */
  offbeats?: boolean;
  /** Emphasise every fourth beat, giving the tracker a downbeat to find. */
  accentEveryFour?: boolean;
  seed?: number;
}

/**
 * A synthetic drum loop: a decaying low sine for the kick and a burst of
 * seeded noise for the hat. Crude, but it exercises exactly what the onset
 * detector looks for — sharp broadband energy increases at regular spacing.
 */
export function clickTrack({
  bpm,
  seconds,
  sampleRate = 22050,
  offbeats = true,
  accentEveryFour = true,
  seed = 1,
}: ClickTrackOptions): Float32Array {
  const length = Math.floor(seconds * sampleRate);
  const out = new Float32Array(length);
  const random = seededRandom(seed);
  const beatPeriod = 60 / bpm;

  const kick = (start: number, gain: number) => {
    const dur = Math.floor(0.12 * sampleRate);
    for (let i = 0; i < dur; i++) {
      const at = start + i;
      if (at >= length) break;
      const t = i / sampleRate;
      const env = Math.exp(-t * 34);
      // Pitch drop, as a real kick has.
      out[at] += Math.sin(2 * Math.PI * (110 - 60 * Math.min(1, t * 18)) * t) * env * gain;
    }
  };

  const hat = (start: number, gain: number) => {
    const dur = Math.floor(0.045 * sampleRate);
    for (let i = 0; i < dur; i++) {
      const at = start + i;
      if (at >= length) break;
      const env = Math.exp((-i / sampleRate) * 150);
      out[at] += (random() * 2 - 1) * env * gain;
    }
  };

  let beat = 0;
  for (let t = 0; t < seconds; t += beatPeriod, beat++) {
    const start = Math.floor(t * sampleRate);
    kick(start, accentEveryFour && beat % 4 === 0 ? 1.0 : 0.72);
    hat(start, 0.16);
    if (offbeats) hat(Math.floor((t + beatPeriod / 2) * sampleRate), 0.1);
  }

  return out;
}

/** Steady-state noise: no rhythmic structure for the tracker to lock onto. */
export function shapedNoise(seconds: number, sampleRate = 22050, seed = 7): Float32Array {
  const random = seededRandom(seed);
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  let smoothed = 0;
  for (let i = 0; i < out.length; i++) {
    // One-pole low pass, so it has spectral shape but no transients.
    smoothed += ((random() * 2 - 1) - smoothed) * 0.02;
    out[i] = smoothed * 0.6;
  }
  return out;
}

export function silence(seconds: number, sampleRate = 22050): Float32Array {
  return new Float32Array(Math.floor(seconds * sampleRate));
}

/** Naive O(n^2) DFT — the reference the fast transform is checked against. */
export function referenceDft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      sumRe += re[t] * c - im[t] * s;
      sumIm += re[t] * s + im[t] * c;
    }
    outRe[k] = sumRe;
    outIm[k] = sumIm;
  }
  return { re: outRe, im: outIm };
}
