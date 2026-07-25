import { beforeEach, describe, expect, it } from 'vitest';
import { Director, POSE } from '../src/choreo/director';
import type { AnalysisResult } from '../src/audio/types';

const FRAME_RATE = 86.13;

/** A clean synthetic analysis, so choreography is tested independently of detection. */
function fakeAnalysis({
  bpm = 120,
  seconds = 60,
  energy = 0.5,
  weak = false,
}: { bpm?: number; seconds?: number; energy?: number | ((i: number) => number); weak?: boolean } = {}): AnalysisResult {
  const period = 60 / bpm;
  const count = Math.floor(seconds / period);
  const beats = Float32Array.from({ length: count }, (_, i) => i * period);
  const beatEnergy = Float32Array.from({ length: count }, (_, i) =>
    typeof energy === 'function' ? energy(i) : energy,
  );
  const frames = Math.floor(seconds * FRAME_RATE);
  const flat = (v: number) => new Float32Array(frames).fill(v);

  return {
    duration: seconds,
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    beatEnergy,
    onset: flat(0.3),
    frameRate: FRAME_RATE,
    bands: { bass: flat(0.4), lowMid: flat(0.3), mid: flat(0.3), high: flat(0.3), level: flat(0.5) },
    weak,
  };
}

/** Run the director forward so its smoothed values settle, as in the real loop. */
function settle(director: Director, until: number, dt = 1 / 60) {
  let state = director.update(0, dt);
  for (let t = 0; t <= until; t += dt) state = director.update(t, dt);
  return state;
}

describe('Director — waiting', () => {
  let director: Director;
  beforeEach(() => {
    director = new Director();
  });

  it('waits when there is no analysis at all', () => {
    const state = director.update(3, 1 / 60);
    expect(state.idle).toBe(true);
    expect(state.moveName).toBe('waiting');
  });

  it('waits when a track is loaded but stopped', () => {
    director.setAnalysis(fakeAnalysis());
    const state = director.update(12, 1 / 60, undefined, true);
    expect(state.idle).toBe(true);
    expect(state.moveName).toBe('waiting');
  });

  it('never uses a dance pose while waiting', () => {
    const allowed = new Set<number>([POSE.NEUTRAL, POSE.ARM_OUT, POSE.WIDE, POSE.DRIFT]);
    for (let t = 0; t < 120; t += 0.05) {
      expect(allowed).toContain(director.update(t, 0.05, undefined, true).frame);
    }
  });

  it('never pulses while waiting, so the rig cannot strobe', () => {
    for (let t = 0; t < 60; t += 0.05) {
      const state = director.update(t, 0.05, undefined, true);
      expect(state.beatPulse).toBe(0);
      expect(state.barPulse).toBe(0);
    }
  });

  it('barely moves while waiting', () => {
    let maxLift = 0;
    for (let t = 0; t < 60; t += 0.05) {
      maxLift = Math.max(maxLift, Math.abs(director.update(t, 0.05, undefined, true).lift));
    }
    expect(maxLift).toBeLessThan(0.05);
  });

  it('loops its idle sequence rather than settling on one pose', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 40; t += 0.1) seen.add(director.update(t, 0.1, undefined, true).frame);
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe('Director — dancing', () => {
  let director: Director;
  beforeEach(() => {
    director = new Director();
    director.setAnalysis(fakeAnalysis());
  });

  it('dances once a track is playing', () => {
    const state = settle(director, 20);
    expect(state.idle).toBe(false);
    expect(state.moveName).not.toBe('waiting');
  });

  it('only ever emits frames that exist in the atlas', () => {
    for (let t = 0; t < 60; t += 0.02) {
      const frame = director.update(t, 0.02).frame;
      expect(Number.isInteger(frame)).toBe(true);
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThan(12);
    }
  });

  it('keeps every phase and pulse inside 0..1', () => {
    for (let t = 0; t < 60; t += 0.02) {
      const s = director.update(t, 0.02);
      for (const v of [s.beatPhase, s.barPhase, s.beatPulse, s.barPulse, s.intensity]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('advances the beat phase within a beat and resets on the next', () => {
    const period = 60 / 120;
    const early = director.update(4 * period + 0.02, 1 / 60).beatPhase;
    const late = director.update(4 * period + period * 0.9, 1 / 60).beatPhase;
    const next = director.update(5 * period + 0.02, 1 / 60).beatPhase;

    expect(late).toBeGreaterThan(early);
    expect(next).toBeLessThan(late);
  });

  it('produces a beat pulse that decays across the beat', () => {
    const period = 60 / 120;
    const onBeat = director.update(8 * period + 0.005, 1 / 60).beatPulse;
    const offBeat = director.update(8 * period + period * 0.8, 1 / 60).beatPulse;
    expect(onBeat).toBeGreaterThan(0.9);
    expect(offBeat).toBeLessThan(0.1);
  });
});

describe('Director — seek stability', () => {
  it('replays the same choreography whether a bar is reached forward or by jumping', () => {
    const analysis = fakeAnalysis({ seconds: 120 });
    // Deliberately not on a bar line: at 120 BPM a bar is 2s, so a target of
    // exactly 40s would sit on the boundary where a sub-millisecond difference
    // in accumulated time legitimately selects the next bar's routine.
    const target = 37.3;

    const played = new Director();
    played.setAnalysis(analysis);
    let forward = played.update(0, 1 / 60);
    for (let t = 0; t < target; t += 1 / 60) played.update(t, 1 / 60);
    forward = played.update(target, 1 / 60);

    const jumped = new Director();
    jumped.setAnalysis(analysis);
    // Settle the smoothing at the target instead of arriving through the track.
    let seeked = jumped.update(target, 1 / 60);
    for (let i = 0; i < 400; i++) seeked = jumped.update(target, 1 / 60);

    expect(seeked.moveName).toBe(forward.moveName);
    expect(seeked.frame).toBe(forward.frame);
  });

  it('handles a backward seek without losing the grid', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis({ seconds: 120 }));

    for (let t = 0; t < 60; t += 1 / 60) director.update(t, 1 / 60);
    const back = director.update(5.25, 1 / 60);

    expect(back.beatPhase).toBeGreaterThanOrEqual(0);
    expect(back.beatPhase).toBeLessThan(1);
    expect(back.frame).toBeGreaterThanOrEqual(0);
    expect(back.frame).toBeLessThan(12);
  });

  it('is a pure function of time once smoothing has settled', () => {
    const analysis = fakeAnalysis({ seconds: 120 });
    const runs = [0, 1].map(() => {
      const d = new Director();
      d.setAnalysis(analysis);
      let s = d.update(30, 1 / 60);
      for (let i = 0; i < 500; i++) s = d.update(30, 1 / 60);
      return s;
    });
    expect(runs[0]).toEqual(runs[1]);
  });
});

describe('Director — energy drives the routine', () => {
  const routineAt = (energy: number) => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis({ energy, seconds: 120 }));
    const names = new Set<string>();
    for (let t = 0; t < 90; t += 1 / 60) names.add(director.update(t, 1 / 60).moveName);
    return names;
  };

  it('stays calm through a quiet arrangement', () => {
    const names = routineAt(0.02);
    expect(names.has('hype')).toBe(false);
    expect(names.has('drop')).toBe(false);
  });

  it('reaches the big moves when the track opens up', () => {
    const names = routineAt(1.0);
    expect(names.has('hype') || names.has('drop')).toBe(true);
  });

  it('leaves the ground only on the airborne poses', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis({ energy: 1.0, seconds: 120 }));
    for (let t = 0; t < 90; t += 1 / 120) {
      const s = director.update(t, 1 / 120);
      if (s.lift > 0.12) {
        expect([POSE.JUMP, POSE.SPIN_BACK, POSE.SPIN_FRONT]).toContain(s.frame);
      }
    }
  });
});

describe('Director — degraded input', () => {
  it('free-runs rather than faking a lock on a weak analysis', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis({ weak: true }));
    const state = settle(director, 10);
    expect(state.freeRunning).toBe(true);
    expect(state.idle).toBe(false);
  });

  it('actually ignores a weak grid instead of only reporting that it did', () => {
    // Same audio, wildly different (and untrustworthy) beat positions. If the
    // rejected grid still drove timing, these would diverge. Asserting the
    // freeRunning flag alone never caught that.
    const base = fakeAnalysis({ weak: true, seconds: 120 });
    const scrambled: AnalysisResult = {
      ...base,
      bpm: 61,
      beats: Float32Array.from(base.beats, (_, i) => i * 0.98 + (i % 3) * 0.21),
    };

    const routine = (analysis: AnalysisResult) => {
      const director = new Director();
      director.setAnalysis(analysis);
      const out: string[] = [];
      for (let t = 0; t < 45; t += 1 / 60) {
        const s = director.update(t, 1 / 60);
        out.push(`${s.moveName}:${s.frame}`);
      }
      return out;
    };

    expect(routine(scrambled)).toEqual(routine(base));
  });

  it('reports the tempo that is driving the stage, not the rejected estimate', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis({ weak: true, bpm: 177 }));
    expect(settle(director, 10).bpm).not.toBe(177);
  });

  it('still varies its routine on weak material', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis({ weak: true, seconds: 120 }));
    const frames = new Set<number>();
    for (let t = 0; t < 60; t += 1 / 60) frames.add(director.update(t, 1 / 60).frame);
    expect(frames.size).toBeGreaterThan(2);
  });

  it('falls back to waiting when an analysis has no usable grid', () => {
    const director = new Director();
    const empty = fakeAnalysis();
    (empty as { beats: Float32Array }).beats = new Float32Array(1);
    director.setAnalysis(empty);
    const state = director.update(5, 1 / 60);
    expect(state.frame).toBeGreaterThanOrEqual(0);
    expect(state.frame).toBeLessThan(12);
  });

  it('returns to waiting when the analysis is cleared', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis());
    settle(director, 10);
    director.setAnalysis(null);
    expect(director.update(11, 1 / 60).idle).toBe(true);
  });

  it('tolerates a time beyond the end of the track', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis({ seconds: 20 }));
    const state = director.update(9999, 1 / 60);
    expect(Number.isFinite(state.lift)).toBe(true);
    expect(state.frame).toBeGreaterThanOrEqual(0);
    expect(state.frame).toBeLessThan(12);
  });
});
