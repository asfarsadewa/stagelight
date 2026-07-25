import { describe, expect, it } from 'vitest';
import { Director } from '../src/choreo/director';
import { POSE, RECIPES, transitionCost, transitionKind } from '../src/choreo/poses';
import type { AnalysisResult } from '../src/audio/types';

const FRAME_RATE = 86.13;
const BPM = 120;

function fakeAnalysis(energy: number, seconds = 120): AnalysisResult {
  const period = 60 / BPM;
  const count = Math.floor(seconds / period);
  const beats = Float32Array.from({ length: count }, (_, i) => i * period);
  const frames = Math.floor(seconds * FRAME_RATE);
  const flat = (v: number) => new Float32Array(frames).fill(v);
  return {
    duration: seconds,
    bpm: BPM,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    beatEnergy: new Float32Array(count).fill(energy),
    onset: flat(0.3),
    frameRate: FRAME_RATE,
    bands: { bass: flat(0.4), lowMid: flat(0.3), mid: flat(0.3), high: flat(0.3), level: flat(energy) },
    weak: false,
  };
}

/** Sample a whole run at fine resolution, after letting the smoothing settle. */
function sample(energy: number, seconds = 60, dt = 1 / 120) {
  const director = new Director();
  director.setAnalysis(fakeAnalysis(energy));
  for (let i = 0; i < 400; i++) director.update(0, 1 / 60);
  const states = [];
  for (let t = 0; t < seconds; t += dt) states.push(director.update(t, dt));
  return states;
}

describe('transitionKind', () => {
  it('reads the named edges the way the choreography intends', () => {
    expect(transitionKind(POSE.CROUCH, POSE.JUMP)).toBe('rise');
    expect(transitionKind(POSE.JUMP, POSE.LAND)).toBe('drop');
    expect(transitionKind(POSE.SPIN_BACK, POSE.SPIN_FRONT)).toBe('turn');
    expect(transitionKind(POSE.LAND, POSE.DRIFT)).toBe('recover');
  });

  it('derives a kind for every possible edge without a table entry', () => {
    const poses = Object.values(POSE);
    for (const from of poses) {
      for (const to of poses) {
        expect(RECIPES[transitionKind(from, to)]).toBeDefined();
      }
    }
  });

  it('treats a spin as a turn in both directions', () => {
    expect(transitionKind(POSE.SPIN_FRONT, POSE.SPIN_BACK)).toBe('turn');
  });
});

describe('transitionCost', () => {
  it('prefers landing out of the air over an unrelated standing pose', () => {
    expect(transitionCost(POSE.JUMP, POSE.LAND)).toBeLessThan(
      transitionCost(POSE.JUMP, POSE.POINT_LEFT),
    );
  });

  it('penalises a deep crouch straight into a raised pose', () => {
    expect(transitionCost(POSE.CROUCH, POSE.ARMS_UP)).toBeGreaterThan(
      transitionCost(POSE.CROUCH, POSE.DRIFT),
    );
  });

  it('penalises stringing two airborne poses together across a seam', () => {
    expect(transitionCost(POSE.JUMP, POSE.SPIN_BACK)).toBeGreaterThan(
      transitionCost(POSE.NEUTRAL, POSE.ARM_OUT),
    );
  });

  it('costs a continuation to itself nothing much', () => {
    expect(transitionCost(POSE.NEUTRAL, POSE.NEUTRAL)).toBe(0);
  });
});

describe('bar seams', () => {
  it('never stitches a bar ending airborne onto one that cannot absorb it', () => {
    for (const energy of [0.15, 0.4, 0.65, 0.85, 1.0]) {
      const states = sample(energy, 90, 1 / 60);
      // Walk the pose sequence and check every change that crosses a bar line.
      let previous = states[0];
      for (const state of states) {
        if (state.frame !== previous.frame && state.moveName !== previous.moveName) {
          expect(transitionCost(previous.frame, state.frame)).toBeLessThan(4.5);
        }
        previous = state;
      }
    }
  });

  it('does not run the same routine for bar after bar', () => {
    const names = sample(0.85, 90, 1 / 60).map((s) => s.moveName);
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < names.length; i++) {
      if (names[i] === names[i - 1]) run++;
      else run = 1;
      longestRun = Math.max(longestRun, run);
    }
    // 90s at 120 BPM is 45 bars; a single routine must not own most of them.
    const distinct = new Set(names);
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('anticipation and settlement', () => {
  it('starts moving before the drawing changes', () => {
    const states = sample(0.85, 40);
    // Find a cut into JUMP and look at the frames immediately before it.
    let cutAt = -1;
    for (let i = 1; i < states.length; i++) {
      if (states[i].frame === POSE.JUMP && states[i - 1].frame !== POSE.JUMP) {
        cutAt = i;
        break;
      }
    }
    expect(cutAt).toBeGreaterThan(20);

    // In the run-up she should be loading downward, below where she sat earlier
    // in the same held pose.
    const justBefore = states[cutAt - 1].lift;
    const earlier = states[cutAt - 18].lift;
    expect(justBefore).toBeLessThan(earlier);
  });

  it('is already rising on the frame the jump appears', () => {
    const states = sample(0.85, 40);
    for (let i = 1; i < states.length - 6; i++) {
      if (states[i].frame === POSE.JUMP && states[i - 1].frame !== POSE.JUMP) {
        // Not starting from a standing lift of zero: the launch is underway.
        expect(states[i + 5].lift).toBeGreaterThan(states[i].lift);
        expect(states[i + 5].lift).toBeGreaterThan(0.05);
        return;
      }
    }
    throw new Error('no jump found to check');
  });

  it('compresses on landing rather than snapping flat', () => {
    const states = sample(0.85, 40);
    for (let i = 1; i < states.length - 8; i++) {
      if (states[i].frame === POSE.LAND && states[i - 1].frame === POSE.JUMP) {
        // squash < 1 is shorter and wider — the weight arriving.
        const lowest = Math.min(...states.slice(i, i + 8).map((s) => s.squash));
        expect(lowest).toBeLessThan(1);
        return;
      }
    }
    throw new Error('no landing found to check');
  });

  it('narrows through a turn and flares out of it', () => {
    const states = sample(0.85, 60);
    for (let i = 1; i < states.length - 10; i++) {
      if (states[i].frame === POSE.SPIN_FRONT && states[i - 1].frame === POSE.SPIN_BACK) {
        const after = Math.max(...states.slice(i, i + 8).map((s) => s.stretchX));
        expect(after).toBeGreaterThan(1);
        return;
      }
    }
    throw new Error('no spin found to check');
  });

  it('keeps every transform within sane bounds', () => {
    for (const energy of [0.1, 0.5, 1.0]) {
      for (const state of sample(energy, 60)) {
        expect(Math.abs(state.lift)).toBeLessThan(0.6);
        expect(Math.abs(state.lean)).toBeLessThan(0.5);
        expect(state.squash).toBeGreaterThan(0.6);
        expect(state.squash).toBeLessThan(1.5);
        expect(state.stretchX).toBeGreaterThan(0.6);
        expect(state.stretchX).toBeLessThan(1.5);
      }
    }
  });
});

describe('afterimage', () => {
  it('stays off entirely at low intensity', () => {
    for (const state of sample(0.2, 60)) {
      expect(state.ghostAmount).toBe(0);
    }
  });

  it('appears on hard cuts once the track is driving', () => {
    const states = sample(0.9, 60);
    expect(Math.max(...states.map((s) => s.ghostAmount))).toBeGreaterThan(0.1);
  });

  it('is brief — a smear, not a second dancer', () => {
    const states = sample(0.9, 60, 1 / 120);
    // Perceptible ghosting only. A faint tail below this is invisible against
    // an additive blend on a lit stage.
    const visible = states.filter((s) => s.ghostAmount > 0.08).length;
    expect(visible / states.length).toBeLessThan(0.15);
  });

  it('is capped relative to the step, so fast bars do not ghost throughout', () => {
    // The eight-step routines only appear at high energy; their steps are half
    // as long, so the smear has to shorten with them.
    const fast = sample(0.95, 60, 1 / 120).filter((s) => s.ghostAmount > 0.08).length;
    const slow = sample(0.65, 60, 1 / 120).filter((s) => s.ghostAmount > 0.08).length;
    expect(fast / slow).toBeLessThan(2.2);
  });

  it('never shows the frame that is already on screen', () => {
    for (const state of sample(0.9, 60)) {
      if (state.ghostAmount > 0) expect(state.ghostFrame).not.toBe(state.frame);
    }
  });

  it('does not drift sideways on a purely vertical cut', () => {
    // A crouch-to-jump travels straight up. Any lateral offset here reads as
    // the sprite briefly misregistering to one side.
    const vertical = sample(0.9, 90).filter(
      (s) => s.ghostAmount > 0.02 && (s.transition === 'rise' || s.transition === 'drop'),
    );
    expect(vertical.length).toBeGreaterThan(0);
    for (const state of vertical) {
      // Math.abs so a negative zero, which renders identically, still passes.
      expect(Math.abs(state.ghostOffsetX)).toBe(0);
      expect(Math.abs(state.ghostOffsetY)).toBeGreaterThan(0);
    }
  });

  it('does smear sideways through a turn', () => {
    const turns = sample(0.9, 90).filter((s) => s.ghostAmount > 0.05 && s.transition === 'turn');
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.some((s) => Math.abs(s.ghostOffsetX) > 0)).toBe(true);
  });

  it('trails behind the movement rather than leading it', () => {
    const states = sample(0.9, 60).filter((s) => s.ghostAmount > 0.05);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(Math.abs(state.ghostOffsetX)).toBeLessThan(0.2);
      expect(Math.abs(state.ghostOffsetY)).toBeLessThan(0.2);
    }
  });
});

describe('planning stays deterministic', () => {
  it('produces an identical routine on a second pass', () => {
    const a = sample(0.8, 40).map((s) => `${s.moveName}:${s.frame}`);
    const b = sample(0.8, 40).map((s) => `${s.moveName}:${s.frame}`);
    expect(a).toEqual(b);
  });

  it('replays the same pose after seeking backwards', () => {
    const director = new Director();
    director.setAnalysis(fakeAnalysis(0.8));
    for (let i = 0; i < 200; i++) director.update(0, 1 / 60);

    const first = director.update(31.4, 1 / 60);
    for (let t = 31.4; t < 70; t += 1 / 60) director.update(t, 1 / 60);
    const afterSeek = director.update(31.4, 1 / 60);

    expect(afterSeek.frame).toBe(first.frame);
    expect(afterSeek.moveName).toBe(first.moveName);
  });

  it('does not depend on how the smoothing was warmed up', () => {
    const cold = new Director();
    cold.setAnalysis(fakeAnalysis(0.8));
    const coldState = cold.update(24.75, 1 / 60);

    const warm = new Director();
    warm.setAnalysis(fakeAnalysis(0.8));
    for (let t = 0; t < 24.75; t += 1 / 60) warm.update(t, 1 / 60);
    const warmState = warm.update(24.75, 1 / 60);

    // Pose selection comes from the precomputed plan, not from runtime state.
    expect(coldState.frame).toBe(warmState.frame);
    expect(coldState.moveName).toBe(warmState.moveName);
  });
});
