/**
 * Local performance capture.
 *
 * The stage canvas and the audio graph are muxed together by MediaRecorder and
 * handed straight back to the user as a file. Nothing is uploaded and nothing
 * is transcoded on a server — the recording never leaves the tab, which is the
 * same promise the rest of the app makes about the track itself.
 */

/** Preferred first; the browser picks the first one it can actually mux. */
const CANDIDATE_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm',
];

const DEFAULT_FPS = 30;
/** Bits per pixel per second — enough for flat cel art without bloating files. */
const BITS_PER_PIXEL = 0.1;
const MAX_VIDEO_BITRATE = 12_000_000;
const MIN_VIDEO_BITRATE = 2_500_000;

export interface Recording {
  blob: Blob;
  durationMs: number;
}

/** The best container/codec pair this browser will mux, or null if none. */
export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    pickMimeType() !== null
  );
}

/**
 * Turn a track's name into the download filename.
 *
 * Pure and separately tested — it is the one part of the export the user
 * actually sees, and it has to cope with whatever a file is called.
 */
export function exportFileName(trackLabel: string): string {
  const withoutExtension = trackLabel.replace(/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i, '');
  const slug = withoutExtension
    .normalize('NFKD')
    // Strip combining marks so accented names transliterate rather than vanish.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

  return `${slug || 'performance'}-stagelight.webm`;
}

export class PerformanceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private videoStream: MediaStream | null = null;
  private startedAt = 0;
  private stoppedAt = 0;

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  /** Milliseconds captured so far, for the on-screen counter. */
  get elapsedMs(): number {
    if (!this.startedAt) return 0;
    return (this.isRecording ? performance.now() : this.stoppedAt) - this.startedAt;
  }

  start(canvas: HTMLCanvasElement, audio: MediaStream, fps = DEFAULT_FPS): void {
    if (this.isRecording) return;

    const mimeType = pickMimeType();
    if (!mimeType) throw new Error('This browser cannot record video.');

    this.videoStream = canvas.captureStream(fps);
    const combined = new MediaStream([
      ...this.videoStream.getVideoTracks(),
      ...audio.getAudioTracks(),
    ]);

    const pixels = canvas.width * canvas.height;
    const videoBitsPerSecond = Math.round(
      Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, pixels * fps * BITS_PER_PIXEL)),
    );

    this.chunks = [];
    this.recorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond,
      audioBitsPerSecond: 192_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    // A timeslice means a crash or a closed tab still leaves usable chunks
    // rather than one buffer that is never flushed.
    this.recorder.start(1000);
    this.startedAt = performance.now();
    this.stoppedAt = 0;
  }

  stop(): Promise<Recording> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      return Promise.reject(new Error('Not recording.'));
    }

    return new Promise<Recording>((resolve, reject) => {
      recorder.onstop = () => {
        this.stoppedAt = performance.now();
        this.releaseVideo();
        const blob = new Blob(this.chunks, { type: recorder.mimeType });
        this.chunks = [];
        this.recorder = null;
        if (blob.size === 0) {
          reject(new Error('Nothing was captured. Try recording for a little longer.'));
          return;
        }
        resolve({ blob, durationMs: this.stoppedAt - this.startedAt });
      };
      recorder.onerror = () => {
        this.releaseVideo();
        this.recorder = null;
        reject(new Error('Recording failed.'));
      };
      recorder.stop();
    });
  }

  /** Abandon a recording without producing a file. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      this.recorder.stop();
    }
    this.releaseVideo();
    this.recorder = null;
    this.chunks = [];
  }

  private releaseVideo() {
    this.videoStream?.getTracks().forEach((t) => t.stop());
    this.videoStream = null;
  }
}

/** Hand a finished recording to the user as a download. */
export function saveRecording(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari needs the URL to outlive the click; a minute is far more than enough.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
