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

export interface PoseMeta {
  /** Roughly where her centre of mass sits, 0 = deep crouch, 2 = peak of a jump. */
  height: number;
  /** -1 fully turned away, 0 square to camera, +1 turned the other way. */
  facing: number;
  /** Feet off the floor. */
  airborne: boolean;
  /** How much the pose is "doing", used to spot abrupt energy drops. */
  effort: number;
  /** A pose that can absorb a landing. */
  absorbs: boolean;
}

/**
 * Just enough about each drawing to reason about the gap between any two of
 * them. Twelve poses is small enough that this table beats any general
 * animation system — and it drives both transition typing and the check for
 * whether two bars can be stitched together.
 */
export const POSE_META: Record<number, PoseMeta> = {
  [POSE.NEUTRAL]: { height: 1.0, facing: 0.0, airborne: false, effort: 0.1, absorbs: true },
  [POSE.ARM_OUT]: { height: 1.0, facing: 0.3, airborne: false, effort: 0.35, absorbs: true },
  [POSE.ARMS_UP]: { height: 1.35, facing: 0.0, airborne: false, effort: 0.8, absorbs: false },
  [POSE.SWEEP]: { height: 0.9, facing: -0.35, airborne: false, effort: 0.5, absorbs: true },
  [POSE.POINT_LEFT]: { height: 1.0, facing: -0.6, airborne: false, effort: 0.5, absorbs: false },
  [POSE.SPIN_BACK]: { height: 1.05, facing: -1.0, airborne: true, effort: 0.75, absorbs: false },
  [POSE.SPIN_FRONT]: { height: 1.05, facing: 1.0, airborne: true, effort: 0.75, absorbs: false },
  [POSE.WIDE]: { height: 0.8, facing: 0.0, airborne: false, effort: 0.4, absorbs: true },
  [POSE.CROUCH]: { height: 0.35, facing: 0.0, airborne: false, effort: 0.55, absorbs: true },
  [POSE.JUMP]: { height: 1.9, facing: 0.0, airborne: true, effort: 1.0, absorbs: false },
  [POSE.LAND]: { height: 0.7, facing: 0.3, airborne: false, effort: 0.6, absorbs: true },
  [POSE.DRIFT]: { height: 1.0, facing: 0.0, airborne: false, effort: 0.2, absorbs: true },
};

export function meta(pose: number): PoseMeta {
  return POSE_META[pose] ?? POSE_META[POSE.NEUTRAL];
}

/**
 * How a cut between two drawings should be sold. Deriving this from the pose
 * table covers all 144 edges without a hand-written entry for each; the
 * override table only exists for edges where the derived answer is wrong.
 */
export type TransitionKind = 'rise' | 'drop' | 'turn' | 'gesture' | 'recover' | 'neutral';

const OVERRIDES: Record<string, TransitionKind> = {
  // The spin pair is a turn even though both poses are airborne and level.
  [`${POSE.SPIN_BACK}:${POSE.SPIN_FRONT}`]: 'turn',
  [`${POSE.SPIN_FRONT}:${POSE.SPIN_BACK}`]: 'turn',
  // Coming out of a landing is a recovery, not another gesture.
  [`${POSE.LAND}:${POSE.DRIFT}`]: 'recover',
  [`${POSE.LAND}:${POSE.NEUTRAL}`]: 'recover',
  // A crouch before a jump is the anticipation itself; keep it as a rise so
  // the compression reads as loading rather than as a separate drop.
  [`${POSE.CROUCH}:${POSE.JUMP}`]: 'rise',
};

export function transitionKind(from: number, to: number): TransitionKind {
  const override = OVERRIDES[`${from}:${to}`];
  if (override) return override;

  const a = meta(from);
  const b = meta(to);

  if (Math.abs(b.facing - a.facing) > 0.9) return 'turn';
  if (b.airborne && !a.airborne) return 'rise';
  if (a.airborne && !b.airborne) return 'drop';
  if (b.height > a.height + 0.3) return 'rise';
  if (b.height < a.height - 0.3) return 'drop';
  if (a.effort > b.effort + 0.3) return 'recover';
  if (Math.abs(b.facing - a.facing) > 0.25 || Math.abs(b.effort - a.effort) > 0.2) return 'gesture';
  return 'neutral';
}

/**
 * Motion applied around a cut. `pre` values ramp in as the cut approaches and
 * `post` values ramp out after it, which is what makes a swapped drawing read
 * as a continuation of momentum rather than a new event.
 *
 * lift is in stage units, lean in radians; squash and stretchX are multipliers
 * around 1 (squash > 1 is taller and narrower).
 */
export interface TransitionRecipe {
  preLift: number;
  preSquash: number;
  preLean: number;
  preStretchX: number;
  postLift: number;
  postSquash: number;
  postLean: number;
  postStretchX: number;
  /** How much afterimage this kind wants, 0..1. */
  ghost: number;
}

export const RECIPES: Record<TransitionKind, TransitionRecipe> = {
  // Load down into the floor, then launch.
  rise: {
    preLift: -0.055, preSquash: -0.10, preLean: -0.02, preStretchX: 0.05,
    postLift: 0.15, postSquash: 0.08, postLean: 0.01, postStretchX: -0.04,
    ghost: 0.9,
  },
  // Hang a moment, then hit the floor hard and rebound.
  drop: {
    preLift: 0.035, preSquash: 0.06, preLean: 0.0, preStretchX: -0.03,
    postLift: -0.075, postSquash: -0.16, postLean: 0.0, postStretchX: 0.09,
    ghost: 1.0,
  },
  // Lean into the rotation, narrow through it, stretch out of it.
  turn: {
    preLift: 0.01, preSquash: 0.0, preLean: 0.055, preStretchX: -0.10,
    postLift: 0.015, postSquash: 0.0, postLean: 0.045, postStretchX: 0.11,
    ghost: 1.0,
  },
  // Wind up against the coming sweep, then overshoot past it.
  gesture: {
    preLift: -0.012, preSquash: -0.02, preLean: -0.045, preStretchX: 0.0,
    postLift: 0.018, postSquash: 0.02, postLean: 0.06, postStretchX: 0.0,
    ghost: 0.35,
  },
  // Let the energy out rather than starting something new.
  recover: {
    preLift: 0.008, preSquash: 0.0, preLean: 0.0, preStretchX: 0.0,
    postLift: -0.022, postSquash: -0.05, postLean: -0.02, postStretchX: 0.03,
    ghost: 0.2,
  },
  neutral: {
    preLift: -0.006, preSquash: -0.01, preLean: -0.012, preStretchX: 0.0,
    postLift: 0.010, postSquash: 0.015, postLean: 0.018, postStretchX: 0.0,
    ghost: 0.0,
  },
};

/**
 * Cost of stitching one bar's last drawing to the next bar's first. Only ever
 * evaluated at bar boundaries — the edges inside a move are curated by hand.
 * Lower is better.
 */
export function transitionCost(from: number, to: number): number {
  const a = meta(from);
  const b = meta(to);
  let cost = 0;

  // A big vertical gap with no drawing in between reads as a teleport.
  cost += Math.abs(b.height - a.height) * 1.6;

  // Coming out of the air has to land on something that can take the weight.
  if (a.airborne && !b.absorbs) cost += 2.6;

  // Turned away from camera into an unrelated square-on pose.
  if (Math.abs(a.facing) > 0.8 && Math.abs(b.facing - a.facing) > 0.9 && !b.airborne) cost += 1.8;

  // Dropping all the way out of a committed pose looks like a dropped frame.
  if (a.effort - b.effort > 0.45) cost += 1.2;

  // Two airborne poses back to back with no contact between them.
  if (a.airborne && b.airborne) cost += 1.4;

  return cost;
}
