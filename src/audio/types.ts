/** Frequency bands sampled once per analysis frame, normalised to roughly 0..1. */
export interface BandTrack {
  /** ~20-160 Hz — kick and sub. */
  bass: Float32Array;
  /** ~160-800 Hz — body, snare fundamentals. */
  lowMid: Float32Array;
  /** ~800-3500 Hz — vocals, leads. */
  mid: Float32Array;
  /** 3.5 kHz+ — hats, air. */
  high: Float32Array;
  /** Broadband loudness. */
  level: Float32Array;
}

export interface AnalysisResult {
  duration: number;
  /** Estimated global tempo. */
  bpm: number;
  /** Beat times in seconds, tracked with drift tolerance. */
  beats: Float32Array;
  /** Subset of `beats` judged to start a bar. */
  downbeats: Float32Array;
  /** Per-beat intensity 0..1, used to pick choreography. */
  beatEnergy: Float32Array;
  /** Onset strength envelope. */
  onset: Float32Array;
  /** Frames per second of `onset` and every BandTrack array. */
  frameRate: number;
  bands: BandTrack;
  /** True when tempo tracking was too weak to trust; the stage falls back to free-running motion. */
  weak: boolean;
}

export type AnalyzerRequest = {
  samples: Float32Array;
  sampleRate: number;
};

export type AnalyzerResponse =
  | { type: 'progress'; value: number; stage: string }
  | { type: 'done'; result: AnalysisResult }
  | { type: 'error'; message: string };
