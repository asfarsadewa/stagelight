import { describe, expect, it } from 'vitest';
import { FFT, hannWindow } from '../src/audio/fft';
import { referenceDft, seededRandom } from './helpers/signal';

describe('FFT', () => {
  it('rejects sizes that are not a power of two', () => {
    expect(() => new FFT(1000)).toThrow(/power of two/);
    expect(() => new FFT(1024)).not.toThrow();
  });

  it('turns a DC signal into energy at bin 0 only', () => {
    const n = 64;
    const re = new Float32Array(n).fill(1);
    const im = new Float32Array(n);
    new FFT(n).transform(re, im);

    expect(re[0]).toBeCloseTo(n, 5);
    for (let k = 1; k < n; k++) {
      expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-3);
    }
  });

  it('puts a pure sinusoid in its own bin and its mirror', () => {
    const n = 256;
    const bin = 9;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);

    new FFT(n).transform(re, im);

    const magnitude = (k: number) => Math.hypot(re[k], im[k]);
    // A real cosine splits its energy between k and n-k, at n/2 each.
    expect(magnitude(bin)).toBeCloseTo(n / 2, 2);
    expect(magnitude(n - bin)).toBeCloseTo(n / 2, 2);

    for (let k = 0; k < n; k++) {
      if (k === bin || k === n - bin) continue;
      expect(magnitude(k)).toBeLessThan(1e-2);
    }
  });

  it('matches a naive DFT on arbitrary input', () => {
    const n = 128;
    const random = seededRandom(42);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = random() * 2 - 1;

    const expected = referenceDft(re, im);
    new FFT(n).transform(re, im);

    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(expected.re[k], 3);
      expect(im[k]).toBeCloseTo(expected.im[k], 3);
    }
  });

  it('conserves energy (Parseval)', () => {
    const n = 256;
    const random = seededRandom(7);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    let timeEnergy = 0;
    for (let i = 0; i < n; i++) {
      re[i] = random() * 2 - 1;
      timeEnergy += re[i] * re[i];
    }

    new FFT(n).transform(re, im);

    let freqEnergy = 0;
    for (let k = 0; k < n; k++) freqEnergy += re[k] * re[k] + im[k] * im[k];
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 2);
  });
});

describe('hannWindow', () => {
  it('starts and ends at zero with a peak in the middle', () => {
    const w = hannWindow(64);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[32]).toBeCloseTo(1, 6);
    expect(w[63]).toBeGreaterThan(0);
    expect(w[63]).toBeLessThan(0.01);
  });

  it('is symmetric about its centre', () => {
    const n = 128;
    const w = hannWindow(n);
    for (let i = 1; i < n / 2; i++) {
      expect(w[i]).toBeCloseTo(w[n - i], 6);
    }
  });
});
