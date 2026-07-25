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
export class AudioSession {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));

  /** Context time at which playback position 0 would have occurred. */
  private originTime = 0;
  private pausedAt = 0;
  private playing = false;

  analysis: AnalysisResult | null = null;
  onEnded: (() => void) | null = null;

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
    this.stop();
    onProgress({ value: 0.02, stage: 'Decoding' });

    const bytes = await file.arrayBuffer();
    const ctx = this.ensureContext();
    // decodeAudioData detaches the buffer, so hand it a copy we own.
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    this.buffer = buffer;

    onProgress({ value: 0.12, stage: 'Preparing' });
    const mono = await downmix(buffer);

    this.analysis = await runAnalyzer(mono, ANALYSIS_RATE, (p) =>
      onProgress({ value: 0.12 + p.value * 0.88, stage: p.stage }),
    );

    this.pausedAt = 0;
  }

  play(): void {
    const ctx = this.ensureContext();
    if (!this.buffer || this.playing) return;
    void ctx.resume();

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;

    const gain = this.gain ?? ctx.createGain();
    const analyser = this.analyserNode ?? ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    if (this.freqData.length !== analyser.frequencyBinCount) {
      this.freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(ctx.destination);

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
    this.gain = gain;
    this.analyserNode = analyser;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.time;
    this.stopSource();
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.duration, seconds));
    const wasPlaying = this.playing;
    this.stopSource();
    this.playing = false;
    this.pausedAt = target;
    if (wasPlaying) this.play();
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
    this.ctx ??= new AudioContext({ latencyHint: 'playback' });
    return this.ctx;
  }
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
