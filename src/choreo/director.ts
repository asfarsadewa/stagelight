import type { AnalysisResult } from '../audio/types';

/**
 * Pose indices in the atlas, in generation order.
 *
 *  0 neutral      1 right arm out   2 arms up in a V   3 sweep down-left
 *  4 point left   5 spin (back)     6 spin (front)     7 wide, arms crossed
 *  8 crouch       9 jump           10 land + point    11 drift to neutral
 */
export const POSE = {
  NEUTRAL: 0,
  ARM_OUT: 1,
  ARMS_UP: 2,
  SWEEP: 3,
  POINT_LEFT: 4,
  SPIN_BACK: 5,
  SPIN_FRONT: 6,
  WIDE: 7,
  CROUCH: 8,
  JUMP: 9,
  LAND: 10,
  DRIFT: 11,
} as const;

/** Poses where her feet have left the floor — they get extra airtime. */
const AIRBORNE = new Set<number>([POSE.JUMP, POSE.SPIN_BACK, POSE.SPIN_FRONT]);
/** Poses that read as compressed — they get pushed down instead of lifted. */
const GROUNDED = new Set<number>([POSE.CROUCH, POSE.LAND]);

interface Move {
  name: string;
  /** One pose per step; `stepsPerBeat` steps fire per beat. */
  frames: number[];
  stepsPerBeat: number;
  /** Intensity window this move is eligible for. */
  min: number;
  max: number;
}

const MOVES: Move[] = [
  { name: 'sway', frames: [POSE.NEUTRAL, POSE.ARM_OUT, POSE.DRIFT, POSE.SWEEP], stepsPerBeat: 1, min: 0, max: 0.42 },
  { name: 'lull', frames: [POSE.DRIFT, POSE.NEUTRAL, POSE.SWEEP, POSE.ARM_OUT], stepsPerBeat: 1, min: 0, max: 0.35 },
  { name: 'step', frames: [POSE.ARM_OUT, POSE.POINT_LEFT, POSE.SWEEP, POSE.WIDE], stepsPerBeat: 1, min: 0.22, max: 0.72 },
  { name: 'bounce', frames: [POSE.CROUCH, POSE.DRIFT, POSE.CROUCH, POSE.SWEEP], stepsPerBeat: 1, min: 0.28, max: 0.75 },
  { name: 'turn', frames: [POSE.ARM_OUT, POSE.SPIN_BACK, POSE.SPIN_FRONT, POSE.LAND], stepsPerBeat: 1, min: 0.4, max: 0.9 },
  {
    name: 'double',
    frames: [POSE.ARM_OUT, POSE.WIDE, POSE.POINT_LEFT, POSE.SWEEP, POSE.CROUCH, POSE.DRIFT, POSE.ARMS_UP, POSE.LAND],
    stepsPerBeat: 2,
    min: 0.55,
    max: 1.01,
  },
  { name: 'hype', frames: [POSE.ARMS_UP, POSE.CROUCH, POSE.JUMP, POSE.LAND], stepsPerBeat: 1, min: 0.62, max: 1.01 },
  {
    name: 'drop',
    frames: [POSE.CROUCH, POSE.JUMP, POSE.LAND, POSE.ARMS_UP, POSE.SPIN_BACK, POSE.SPIN_FRONT, POSE.WIDE, POSE.ARMS_UP],
    stepsPerBeat: 2,
    min: 0.78,
    max: 1.01,
  },
];

export interface DanceState {
  /** Atlas frame to display. */
  frame: number;
  /** 0..1 within the current beat. */
  beatPhase: number;
  /** 0..1 within the current bar. */
  barPhase: number;
  /** Decays from 1 at each beat. */
  beatPulse: number;
  /** Decays from 1 at each downbeat. */
  barPulse: number;
  /** Vertical offset in stage units. */
  lift: number;
  /** Lateral drift in stage units. */
  sway: number;
  /** Body tilt in radians. */
  lean: number;
  /** Vertical squash/stretch multiplier around 1. */
  squash: number;
  /** Smoothed arrangement intensity, 0..1. */
  intensity: number;
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  level: number;
  bpm: number;
  moveName: string;
  /** True when the beat grid is not trustworthy and motion is free-running. */
  freeRunning: boolean;
  /** True when nothing is playing: she waits rather than dances, and the rig rests. */
  idle: boolean;
}

const FALLBACK_BPM = 104;

/**
 * What she does with no music playing: standing, breathing, shifting her weight.
 * Long holds and near-identical silhouettes either side of each change, so the
 * hard cut between drawings reads as settling rather than as a dance step.
 */
const IDLE_LOOP: { frame: number; hold: number }[] = [
  { frame: POSE.NEUTRAL, hold: 3.4 },
  { frame: POSE.DRIFT, hold: 1.8 },
  { frame: POSE.NEUTRAL, hold: 2.6 },
  { frame: POSE.ARM_OUT, hold: 1.5 },
  { frame: POSE.DRIFT, hold: 2.2 },
  { frame: POSE.NEUTRAL, hold: 3.0 },
  { frame: POSE.WIDE, hold: 1.7 },
  { frame: POSE.DRIFT, hold: 2.0 },
];
const IDLE_PERIOD = IDLE_LOOP.reduce((sum, s) => sum + s.hold, 0);

export class Director {
  private analysis: AnalysisResult | null = null;
  private beatCursor = 0;
  private smoothedIntensity = 0;
  private smoothedBands = { bass: 0, lowMid: 0, mid: 0, high: 0, level: 0 };

  setAnalysis(analysis: AnalysisResult | null) {
    this.analysis = analysis;
    this.beatCursor = 0;
    this.smoothedIntensity = 0;
  }

  /**
   * @param time     playback position in seconds, or a free-running clock while waiting
   * @param dt       real elapsed time since the last call, for smoothing
   * @param live     optional realtime spectrum energies, blended with the offline
   *                 tracks so the stage still breathes if analysis was weak
   * @param waiting  nothing is playing — stand and wait instead of dancing
   */
  update(
    time: number,
    dt: number,
    live?: { bass: number; mid: number; high: number },
    waiting = false,
  ): DanceState {
    const a = this.analysis;
    const freeRunning = !a || a.weak;

    const bands = this.sampleBands(time, dt, live);

    // No track, or the track is stopped: she has nothing to dance to.
    if (waiting || !a) return this.waiting(time, bands);

    if (a.beats.length < 2) {
      return this.freeRun(time, bands, freeRunning);
    }

    const beats = a.beats;
    const i = this.findBeat(beats, time);
    const beatStart = beats[i];
    const beatEnd = i + 1 < beats.length ? beats[i + 1] : beatStart + 60 / a.bpm;
    const beatDur = Math.max(1e-3, beatEnd - beatStart);
    const beatPhase = clamp01((time - beatStart) / beatDur);

    // Intensity leads the arrangement slightly so a build lands with the drop.
    const target = a.beatEnergy[Math.min(a.beatEnergy.length - 1, i + 1)] ?? 0;
    this.smoothedIntensity += (target - this.smoothedIntensity) * Math.min(1, dt * 2.2);
    const intensity = clamp01(this.smoothedIntensity * 0.75 + bands.level * 0.25);

    const barIndex = Math.floor(i / 4);
    const beatInBar = ((i % 4) + 4) % 4;
    const barPhase = (beatInBar + beatPhase) / 4;

    const move = pickMove(barIndex, intensity);
    const stepsPerBar = move.frames.length;
    const stepPos = ((beatInBar + beatPhase) / 4) * stepsPerBar;
    const step = Math.min(stepsPerBar - 1, Math.floor(stepPos));
    const frame = move.frames[step];
    // Phase inside the current pose, so motion resets when the pose changes.
    const stepPhase = clamp01(stepPos - step);

    const beatPulse = Math.pow(1 - beatPhase, 2.6);
    const barPulse = Math.pow(1 - barPhase, 3.2);

    return {
      frame,
      beatPhase,
      barPhase,
      beatPulse,
      barPulse,
      ...this.bodyMotion(frame, stepPhase, beatPulse, intensity, time, bands),
      intensity,
      ...bands,
      bpm: a.bpm,
      moveName: move.name,
      freeRunning,
      idle: false,
    };
  }

  /**
   * Standing by. No beat pulse at all, so the rig stops flashing and the stage
   * simply breathes until a track arrives.
   */
  private waiting(
    time: number,
    bands: { bass: number; lowMid: number; mid: number; high: number; level: number },
  ): DanceState {
    const t = ((time % IDLE_PERIOD) + IDLE_PERIOD) % IDLE_PERIOD;
    let elapsed = 0;
    let step = IDLE_LOOP[0];
    let phase = 0;
    for (const candidate of IDLE_LOOP) {
      if (t < elapsed + candidate.hold) {
        step = candidate;
        phase = (t - elapsed) / candidate.hold;
        break;
      }
      elapsed += candidate.hold;
    }

    // A weight shift over the first moments of each pose, then stillness.
    const settle = Math.sin(Math.PI * Math.min(1, phase * 3.5));
    const breath = Math.sin(time * 1.35);

    return {
      frame: step.frame,
      beatPhase: phase,
      barPhase: t / IDLE_PERIOD,
      beatPulse: 0,
      barPulse: 0,
      lift: breath * 0.014 + settle * 0.02,
      sway: Math.sin(time * 0.41) * 0.036 + Math.sin(time * 0.77) * 0.012,
      lean: Math.sin(time * 0.29) * 0.022 + settle * 0.012,
      squash: 1 + breath * 0.013,
      intensity: 0.1,
      ...bands,
      bpm: FALLBACK_BPM,
      moveName: 'waiting',
      freeRunning: true,
      idle: true,
    };
  }

  /** Ambient motion when there is no dependable grid (or no track yet). */
  private freeRun(
    time: number,
    bands: { bass: number; lowMid: number; mid: number; high: number; level: number },
    freeRunning: boolean,
  ): DanceState {
    const beatDur = 60 / FALLBACK_BPM;
    const beatIndex = Math.floor(time / beatDur);
    const beatPhase = (time % beatDur) / beatDur;
    const beatInBar = ((beatIndex % 4) + 4) % 4;
    const barPhase = (beatInBar + beatPhase) / 4;
    const intensity = clamp01(bands.level);
    const move = pickMove(Math.floor(beatIndex / 4), Math.min(intensity, 0.5));
    const stepPos = barPhase * move.frames.length;
    const step = Math.min(move.frames.length - 1, Math.floor(stepPos));
    const beatPulse = Math.pow(1 - beatPhase, 2.6);

    return {
      frame: move.frames[step],
      beatPhase,
      barPhase,
      beatPulse,
      barPulse: Math.pow(1 - barPhase, 3.2),
      ...this.bodyMotion(move.frames[step], clamp01(stepPos - step), beatPulse, intensity, time, bands),
      intensity,
      ...bands,
      bpm: FALLBACK_BPM,
      moveName: move.name,
      freeRunning,
      idle: false,
    };
  }

  /**
   * Procedural layer on top of the discrete poses. Twelve drawings would read
   * as a flipbook on their own; this is what makes them feel like a body.
   */
  private bodyMotion(
    frame: number,
    stepPhase: number,
    beatPulse: number,
    intensity: number,
    time: number,
    bands: { bass: number; level: number },
  ) {
    const amp = 0.35 + intensity * 0.65;

    // Arc through the pose: rises just after the pose changes, settles before
    // the next one.
    const arc = Math.sin(Math.PI * stepPhase);
    let lift = arc * 0.06 * amp;
    if (AIRBORNE.has(frame)) lift += arc * 0.34 * amp + 0.05;
    if (GROUNDED.has(frame)) lift -= (1 - arc) * 0.05 * amp;

    // Kick drum pushes her down into the stage on the beat.
    const impact = beatPulse * (0.5 + bands.bass * 0.5);
    lift -= impact * 0.045 * amp;

    const squash = 1 + impact * 0.075 * amp - (AIRBORNE.has(frame) ? -0.03 : 0) * amp;

    const sway = Math.sin(time * 0.9) * 0.05 * amp + Math.sin(time * 2.1) * 0.02 * amp;
    const lean =
      Math.sin(time * 1.15) * 0.045 * amp + (frame === POSE.SPIN_BACK || frame === POSE.SPIN_FRONT ? 0.05 : 0);

    return { lift, sway, lean, squash };
  }

  private sampleBands(time: number, dt: number, live?: { bass: number; mid: number; high: number }) {
    const a = this.analysis;
    let bass = 0, lowMid = 0, mid = 0, high = 0, level = 0;

    if (a) {
      const f = Math.max(0, Math.min(a.onset.length - 1, Math.round(time * a.frameRate)));
      bass = a.bands.bass[f] ?? 0;
      lowMid = a.bands.lowMid[f] ?? 0;
      mid = a.bands.mid[f] ?? 0;
      high = a.bands.high[f] ?? 0;
      level = a.bands.level[f] ?? 0;
    }
    if (live) {
      // The offline tracks are sample-accurate; the live ones ride out any
      // clock drift between the audio thread and the render loop.
      bass = Math.max(bass, live.bass);
      mid = Math.max(mid, live.mid);
      high = Math.max(high, live.high);
      level = Math.max(level, (live.bass + live.mid + live.high) / 3);
    }

    const k = Math.min(1, dt * 14);
    const s = this.smoothedBands;
    s.bass += (bass - s.bass) * k;
    s.lowMid += (lowMid - s.lowMid) * k;
    s.mid += (mid - s.mid) * k;
    s.high += (high - s.high) * k;
    s.level += (level - s.level) * k;

    return { bass: s.bass, lowMid: s.lowMid, mid: s.mid, high: s.high, level: s.level };
  }

  /** Index of the last beat at or before `time`. Cursor makes this O(1) while playing. */
  private findBeat(beats: Float32Array, time: number): number {
    let i = Math.min(this.beatCursor, beats.length - 1);
    if (beats[i] > time) {
      // Seeked backwards — binary search rather than walking the whole array.
      let lo = 0;
      let hi = beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (beats[mid] <= time) lo = mid;
        else hi = mid - 1;
      }
      i = lo;
    } else {
      while (i + 1 < beats.length && beats[i + 1] <= time) i++;
    }
    this.beatCursor = i;
    return i;
  }
}

/** Deterministic per-bar choice so seeking back replays the same choreography. */
function pickMove(barIndex: number, intensity: number): Move {
  const eligible = MOVES.filter((m) => intensity >= m.min && intensity < m.max);
  const pool = eligible.length > 0 ? eligible : [MOVES[0]];
  return pool[hash(barIndex) % pool.length];
}

function hash(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
