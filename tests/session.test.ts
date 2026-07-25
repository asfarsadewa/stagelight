import { beforeEach, describe, expect, it } from 'vitest';
import { AudioSession } from '../src/audio/session';

/**
 * A stand-in for AudioContext covering only the playback path.
 *
 * The point of these tests is the state machine around `resume()`: a real
 * browser's user-activation and interruption behaviour cannot be reproduced
 * here, but the rule that matters can be — never report playing on a context
 * that is not running. That is the bug where the clock and the choreography
 * run on over silence.
 */
class FakeContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = { };
  /** Set to fail resume outright, as Safari may. */
  rejectResume = false;
  /** Set to leave the context suspended even though resume() succeeds. */
  refuseToRun = false;
  resumeCalls = 0;
  startedSources: FakeSource[] = [];
  private listeners: (() => void)[] = [];

  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.rejectResume) throw new Error('not allowed');
    if (!this.refuseToRun) this.setState('running');
  }

  suspendExternally(state: AudioContextState = 'suspended') {
    this.setState(state);
  }

  private setState(state: AudioContextState) {
    this.state = state;
    for (const l of this.listeners) l();
  }

  addEventListener(_type: string, listener: () => void) {
    this.listeners.push(listener);
  }

  createBufferSource() {
    const source = new FakeSource(this);
    return source;
  }
  createGain() {
    return { connect() {}, gain: { value: 1 } };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 512,
      connect() {},
      getByteFrequencyData() {},
    };
  }
  createMediaStreamDestination() {
    return { stream: {} };
  }
  async close() {}
}

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  offset = 0;
  constructor(private readonly ctx: FakeContext) {}
  connect() {}
  disconnect() {}
  start(_when: number, offset = 0) {
    this.started = true;
    this.offset = offset;
    this.ctx.startedSources.push(this);
  }
  stop() {
    this.stopped = true;
  }
}

const fakeBuffer = { duration: 120 } as unknown as AudioBuffer;

function makeSession() {
  const ctx = new FakeContext();
  const session = new AudioSession(() => ctx as unknown as AudioContext);
  return { ctx, session };
}

describe('AudioSession.unlock', () => {
  it('creates and resumes the context', async () => {
    const { ctx, session } = makeSession();
    expect(session.contextState).toBe('none');
    await expect(session.unlock()).resolves.toBe(true);
    expect(ctx.resumeCalls).toBe(1);
    expect(session.contextState).toBe('running');
  });

  it('reports failure when the browser declines', async () => {
    const { ctx, session } = makeSession();
    ctx.rejectResume = true;
    await expect(session.unlock()).resolves.toBe(false);
  });

  it('reports failure when resume succeeds but the context stays suspended', async () => {
    const { ctx, session } = makeSession();
    ctx.refuseToRun = true;
    await expect(session.unlock()).resolves.toBe(false);
  });

  it('does not resume a context that is already running', async () => {
    const { ctx, session } = makeSession();
    await session.unlock();
    await session.unlock();
    expect(ctx.resumeCalls).toBe(1);
  });
});

describe('AudioSession.play', () => {
  let ctx: FakeContext;
  let session: AudioSession;

  beforeEach(() => {
    ({ ctx, session } = makeSession());
    session.adopt(fakeBuffer, null);
  });

  it('starts and reports playing on a healthy context', async () => {
    await expect(session.play()).resolves.toBe(true);
    expect(session.isPlaying).toBe(true);
    expect(ctx.startedSources).toHaveLength(1);
  });

  it('never claims to be playing when resume is rejected', async () => {
    ctx.rejectResume = true;
    await expect(session.play()).resolves.toBe(false);
    expect(session.isPlaying).toBe(false);
    // The bug this guards: a source started into a dead context, with the
    // clock and choreography running over silence.
    expect(ctx.startedSources).toHaveLength(0);
  });

  it('never claims to be playing when the context stays suspended', async () => {
    ctx.refuseToRun = true;
    await expect(session.play()).resolves.toBe(false);
    expect(session.isPlaying).toBe(false);
    expect(ctx.startedSources).toHaveLength(0);
  });

  it('starts no source before the context is running', async () => {
    ctx.refuseToRun = true;
    await session.play();
    // Asserted here, not only at the end: without this the test passes even
    // when a source was started into the suspended context, because the second
    // call then short-circuits on `playing`.
    expect(ctx.startedSources).toHaveLength(0);

    ctx.refuseToRun = false;
    await session.play();
    expect(ctx.startedSources).toHaveLength(1);
    expect(session.isPlaying).toBe(true);
  });

  it('does nothing without a track', async () => {
    const bare = makeSession();
    await expect(bare.session.play()).resolves.toBe(false);
    expect(bare.ctx.startedSources).toHaveLength(0);
  });

  it('does not stack sources when called twice', async () => {
    await session.play();
    await session.play();
    expect(ctx.startedSources).toHaveLength(1);
  });

  it('resumes from where it was paused', async () => {
    await session.play();
    ctx.currentTime = 12;
    session.pause();
    await session.play();
    expect(ctx.startedSources[1].offset).toBeCloseTo(12, 3);
  });

  it('restarts from the top once the track has run out', async () => {
    await session.play();
    ctx.currentTime = 120;
    session.pause();
    await session.play();
    expect(ctx.startedSources[1].offset).toBe(0);
  });
});

describe('AudioSession.recover', () => {
  it('does nothing when not playing', async () => {
    const { session } = makeSession();
    session.adopt(fakeBuffer, null);
    await expect(session.recover()).resolves.toBe(false);
  });

  it('picks the context back up after an interruption', async () => {
    const { ctx, session } = makeSession();
    session.adopt(fakeBuffer, null);
    await session.play();

    ctx.suspendExternally('interrupted');
    expect(session.isPlaying).toBe(true); // we still intend to be playing

    await expect(session.recover()).resolves.toBe(true);
    expect(session.contextState).toBe('running');
  });

  it('reports failure when the context refuses to come back', async () => {
    const { ctx, session } = makeSession();
    session.adopt(fakeBuffer, null);
    await session.play();

    ctx.suspendExternally('suspended');
    ctx.refuseToRun = true;
    await expect(session.recover()).resolves.toBe(false);
  });

  it('does not start a second source while recovering', async () => {
    const { ctx, session } = makeSession();
    session.adopt(fakeBuffer, null);
    await session.play();
    ctx.suspendExternally('interrupted');
    await session.recover();
    await session.recover();
    expect(ctx.startedSources).toHaveLength(1);
  });
});

describe('AudioSession state reporting', () => {
  it('announces context state changes', async () => {
    const { ctx, session } = makeSession();
    const seen: string[] = [];
    session.onStateChange = (s) => seen.push(s);
    await session.unlock();
    ctx.suspendExternally('interrupted');
    expect(seen).toContain('running');
    expect(seen).toContain('interrupted');
  });

  it('holds the clock still while the context is not running', async () => {
    const { ctx, session } = makeSession();
    session.adopt(fakeBuffer, null);
    await session.play();
    ctx.currentTime = 5;
    const at = session.time;
    // A suspended context stops advancing currentTime, so the reported
    // position freezes rather than drifting away from the audio.
    ctx.suspendExternally();
    expect(session.time).toBeCloseTo(at, 6);
  });
});
