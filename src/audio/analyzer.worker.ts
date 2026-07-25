/// <reference lib="webworker" />
import { FFT, hannWindow } from './fft';
import type { AnalyzerRequest, AnalyzerResponse, AnalysisResult, BandTrack } from './types';

const FFT_SIZE = 1024;
const HOP = 256;

const MIN_BPM = 70;
const MAX_BPM = 190;
/** Tempi near here are preferred when several are equally plausible. */
const BPM_PRIOR_CENTER = 124;
const BPM_PRIOR_WIDTH = 0.9;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: AnalyzerResponse, transfer?: Transferable[]) {
  ctx.postMessage(msg, transfer ?? []);
}

ctx.onmessage = (e: MessageEvent<AnalyzerRequest>) => {
  try {
    const result = analyze(e.data.samples, e.data.sampleRate);
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function analyze(samples: Float32Array, sampleRate: number): AnalysisResult {
  const frameRate = sampleRate / HOP;
  const frameCount = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP));

  post({ type: 'progress', value: 0.05, stage: 'Reading spectrum' });

  const { onset, bands } = spectralPass(samples, sampleRate, frameCount);

  post({ type: 'progress', value: 0.6, stage: 'Finding tempo' });

  const localScore = normalizeOnset(onset, frameRate);
  const { bpm, periodFrames, strength } = estimateTempo(localScore, frameRate);

  post({ type: 'progress', value: 0.78, stage: 'Locking to the grid' });

  const beatFrames = trackBeats(localScore, periodFrames);
  const beats = new Float32Array(beatFrames.length);
  for (let i = 0; i < beatFrames.length; i++) beats[i] = beatFrames[i] / frameRate;

  post({ type: 'progress', value: 0.9, stage: 'Reading the arrangement' });

  const beatEnergy = perBeatEnergy(bands.level, beatFrames);
  const downbeats = findDownbeats(bands.bass, localScore, beatFrames, frameRate);

  return {
    duration: samples.length / sampleRate,
    bpm,
    beats,
    downbeats,
    beatEnergy,
    onset: localScore,
    frameRate,
    bands,
    // Under this correlation the "beat" is mostly noise (ambient, spoken word,
    // rubato) — the stage sways freely instead of pretending to be locked.
    weak: strength < 0.12 || beats.length < 8,
  };
}

/** One STFT pass producing the onset envelope and the four band tracks. */
function spectralPass(samples: Float32Array, sampleRate: number, frameCount: number) {
  const fft = new FFT(FFT_SIZE);
  const window = hannWindow(FFT_SIZE);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const bins = FFT_SIZE / 2;
  const prev = new Float32Array(bins);
  const mag = new Float32Array(bins);

  const onset = new Float32Array(frameCount);
  const bands: BandTrack = {
    bass: new Float32Array(frameCount),
    lowMid: new Float32Array(frameCount),
    mid: new Float32Array(frameCount),
    high: new Float32Array(frameCount),
    level: new Float32Array(frameCount),
  };

  const hzPerBin = sampleRate / FFT_SIZE;
  const edge = (hz: number) => Math.min(bins, Math.max(1, Math.round(hz / hzPerBin)));
  const b0 = edge(20), b1 = edge(160), b2 = edge(800), b3 = edge(3500);

  let nextReport = 0;

  for (let f = 0; f < frameCount; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i] * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);

    let flux = 0;
    let sBass = 0, sLowMid = 0, sMid = 0, sHigh = 0, sAll = 0;

    for (let k = 1; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      // Log compression keeps quiet passages from being ignored entirely.
      const c = Math.log1p(m * 40);
      mag[k] = c;
      const d = c - prev[k];
      if (d > 0) flux += d;

      if (k >= b0 && k < b1) sBass += m;
      else if (k < b2) sLowMid += m;
      else if (k < b3) sMid += m;
      else sHigh += m;
      sAll += m;
    }
    prev.set(mag);

    onset[f] = flux;
    bands.bass[f] = sBass;
    bands.lowMid[f] = sLowMid;
    bands.mid[f] = sMid;
    bands.high[f] = sHigh;
    bands.level[f] = sAll;

    if (f >= nextReport) {
      post({ type: 'progress', value: 0.05 + 0.55 * (f / frameCount), stage: 'Reading spectrum' });
      nextReport = f + Math.ceil(frameCount / 20);
    }
  }

  smooth(bands.bass, 3);
  smooth(bands.lowMid, 3);
  smooth(bands.mid, 3);
  smooth(bands.high, 3);
  smooth(bands.level, 5);

  normalizeToUnit(bands.bass);
  normalizeToUnit(bands.lowMid);
  normalizeToUnit(bands.mid);
  normalizeToUnit(bands.high);
  normalizeToUnit(bands.level);

  return { onset, bands };
}

/** Subtract a local mean and rectify so loud and quiet sections weigh alike. */
function normalizeOnset(onset: Float32Array, frameRate: number): Float32Array {
  const n = onset.length;
  const out = new Float32Array(n);
  const win = Math.max(3, Math.round(frameRate * 0.4));
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + onset[i];

  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win);
    const b = Math.min(n, i + win + 1);
    const mean = (cum[b] - cum[a]) / (b - a);
    out[i] = Math.max(0, onset[i] - mean);
  }

  let max = 0;
  for (let i = 0; i < n; i++) if (out[i] > max) max = out[i];
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

/**
 * Autocorrelation of the onset envelope, comb-filtered across the first four
 * harmonics so a strong off-beat does not pull the estimate to double tempo.
 */
function estimateTempo(odf: Float32Array, frameRate: number) {
  const n = odf.length;
  const minLag = Math.floor((60 / MAX_BPM) * frameRate);
  const maxLag = Math.ceil((60 / MIN_BPM) * frameRate);

  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i];
  mean /= n || 1;

  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) sum += (odf[i] - mean) * (odf[i + lag] - mean);
    ac[lag] = limit > 0 ? sum / limit : 0;
  }

  let best = minLag;
  let bestScore = -Infinity;
  let acPeak = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > acPeak) acPeak = ac[lag];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let h = 1; h <= 4; h++) {
      const l = Math.round(lag * h);
      if (l <= maxLag) score += ac[l] / h;
    }
    const bpm = (60 * frameRate) / lag;
    // Log-normal prior: nudges toward danceable tempi without forcing them.
    const dev = Math.log2(bpm / BPM_PRIOR_CENTER) / BPM_PRIOR_WIDTH;
    score *= Math.exp(-0.5 * dev * dev);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }

  // Parabolic interpolation for sub-frame tempo precision.
  let period = best;
  if (best > minLag && best < maxLag) {
    const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) period = best + (0.5 * (y0 - y2)) / denom;
  }

  const variance = acPeak > 0 ? ac[best] / acPeak : 0;
  return {
    bpm: (60 * frameRate) / period,
    periodFrames: period,
    strength: Math.max(0, variance),
  };
}

/**
 * Ellis-style dynamic-programming beat tracker: pick the beat sequence that
 * jointly maximises onset strength and regularity, allowing gentle drift.
 */
function trackBeats(odf: Float32Array, period: number): number[] {
  const n = odf.length;
  if (n === 0 || period < 2) return [];

  const tightness = 100;
  const alpha = 0.85;

  const lo = Math.max(1, Math.round(period * 0.5));
  const hi = Math.max(lo + 1, Math.round(period * 2));
  const span = hi - lo + 1;

  // Penalty for landing at each candidate spacing, precomputed once.
  const txwt = new Float32Array(span);
  for (let i = 0; i < span; i++) {
    const gap = lo + i;
    const l = Math.log(gap / period);
    txwt[i] = -tightness * l * l;
  }

  const cumscore = new Float32Array(n);
  const backlink = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    let bestScore = -Infinity;
    let bestIdx = -1;
    for (let j = 0; j < span; j++) {
      const prevIdx = i - (lo + j);
      if (prevIdx < 0) continue;
      const s = txwt[j] + cumscore[prevIdx];
      if (s > bestScore) {
        bestScore = s;
        bestIdx = prevIdx;
      }
    }
    if (bestIdx < 0) {
      cumscore[i] = odf[i];
    } else {
      cumscore[i] = alpha * bestScore + odf[i];
      backlink[i] = bestIdx;
    }
  }

  // Start the backtrace from a strong beat near the end, not the very last
  // frame, so a fade-out does not anchor the whole chain.
  let tail = n - 1;
  let tailScore = -Infinity;
  const from = Math.max(0, n - Math.round(period * 2));
  for (let i = from; i < n; i++) {
    if (cumscore[i] > tailScore) {
      tailScore = cumscore[i];
      tail = i;
    }
  }

  const rev: number[] = [];
  for (let i = tail; i >= 0; i = backlink[i]) {
    rev.push(i);
    if (backlink[i] < 0) break;
  }
  rev.reverse();

  // Extend the grid backwards to the start of the file so the very first bars
  // are animated too.
  while (rev.length > 1 && rev[0] - period > 0) rev.unshift(Math.round(rev[0] - period));
  return rev;
}

function perBeatEnergy(level: Float32Array, beatFrames: number[]): Float32Array {
  const out = new Float32Array(beatFrames.length);
  for (let i = 0; i < beatFrames.length; i++) {
    const a = beatFrames[i];
    const b = i + 1 < beatFrames.length ? beatFrames[i + 1] : Math.min(level.length, a + 1);
    let sum = 0;
    let count = 0;
    for (let f = a; f < b && f < level.length; f++) {
      sum += level[f];
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  // Rescale against this track's own dynamic range so quiet mixes still get
  // full choreography variation.
  let lo = Infinity, hi = -Infinity;
  for (const v of out) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo;
  if (range > 1e-6) for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / range;
  return out;
}

/** Choose which of every four beats carries the kick — that is the downbeat. */
function findDownbeats(
  bass: Float32Array,
  odf: Float32Array,
  beatFrames: number[],
  frameRate: number,
): Float32Array {
  const meter = 4;
  const scores = new Float64Array(meter);
  for (let i = 0; i < beatFrames.length; i++) {
    const f = beatFrames[i];
    if (f < 0 || f >= bass.length) continue;
    scores[i % meter] += bass[f] * 1.5 + (odf[f] ?? 0);
  }
  let phase = 0;
  for (let p = 1; p < meter; p++) if (scores[p] > scores[phase]) phase = p;

  const out: number[] = [];
  for (let i = phase; i < beatFrames.length; i += meter) out.push(beatFrames[i] / frameRate);
  return Float32Array.from(out);
}

function smooth(arr: Float32Array, radius: number) {
  const n = arr.length;
  const copy = Float32Array.from(arr);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sum += copy[j];
      count++;
    }
    arr[i] = sum / count;
  }
}

/** Scale to 0..1 against a high percentile so one transient cannot flatten it. */
function normalizeToUnit(arr: Float32Array) {
  if (arr.length === 0) return;
  const sorted = Float32Array.from(arr).sort();
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] || 1;
  for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, arr[i] / ref);
}
