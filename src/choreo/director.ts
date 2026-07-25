import type { AnalysisResult } from '../audio/types';
import { POSE, RECIPES, meta, transitionCost, transitionKind, type TransitionKind } from './poses';

export { POSE } from './poses';
export type { TransitionKind } from './poses';

interface Move {
  name: string;
  /** One pose per step; the bar is divided evenly between them. */
  frames: number[];
  /** Intensity window this move is eligible for. */
  min: number;
  max: number;
}

const MOVES: Move[] = [
  { name: 'sway', frames: [POSE.NEUTRAL, POSE.ARM_OUT, POSE.DRIFT, POSE.SWEEP], min: 0, max: 0.42 },
  { name: 'lull', frames: [POSE.DRIFT, POSE.NEUTRAL, POSE.SWEEP, POSE.ARM_OUT], min: 0, max: 0.35 },
  { name: 'step', frames: [POSE.ARM_OUT, POSE.POINT_LEFT, POSE.SWEEP, POSE.WIDE], min: 0.22, max: 0.72 },
  { name: 'bounce', frames: [POSE.CROUCH, POSE.DRIFT, POSE.CROUCH, POSE.SWEEP], min: 0.28, max: 0.75 },
  { name: 'turn', frames: [POSE.ARM_OUT, POSE.SPIN_BACK, POSE.SPIN_FRONT, POSE.LAND], min: 0.4, max: 0.9 },
  {
    name: 'double',
    frames: [POSE.ARM_OUT, POSE.WIDE, POSE.POINT_LEFT, POSE.SWEEP, POSE.CROUCH, POSE.DRIFT, POSE.ARMS_UP, POSE.LAND],
    min: 0.55,
    max: 1.01,
  },
  { name: 'hype', frames: [POSE.ARMS_UP, POSE.CROUCH, POSE.JUMP, POSE.LAND], min: 0.62, max: 1.01 },
  {
    name: 'drop',
    frames: [POSE.CROUCH, POSE.JUMP, POSE.LAND, POSE.ARMS_UP, POSE.SPIN_BACK, POSE.SPIN_FRONT, POSE.WIDE, POSE.ARMS_UP],
    min: 0.78,
    max: 1.01,
  },
];

const BEATS_PER_BAR = 4;

/**
 * The drawing changes this far in beats *before* the nominal step boundary.
 * Small on purpose: the cut should still read as landing on the beat, but
 * arriving a touch early leaves the settle overshoot straddling it, so the
 * impact — not the swap — is what coincides with the transient.
 */
const CUT_LEAD_BEATS = 0.1;
/** How long before the cut the body starts preparing for it. */
const ANTICIPATE_BEATS = 0.34;
/** How long after the cut the overshoot takes to resolve. */
const SETTLE_BEATS = 0.3;
/** Afterimages only appear once a track is actually driving. */
const GHOST_INTENSITY_GATE = 0.5;
/** Afterimage lifetime in seconds — a couple of frames at 30fps, no more. */
const GHOST_SECONDS = 0.08;
/**
 * ...and never more than this share of the step it belongs to. On an eight-step
 * bar at speed, a fixed 80ms smear would cover a third of every pose and start
 * reading as a permanent double rather than an accent.
 */
const GHOST_MAX_STEP_FRACTION = 0.22;

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

export interface DanceState {
  /** Atlas frame to display. */
  frame: number;
  /** The drawing being cut away from, held briefly as an afterimage. */
  ghostFrame: number;
  /** Afterimage strength, 0..1. Zero for everything but hard, fast cuts. */
  ghostAmount: number;
  /** Where to offset the afterimage, opposite the direction of travel. */
  ghostOffsetX: number;
  ghostOffsetY: number;
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
  /** Horizontal stretch multiplier around 1, independent of squash. */
  stretchX: number;
  /** Smoothed arrangement intensity, 0..1. */
  intensity: number;
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  level: number;
  bpm: number;
  moveName: string;
  /** How the current cut is being sold. */
  transition: TransitionKind;
  /** True when the beat grid is not trustworthy and motion is free-running. */
  freeRunning: boolean;
  /** True when nothing is playing: she waits rather than dances, and the rig rests. */
  idle: boolean;
}

export class Director {
  private analysis: AnalysisResult | null = null;
  private beatCursor = 0;
  private smoothedIntensity = 0;
  private smoothedBands = { bass: 0, lowMid: 0, mid: 0, high: 0, level: 0 };

  /**
   * One move per bar, built forward from the first. Planning ahead rather than
   * choosing per frame is what lets a cut know which drawing comes next — and
   * makes the whole routine a pure function of the analysis, so seeking back
   * replays exactly what you saw the first time.
   */
  private plan: Move[] = [];

  setAnalysis(analysis: AnalysisResult | null) {
    this.analysis = analysis;
    this.beatCursor = 0;
    this.smoothedIntensity = 0;
    this.plan = [];
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

    const beatPos = this.beatPosition(time);
    const beatDuration = this.beatDurationAt(beatPos);

    const beatIndex = Math.floor(beatPos);
    const beatPhase = clamp01(beatPos - beatIndex);
    const beatInBar = ((beatIndex % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    const barPhase = (beatInBar + beatPhase) / BEATS_PER_BAR;

    // Intensity leads the arrangement slightly so a build lands with the drop.
    const target = a.beatEnergy[Math.min(a.beatEnergy.length - 1, beatIndex + 1)] ?? 0;
    this.smoothedIntensity += (target - this.smoothedIntensity) * Math.min(1, dt * 2.2);
    const intensity = clamp01(this.smoothedIntensity * 0.75 + bands.level * 0.25);

    const cut = this.locate(beatPos);
    const motion = this.transitionMotion(cut, intensity, beatDuration);

    const beatPulse = Math.pow(1 - beatPhase, 2.6);
    const barPulse = Math.pow(1 - barPhase, 3.2);
    const body = this.bodyMotion(cut, beatPulse, intensity, time, bands);

    return {
      frame: cut.displayed,
      ghostFrame: cut.previous,
      ...motion.ghost,
      beatPhase,
      barPhase,
      beatPulse,
      barPulse,
      lift: body.lift + motion.lift,
      sway: body.sway,
      lean: body.lean + motion.lean,
      squash: body.squash * motion.squash,
      stretchX: motion.stretchX,
      intensity,
      ...bands,
      bpm: a.bpm,
      moveName: cut.moveName,
      transition: cut.kind,
      freeRunning,
      idle: false,
    };
  }

  /* ------------------------------------------------------------ planning */

  /** Average arrangement energy over a bar, the basis for choosing its move. */
  private barEnergy(barIndex: number): number {
    const a = this.analysis;
    if (!a || a.beatEnergy.length === 0) {
      // Free-running: a slow deterministic swell, so the routine still varies.
      return 0.3 + 0.18 * Math.sin(barIndex * 0.7);
    }
    let sum = 0;
    let count = 0;
    for (let i = 0; i < BEATS_PER_BAR; i++) {
      const beat = barIndex * BEATS_PER_BAR + i;
      if (beat >= a.beatEnergy.length) break;
      sum += a.beatEnergy[beat];
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  /** Extend the plan so that `barIndex` and its immediate neighbours exist. */
  private ensurePlan(barIndex: number) {
    const needed = Math.max(0, barIndex) + 2;
    for (let bar = this.plan.length; bar < needed; bar++) {
      this.plan.push(this.chooseMove(bar));
    }
  }

  /**
   * Pick the bar's move with the previous bar's closing pose in hand.
   *
   * Every move's internal sequence is curated, but the seam between two
   * independently chosen bars was not: one bar could end mid-air on LAND and
   * the next open on a calm ARM_OUT. Scoring candidates by that seam removes
   * bad cuts before they are ever drawn, which is worth more than smoothing
   * them afterwards.
   */
  private chooseMove(barIndex: number): Move {
    const energy = this.barEnergy(barIndex);
    const eligible = MOVES.filter((m) => energy >= m.min && energy < m.max);
    const pool = eligible.length > 0 ? eligible : [MOVES[0]];
    if (barIndex === 0) return pool[hash(0) % pool.length];

    const previous = this.plan[barIndex - 1];
    const previousFrame = previous.frames[previous.frames.length - 1];

    let best = pool[0];
    let bestScore = Infinity;
    for (const candidate of pool) {
      let score = transitionCost(previousFrame, candidate.frames[0]);
      // Discourage, without forbidding, running the same routine twice.
      if (candidate.name === previous.name) score += 1.5;
      // Deterministic jitter keeps the choice varied while staying seek-stable.
      score += (hash(barIndex * 31 + nameSeed(candidate.name)) % 1000) / 1000;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ cut geometry */

  /**
   * Work out which drawing is on screen, which it replaced, which is coming,
   * and how far we are either side of the cut — all in beats, so a bar of
   * eight half-beat steps behaves the same as one of four whole-beat steps.
   */
  private locate(beatPos: number) {
    // Shifting time forward by the lead puts every cut exactly on a step
    // boundary, which removes a pile of edge cases around bar seams.
    const shifted = Math.max(0, beatPos + CUT_LEAD_BEATS);
    const bar = Math.floor(shifted / BEATS_PER_BAR);
    this.ensurePlan(bar);

    const move = this.plan[bar];
    const steps = move.frames.length;
    const stepLen = BEATS_PER_BAR / steps;
    const within = shifted - bar * BEATS_PER_BAR;
    const step = Math.min(steps - 1, Math.max(0, Math.floor(within / stepLen)));

    const displayed = move.frames[step];
    const previous =
      step > 0 ? move.frames[step - 1] : bar > 0 ? lastFrame(this.plan[bar - 1]) : displayed;
    const upcoming =
      step + 1 < steps ? move.frames[step + 1] : this.plan[bar + 1]?.frames[0] ?? displayed;

    return {
      displayed,
      previous,
      upcoming,
      moveName: move.name,
      stepLen,
      /** Beats elapsed since the drawing changed. */
      sinceCut: within - step * stepLen,
      /** Beats remaining until it changes again. */
      toCut: (step + 1) * stepLen - within,
      /** How the cut that just happened should be sold. */
      kind: transitionKind(previous, displayed),
      /** How the cut that is coming should be prepared for. */
      nextKind: transitionKind(displayed, upcoming),
    };
  }

  /* ------------------------------------------------------------ motion */

  /**
   * Anticipation before the cut and settlement after it. This is the whole
   * point of the exercise: without it a pose swap is an event that motion
   * follows, and with it the body is already moving when the drawing catches up.
   */
  private transitionMotion(
    cut: ReturnType<Director['locate']>,
    intensity: number,
    beatDuration: number,
  ) {
    const amp = 0.45 + intensity * 0.55;
    // Windows never exceed the step they belong to, or a bar of eighths would
    // be entirely anticipation and overshoot with no hold left between them.
    const anticipateWindow = Math.min(ANTICIPATE_BEATS, cut.stepLen * 0.45);
    const settleWindow = Math.min(SETTLE_BEATS, cut.stepLen * 0.45);

    const anticipation = smoothstep(1 - clamp01(cut.toCut / anticipateWindow));
    const settlement = smoothstep(1 - clamp01(cut.sinceCut / settleWindow));

    const pre = RECIPES[cut.nextKind];
    const post = RECIPES[cut.kind];

    // Lean into the turn in whichever direction the turn is going.
    const preDir = Math.sign(meta(cut.upcoming).facing - meta(cut.displayed).facing) || 1;
    const postDir = Math.sign(meta(cut.displayed).facing - meta(cut.previous).facing) || 1;

    // A rise into a pose whose feet are still planted — ARMS_UP, say — must
    // read as reaching upward, not as floating. Grounded poses keep only a
    // little of the lift and take the rest as vertical stretch.
    const grounded = !meta(cut.displayed).airborne;
    const liftScale = grounded ? 0.3 : 1;
    const stretchBonus = grounded && post.postLift > 0 ? post.postLift * 0.45 : 0;

    const lift =
      pre.preLift * anticipation * amp + post.postLift * liftScale * settlement * amp;
    const lean =
      pre.preLean * preDir * anticipation * amp + post.postLean * postDir * settlement * amp;
    const squash =
      1 +
      pre.preSquash * anticipation * amp +
      (post.postSquash + stretchBonus) * settlement * amp;
    const stretchX =
      1 + pre.preStretchX * anticipation * amp + post.postStretchX * settlement * amp;

    return { lift, lean, squash, stretchX, ghost: this.ghost(cut, intensity, beatDuration, postDir) };
  }

  /**
   * A brief hold of the outgoing drawing, offset against the motion.
   *
   * Deliberately not a crossfade: dissolving two drawings of the same character
   * produces four arms and two heads. Holding the old frame behind the new one
   * for a couple of frames reads as speed instead.
   */
  private ghost(
    cut: ReturnType<Director['locate']>,
    intensity: number,
    beatDuration: number,
    direction: number,
  ) {
    const recipe = RECIPES[cut.kind];
    if (recipe.ghost <= 0 || intensity < GHOST_INTENSITY_GATE) {
      return { ghostAmount: 0, ghostOffsetX: 0, ghostOffsetY: 0 };
    }

    const secondsSinceCut = cut.sinceCut * beatDuration;
    const stepSeconds = cut.stepLen * beatDuration;
    const lifetime = Math.min(GHOST_SECONDS, stepSeconds * GHOST_MAX_STEP_FRACTION);
    const life = 1 - clamp01(secondsSinceCut / lifetime);
    if (life <= 0) return { ghostAmount: 0, ghostOffsetX: 0, ghostOffsetY: 0 };

    const strength = life * life * recipe.ghost * clamp01((intensity - GHOST_INTENSITY_GATE) * 2.4);
    const rise = meta(cut.displayed).height - meta(cut.previous).height;

    return {
      ghostAmount: strength,
      // Trailing behind the movement, so it reads as a smear rather than a twin.
      ghostOffsetX: -direction * 0.09 * strength,
      ghostOffsetY: -Math.sign(rise) * 0.11 * strength,
    };
  }

  /**
   * The per-pose layer underneath the transitions: the arc through a held
   * drawing, the kick pushing her into the floor, and the slow drift that keeps
   * a static shot alive.
   */
  private bodyMotion(
    cut: ReturnType<Director['locate']>,
    beatPulse: number,
    intensity: number,
    time: number,
    bands: { bass: number },
  ) {
    const amp = 0.35 + intensity * 0.65;
    const frame = cut.displayed;
    const info = meta(frame);
    // Phase through the drawing's own hold, which now starts at the cut —
    // slightly ahead of the beat rather than on it.
    const phase = clamp01(cut.sinceCut / cut.stepLen);
    const arc = Math.sin(Math.PI * phase);

    let lift = arc * 0.05 * amp;
    if (info.airborne) lift += arc * 0.3 * amp + 0.045;
    if (info.height < 0.75) lift -= (1 - arc) * 0.045 * amp;

    const impact = beatPulse * (0.5 + bands.bass * 0.5);
    lift -= impact * 0.04 * amp;

    const squash = 1 + impact * 0.07 * amp + (info.airborne ? 0.03 * amp : 0);
    const sway = Math.sin(time * 0.9) * 0.05 * amp + Math.sin(time * 2.1) * 0.02 * amp;
    const lean = Math.sin(time * 1.15) * 0.04 * amp + info.facing * 0.04;

    return { lift, sway, lean, squash };
  }

  /* ------------------------------------------------------------ waiting */

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
    let index = 0;
    let phase = 0;
    for (let i = 0; i < IDLE_LOOP.length; i++) {
      if (t < elapsed + IDLE_LOOP[i].hold) {
        index = i;
        phase = (t - elapsed) / IDLE_LOOP[i].hold;
        break;
      }
      elapsed += IDLE_LOOP[i].hold;
    }

    const step = IDLE_LOOP[index];
    const previous = IDLE_LOOP[(index - 1 + IDLE_LOOP.length) % IDLE_LOOP.length].frame;
    // A weight shift over the first moments of each pose, then stillness.
    const settle = Math.sin(Math.PI * Math.min(1, phase * 3.5));
    const breath = Math.sin(time * 1.35);

    return {
      frame: step.frame,
      ghostFrame: previous,
      ghostAmount: 0,
      ghostOffsetX: 0,
      ghostOffsetY: 0,
      beatPhase: phase,
      barPhase: t / IDLE_PERIOD,
      beatPulse: 0,
      barPulse: 0,
      lift: breath * 0.014 + settle * 0.02,
      sway: Math.sin(time * 0.41) * 0.036 + Math.sin(time * 0.77) * 0.012,
      lean: Math.sin(time * 0.29) * 0.022 + settle * 0.012,
      squash: 1 + breath * 0.013,
      stretchX: 1,
      intensity: 0.1,
      ...bands,
      bpm: FALLBACK_BPM,
      moveName: 'waiting',
      transition: 'neutral',
      freeRunning: true,
      idle: true,
    };
  }

  /* ------------------------------------------------------------ timing */

  /** Playback time as a fractional beat index, interpolating within each beat. */
  private beatPosition(time: number): number {
    const a = this.analysis;
    if (!a || a.beats.length < 2) {
      return Math.max(0, time) / (60 / (a?.bpm || FALLBACK_BPM));
    }
    const i = this.findBeat(a.beats, time);
    const start = a.beats[i];
    const end = i + 1 < a.beats.length ? a.beats[i + 1] : start + 60 / a.bpm;
    const span = Math.max(1e-4, end - start);
    // Past the last beat, keep extrapolating so the routine does not freeze.
    return i + (time - start) / span;
  }

  private beatDurationAt(beatPos: number): number {
    const a = this.analysis;
    if (!a || a.beats.length < 2) return 60 / (a?.bpm || FALLBACK_BPM);
    const i = Math.max(0, Math.min(a.beats.length - 2, Math.floor(beatPos)));
    return Math.max(1e-3, a.beats[i + 1] - a.beats[i]);
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
}

function lastFrame(move: Move): number {
  return move.frames[move.frames.length - 1];
}

function nameSeed(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return h >>> 0;
}

function hash(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Hermite ease, so anticipation and settlement start and end without a corner. */
function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
