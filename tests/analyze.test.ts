import { describe, expect, it } from 'vitest';
import { analyze, estimateTempo, normalizeOnset, trackBeats } from '../src/audio/analyze';
import { clickTrack, seededRandom, shapedNoise, silence } from './helpers/signal';

const RATE = 22050;

describe('analyze — tempo detection', () => {
  // Each case is a synthetic drum loop at a known tempo. The assertion is on
  // the true tempo, not on an octave of it: reporting 240 for a 120 BPM track
  // would halve every pose duration on stage, so it is a real failure.
  for (const bpm of [96, 110, 124, 140, 168]) {
    it(`locks to ${bpm} BPM`, () => {
      const result = analyze(clickTrack({ bpm, seconds: 24 }), RATE);
      expect(result.weak).toBe(false);
      expect(result.bpm).toBeGreaterThan(bpm - 2);
      expect(result.bpm).toBeLessThan(bpm + 2);
    });
  }

  it('places beats on the actual pulse, not merely at the right spacing', () => {
    const bpm = 128;
    const result = analyze(clickTrack({ bpm, seconds: 24 }), RATE);
    const period = 60 / bpm;

    // Every detected beat should sit near a true beat. Phase error is measured
    // as the distance to the nearest multiple of the period, wrapped.
    let worst = 0;
    for (const beat of result.beats) {
      const phase = beat / period;
      const error = Math.abs(phase - Math.round(phase)) * period;
      worst = Math.max(worst, error);
    }
    expect(worst).toBeLessThan(0.04);
  });

  it('produces a monotonic grid with consistent spacing', () => {
    const result = analyze(clickTrack({ bpm: 132, seconds: 20 }), RATE);
    const gaps: number[] = [];
    for (let i = 1; i < result.beats.length; i++) {
      expect(result.beats[i]).toBeGreaterThan(result.beats[i - 1]);
      gaps.push(result.beats[i] - result.beats[i - 1]);
    }
    const spread = Math.max(...gaps) - Math.min(...gaps);
    expect(spread).toBeLessThan(0.05);
  });

  it('covers the track from near the start to near the end', () => {
    const seconds = 20;
    const result = analyze(clickTrack({ bpm: 120, seconds }), RATE);
    expect(result.beats[0]).toBeLessThan(0.6);
    expect(result.beats[result.beats.length - 1]).toBeGreaterThan(seconds - 1.5);
  });

  it('finds one downbeat per bar of four', () => {
    const result = analyze(clickTrack({ bpm: 120, seconds: 24, accentEveryFour: true }), RATE);
    // Allow the boundary beat either way — the grid need not start on beat one.
    const expected = result.beats.length / 4;
    expect(result.downbeats.length).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
    expect(result.downbeats.length).toBeLessThanOrEqual(Math.ceil(expected) + 1);
  });
});

describe('analyze — refusing to guess', () => {
  it('flags silence as weak', () => {
    expect(analyze(silence(12), RATE).weak).toBe(true);
  });

  it('flags structureless noise as weak', () => {
    expect(analyze(shapedNoise(16), RATE).weak).toBe(true);
  });

  it('survives input shorter than one analysis window', () => {
    const result = analyze(new Float32Array(200), RATE);
    expect(result.weak).toBe(true);
    expect(Number.isFinite(result.bpm)).toBe(true);
  });
});

describe('analyze — output shape', () => {
  const result = analyze(clickTrack({ bpm: 120, seconds: 16 }), RATE);

  it('reports duration from the sample count', () => {
    expect(result.duration).toBeCloseTo(16, 3);
  });

  it('keeps every band track the same length as the onset envelope', () => {
    const n = result.onset.length;
    for (const band of [
      result.bands.bass,
      result.bands.lowMid,
      result.bands.mid,
      result.bands.high,
      result.bands.level,
    ]) {
      expect(band.length).toBe(n);
    }
  });

  it('normalises every band into 0..1', () => {
    for (const band of Object.values(result.bands)) {
      for (const v of band) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('scales per-beat energy across the full 0..1 range', () => {
    expect(Math.min(...result.beatEnergy)).toBeCloseTo(0, 5);
    expect(Math.max(...result.beatEnergy)).toBeCloseTo(1, 5);
  });

  it('reports a frame rate consistent with the hop size', () => {
    expect(result.frameRate).toBeCloseTo(RATE / 256, 6);
  });
});

describe('analyze — determinism', () => {
  it('returns byte-identical results for identical input', () => {
    const samples = clickTrack({ bpm: 118, seconds: 14 });
    const a = analyze(Float32Array.from(samples), RATE);
    const b = analyze(Float32Array.from(samples), RATE);

    expect(a.bpm).toBe(b.bpm);
    expect(a.weak).toBe(b.weak);
    expect(Array.from(a.beats)).toEqual(Array.from(b.beats));
    expect(Array.from(a.downbeats)).toEqual(Array.from(b.downbeats));
    expect(Array.from(a.beatEnergy)).toEqual(Array.from(b.beatEnergy));
    expect(Array.from(a.onset)).toEqual(Array.from(b.onset));
  });

  it('does not depend on progress reporting', () => {
    const samples = clickTrack({ bpm: 118, seconds: 10 });
    const withReports = analyze(Float32Array.from(samples), RATE, () => {});
    const without = analyze(Float32Array.from(samples), RATE);
    expect(Array.from(withReports.beats)).toEqual(Array.from(without.beats));
  });

  it('reports monotonically increasing progress within 0..1', () => {
    const seen: number[] = [];
    analyze(clickTrack({ bpm: 120, seconds: 8 }), RATE, (value) => seen.push(value));
    expect(seen.length).toBeGreaterThan(5);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(seen[0]).toBeGreaterThanOrEqual(0);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe('normalizeOnset', () => {
  it('rectifies to 0..1 with a peak of exactly 1', () => {
    const onset = new Float32Array(500);
    for (let i = 0; i < onset.length; i += 43) onset[i] = 5;
    const out = normalizeOnset(onset, 86);

    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...out)).toBeCloseTo(1, 6);
  });

  it('finds the same onsets under a sustained pad as without one', () => {
    // The transients are identical; the second signal buries them under a DC
    // offset and a slow swell, exactly what a held synth chord looks like.
    const pulses = new Float32Array(1200);
    for (let i = 0; i < pulses.length; i += 40) pulses[i] = 10;
    const buried = Float32Array.from(
      pulses,
      (v, i) => v + 5 + 4 * Math.sin((2 * Math.PI * i) / 900),
    );

    const topPeaks = (arr: Float32Array) =>
      Array.from(arr.entries())
        .filter(([, v]) => v > 0.5)
        .map(([i]) => i)
        .slice(0, 20);

    expect(topPeaks(normalizeOnset(buried, 86))).toEqual(topPeaks(normalizeOnset(pulses, 86)));
  });

  it('still keeps a quiet passage audible to the tracker', () => {
    // Same pulse spacing throughout; the second half is 20x quieter. Local mean
    // subtraction preserves relative dynamics — it is the beat tracker's score
    // accumulation, not this function, that carries a quiet section.
    const onset = new Float32Array(1200);
    for (let i = 0; i < 600; i += 40) onset[i] = 10;
    for (let i = 600; i < 1200; i += 40) onset[i] = 0.5;
    const out = normalizeOnset(onset, 86);

    const peakOf = (from: number, to: number) => Math.max(...out.slice(from, to));
    expect(peakOf(80, 560)).toBeCloseTo(1, 5);
    expect(peakOf(680, 1160)).toBeGreaterThan(0);
  });
});

describe('estimateTempo', () => {
  it('recovers the period of a clean impulse train', () => {
    const frameRate = 86.13;
    const period = 40; // frames -> ~129 BPM
    const odf = new Float32Array(4000);
    for (let i = 0; i < odf.length; i += period) odf[i] = 1;

    const { bpm, periodFrames, strength } = estimateTempo(odf, frameRate);
    expect(periodFrames).toBeGreaterThan(period - 1);
    expect(periodFrames).toBeLessThan(period + 1);
    expect(bpm).toBeCloseTo((60 * frameRate) / period, 0);
    expect(strength).toBeGreaterThan(0.5);
  });

  it('reports near-zero strength for a flat envelope', () => {
    const odf = new Float32Array(3000).fill(0.5);
    expect(estimateTempo(odf, 86.13).strength).toBeLessThan(0.2);
  });

  it('prefers the fundamental over the double when offbeats are strong', () => {
    // Beats at full strength, offbeats at 80% — naive autocorrelation is
    // tempted by the half-period.
    const frameRate = 86.13;
    const period = 44;
    const odf = new Float32Array(4000);
    for (let i = 0; i < odf.length; i += period) {
      odf[i] = 1;
      if (i + period / 2 < odf.length) odf[i + period / 2] = 0.8;
    }
    const { periodFrames } = estimateTempo(odf, frameRate);
    expect(periodFrames).toBeGreaterThan(period * 0.9);
  });
});

describe('trackBeats', () => {
  it('returns nothing for a degenerate period', () => {
    expect(trackBeats(new Float32Array(100), 1)).toEqual([]);
    expect(trackBeats(new Float32Array(0), 40)).toEqual([]);
  });

  it('follows a gradual tempo change instead of holding a rigid grid', () => {
    // Spacing drifts from 40 to 37 frames — about 8%, the sort of pull a human
    // drummer or a live take actually has.
    const odf = new Float32Array(3000);
    const truth: number[] = [];
    let at = 0;
    let spacing = 40;
    while (at < odf.length) {
      odf[Math.round(at)] = 1;
      truth.push(Math.round(at));
      at += spacing;
      spacing = Math.max(37, spacing - 0.04);
    }

    const beats = trackBeats(odf, 38.5);
    // Most detected beats should coincide with a real pulse.
    const truthSet = new Set(truth);
    const hits = beats.filter((b) =>
      truthSet.has(b) || truthSet.has(b - 1) || truthSet.has(b + 1),
    );
    expect(hits.length / beats.length).toBeGreaterThan(0.8);
  });

  it('is unaffected by seeded noise floor added to the envelope', () => {
    const random = seededRandom(3);
    const clean = new Float32Array(2000);
    for (let i = 0; i < clean.length; i += 43) clean[i] = 1;
    const noisy = Float32Array.from(clean, (v) => v + random() * 0.05);

    const a = trackBeats(clean, 43);
    const b = trackBeats(noisy, 43);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
  });
});
