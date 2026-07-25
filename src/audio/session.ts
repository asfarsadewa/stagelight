import AnalyzerWorker from './analyzer.worker?worker';
import type { AnalysisResult, AnalyzerResponse } from './types';

/** Analysis runs on a mono downmix at this rate — plenty for onset detection. */
const ANALYSIS_RATE = 22050;

export interface LoadProgress {
  value: number;
  stage: string;
}

/**
 * Owns the decoded track and the playback clock.
 *
 * Everything lives in memory for the lifetime of the tab: the file is never
 * uploaded, never written to storage, and `dispose()` drops the last reference.
 */
/** Injectable so the playback state machine can be tested without a real one. */
export type AudioContextFactory = () => AudioContext;

/**
 * Read through a call so TypeScript cannot narrow the state across an `await`.
 * `resume()` is precisely what changes it, and iOS additionally reports
 * `interrupted`, which is neither running nor recoverable by ignoring it.
 */
function isRunning(ctx: AudioContext): boolean {
  return ctx.state === 'running';
}

export class AudioSession {
  constructor(
    private readonly createContext: AudioContextFactory = () =>
      new AudioContext({ latencyHint: 'playback' }),
  ) {}

  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private recordDestination: MediaStreamAudioDestinationNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));

  /** Context time at which playback position 0 would have occurred. */
  private originTime = 0;
  private pausedAt = 0;
  private playing = false;

  analysis: AnalysisResult | null = null;
  onEnded: (() => void) | null = null;
  /** Fires whenever the underlying context changes state, for diagnostics. */
  onStateChange: ((state: AudioContextState) => void) | null = null;

  get contextState(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Current playback position in seconds. */
  get time(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    return Math.min(this.duration, this.ctx.currentTime - this.originTime);
  }

  async load(file: File, onProgress: (p: LoadProgress) => void): Promise<void> {
    // Keep the context: stop() would only clear the track, but tearing the
    // context down here would throw away an unlock we may not get again.
    this.stop();
    onProgress({ value: 0.02, stage: 'Decoding' });

    const bytes = await file.arrayBuffer();
    const ctx = this.ensureContext();

    let buffer: AudioBuffer;
    try {
      // decodeAudioData detaches the buffer, so hand it a copy we own.
      buffer = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      // The platform decoder's own message is just "Unable to decode audio
      // data", which does not hint at the usual cause: a container this
      // browser opens fine holding a codec it cannot read. Apple Lossless in
      // an .m4a is the common one — Safari decodes it, nothing else does.
      throw new Error(
        'Your browser could not decode that file. MP3, WAV, AAC and OGG all work; Apple Lossless does not, outside Safari.',
      );
    }
    onProgress({ value: 0.12, stage: 'Preparing' });
    const mono = await downmix(buffer);

    const analysis = await runAnalyzer(mono, ANALYSIS_RATE, (p) =>
      onProgress({ value: 0.12 + p.value * 0.88, stage: p.stage }),
    );

    this.adopt(buffer, analysis);
  }

  /**
   * Create and resume the context from inside a user gesture.
   *
   * This has to be called synchronously from the click or drop, before any
   * await. Loading a track is a long asynchronous errand — fetch, decode,
   * downmix, analyse — and by the time it finishes the activation that
   * authorised audio is long gone. iOS in particular will then leave the
   * context suspended, and a suspended context produces silence while every
   * other part of the app carries on as though it were playing.
   */
  async unlock(): Promise<boolean> {
    const ctx = this.ensureContext();
    if (!isRunning(ctx)) {
      try {
        await ctx.resume();
      } catch {
        // Declined; the caller decides what to tell the user.
      }
    }
    return isRunning(ctx);
  }

  /**
   * @returns whether sound is actually coming out. Never reports true on a
   *          context that failed to start — the transport, the clock and the
   *          choreography all key off this, and a lie here is exactly the bug
   *          where the timer runs on in silence.
   */
  async play(): Promise<boolean> {
    const ctx = this.ensureContext();
    if (!this.buffer || this.playing) return this.playing;

    // Only awaits when it has to, so a seek during playback stays tight.
    if (!isRunning(ctx)) {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
      // Superseded while suspended: a stop or another play won the race.
      if (!this.buffer || this.playing) return this.playing;
    }
    if (!isRunning(ctx)) return false;

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;

    const { gain } = this.ensureGraph();
    source.connect(gain);

    const offset = this.pausedAt >= this.duration - 0.05 ? 0 : this.pausedAt;
    source.start(0, offset);
    this.originTime = ctx.currentTime - offset;

    source.onended = () => {
      if (this.source !== source) return; // superseded by a newer source
      this.playing = false;
      this.pausedAt = 0;
      this.source = null;
      this.onEnded?.();
    };

    this.source = source;
    this.playing = true;
    return true;
  }

  /**
   * Nudge a context that was interrupted while we believed we were playing —
   * a phone call, a lock, an app switch. Safe to call often.
   */
  async recover(): Promise<boolean> {
    const ctx = this.ctx;
    if (!this.playing || !ctx) return false;
    if (isRunning(ctx)) return true;
    try {
      await ctx.resume();
    } catch {
      return false;
    }
    return isRunning(ctx);
  }

  /**
   * Install an already-decoded track. Kept separate from decoding so playback
   * can be exercised without a decoder, worker or offline context.
   */
  adopt(buffer: AudioBuffer, analysis: AnalysisResult | null): void {
    this.buffer = buffer;
    this.analysis = analysis;
    this.pausedAt = 0;
  }

  /**
   * The graph downstream of the buffer source, built once and kept for the
   * life of the session. Sources come and go on every play and seek; the
   * analyser and any recording tap must not, or a recording would be cut off
   * the first time someone scrubs.
   */
  private ensureGraph(): { gain: GainNode; analyser: AnalyserNode } {
    const ctx = this.ensureContext();
    if (!this.gain || !this.analyserNode) {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      this.gain = gain;
      this.analyserNode = analyser;
      this.freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }
    return { gain: this.gain, analyser: this.analyserNode };
  }

  /**
   * A stream carrying exactly what reaches the speakers, for muxing into a
   * recording. Tapped off the analyser so it stays connected across seeks.
   */
  captureAudioStream(): MediaStream {
    const ctx = this.ensureContext();
    const { analyser } = this.ensureGraph();
    if (!this.recordDestination) {
      this.recordDestination = ctx.createMediaStreamDestination();
      analyser.connect(this.recordDestination);
    }
    return this.recordDestination.stream;
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.time;
    this.stopSource();
    this.playing = false;
  }

  async toggle(): Promise<boolean> {
    if (this.playing) {
      this.pause();
      return false;
    }
    return this.play();
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.duration, seconds));
    const wasPlaying = this.playing;
    this.stopSource();
    this.playing = false;
    this.pausedAt = target;
    if (wasPlaying) void this.play();
  }

  stop(): void {
    this.stopSource();
    this.playing = false;
    this.pausedAt = 0;
    this.buffer = null;
    this.analysis = null;
  }

  /** Live spectrum for the parts of the stage that react faster than the grid. */
  sampleSpectrum(): Uint8Array<ArrayBuffer> {
    if (this.analyserNode && this.playing) this.analyserNode.getByteFrequencyData(this.freqData);
    else this.freqData.fill(0);
    return this.freqData;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private stopSource() {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped — nothing to unwind.
    }
    source.disconnect();
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.createContext();
      // iOS can suspend or interrupt a context at any time — a call, a lock,
      // a route change. Watch for it so playback can be recovered rather than
      // silently continuing to claim it is running.
      this.ctx.addEventListener?.('statechange', this.handleStateChange);
    }
    return this.ctx;
  }

  private readonly handleStateChange = () => {
    this.onStateChange?.(this.ctx?.state ?? 'closed');
  };
}

/** Mono, resampled copy for analysis. Uses the platform resampler. */
async function downmix(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil((buffer.duration * ANALYSIS_RATE)));
  const offline = new OfflineAudioContext(1, length, ANALYSIS_RATE);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function runAnalyzer(
  samples: Float32Array,
  sampleRate: number,
  onProgress: (p: LoadProgress) => void,
): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new AnalyzerWorker();
    worker.onmessage = (e: MessageEvent<AnalyzerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress({ value: msg.value, stage: msg.stage });
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.result);
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Analysis failed'));
    };
    worker.postMessage({ samples, sampleRate }, [samples.buffer]);
  });
}
