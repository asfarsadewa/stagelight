import './ui/styles.css';
import { AudioSession } from './audio/session';
import { Director } from './choreo/director';
import { Stage } from './stage/stage';
import { Chime } from './ui/chime';
import {
  PerformanceRecorder,
  exportFileName,
  isRecordingSupported,
  saveRecording,
} from './video/recorder';

const el = <T extends Element = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as unknown as T;
};

const canvas = el<HTMLCanvasElement>('stage');
const intake = el('intake');
const analysing = el('analysing');
const analysisBar = el('analysis-bar');
const analysisStage = el('analysis-stage');
const analysisName = el('analysis-name');
const intakeError = el('intake-error');
const transport = el('transport');
const playpause = el<HTMLButtonElement>('playpause');
const playpauseIcon = el<SVGPathElement>('playpause-icon');
const scrub = el('scrub');
const scrubFill = el('scrub-fill');
const elapsedLabel = el('elapsed');
const totalLabel = el('total');
const readout = el('readout');
const recordButton = el<HTMLButtonElement>('record');
const recordLabel = el('record-label');

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M7 5h3.2v14H7zM13.8 5H17v14h-3.2z';

const session = new AudioSession();
const director = new Director();
const stage = new Stage(canvas);
const chime = new Chime();
const recorder = new PerformanceRecorder();

/** Name of the loaded track, used for the exported filename. */
let trackLabel = 'performance';

let busy = false;
/** A sample download is in flight; keeps a second intake from racing it. */
let fetching = false;
let lastTimestamp = performance.now();
/** Free-running clock used before a track is loaded, so the stage is never still. */
let idleClock = 0;

/* ---------------------------------------------------------------- file intake */

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'audio/mpeg,audio/mp3,audio/*,.mp3,.m4a,.wav,.ogg,.flac';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

el('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void accept(file);
  fileInput.value = '';
});

for (const button of document.querySelectorAll<HTMLButtonElement>('.sample')) {
  button.addEventListener('click', () => {
    const name = button.dataset.sample;
    if (name) void acceptSample(name, button.querySelector('.sample-title')?.textContent ?? name);
  });
}

/** Streams a bundled demo track through the same path as a dropped file. */
async function acceptSample(fileName: string, label: string) {
  if (busy || fetching) return;
  fetching = true;
  chime.accept();
  intakeError.hidden = true;
  intake.hidden = true;
  analysing.hidden = false;
  analysisName.textContent = label;
  setProgress(0.02, 'Fetching');

  try {
    const url = `${import.meta.env.BASE_URL}samples/${fileName}`;
    const blob = await fetchWithProgress(url, (p) => setProgress(0.02 + p * 0.2, 'Fetching'));
    fetching = false;
    await accept(new File([blob], fileName, { type: 'audio/mpeg' }), { silent: true });
    // Prefer the display name over the slugified filename for the export.
    trackLabel = label;
  } catch {
    analysing.hidden = true;
    intake.hidden = false;
    fail('That sample could not be loaded. Check your connection and try again.');
  } finally {
    fetching = false;
  }
}

async function fetchWithProgress(url: string, onProgress: (ratio: number) => void): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || total === 0) return response.blob();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (file) void accept(file);
});

/** @param silent when the caller has already announced the track and chimed. */
async function accept(file: File, { silent = false } = {}) {
  if (busy || fetching) return;
  if (!looksLikeAudio(file)) {
    fail('That does not look like an audio file. Try an MP3.');
    return;
  }

  busy = true;
  trackLabel = file.name;
  if (!silent) {
    chime.accept();
    analysisName.textContent = file.name;
  }
  intakeError.hidden = true;
  intake.hidden = true;
  analysing.hidden = false;
  transport.hidden = true;
  setProgress(silent ? 0.22 : 0, 'Decoding');

  try {
    await session.load(file, (p) => setProgress(p.value, p.stage));
    director.setAnalysis(session.analysis);

    analysing.hidden = true;
    transport.hidden = false;
    totalLabel.textContent = formatTime(session.duration);
    updateReadout();

    chime.lightsUp();
    session.play();
    reflectPlayState();
    markActive();
  } catch (err) {
    analysing.hidden = true;
    intake.hidden = false;
    fail(err instanceof Error ? err.message : 'That file could not be decoded.');
  } finally {
    busy = false;
  }
}

function looksLikeAudio(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  return /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(file.name);
}

function fail(message: string) {
  intakeError.textContent = message;
  intakeError.hidden = false;
}

function setProgress(value: number, stageText: string) {
  analysisBar.style.width = `${Math.round(value * 100)}%`;
  analysisStage.textContent = stageText;
}

/* ---------------------------------------------------------------- transport */

playpause.addEventListener('click', () => {
  session.toggle();
  reflectPlayState();
});

el('eject').addEventListener('click', () => {
  recorder.cancel();
  reflectRecordState();
  session.stop();
  director.setAnalysis(null);
  transport.hidden = true;
  intake.hidden = false;
  intakeError.hidden = true;
  document.body.classList.remove('idle');
});

session.onEnded = () => {
  // Finish the file at the end of the track rather than leaving it running.
  if (recorder.isRecording) void finishRecording();
  reflectPlayState();
  document.body.classList.remove('idle');
};

/* ---------------------------------------------------------------- recording */

recordButton.hidden = !isRecordingSupported();

recordButton.addEventListener('click', () => {
  if (recorder.isRecording) {
    void finishRecording();
    return;
  }
  try {
    // Capture starts wherever you are: press it before playing for the whole
    // performance, or mid-track for a short clip worth sharing.
    if (!session.isPlaying) session.play();
    recorder.start(canvas, session.captureAudioStream());
    reflectPlayState();
    reflectRecordState();
  } catch (err) {
    fail(err instanceof Error ? err.message : 'Recording could not start.');
  }
});

async function finishRecording() {
  try {
    const { blob } = await recorder.stop();
    saveRecording(blob, exportFileName(trackLabel));
  } catch (err) {
    intakeError.textContent = err instanceof Error ? err.message : 'Recording failed.';
    intakeError.hidden = false;
  } finally {
    reflectRecordState();
  }
}

function reflectRecordState() {
  const recording = recorder.isRecording;
  document.body.classList.toggle('recording', recording);
  recordButton.setAttribute('aria-label', recording ? 'Stop recording' : 'Record video');
  if (!recording) recordLabel.textContent = 'Record';
}

function reflectPlayState() {
  const playing = session.isPlaying;
  playpauseIcon.setAttribute('d', playing ? PAUSE_PATH : PLAY_PATH);
  playpause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

let scrubbing = false;
const seekFromPointer = (clientX: number) => {
  const rect = scrub.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  session.seek(ratio * session.duration);
};

scrub.addEventListener('pointerdown', (e) => {
  if (session.duration === 0) return;
  scrubbing = true;
  scrub.setPointerCapture(e.pointerId);
  seekFromPointer(e.clientX);
});
scrub.addEventListener('pointermove', (e) => {
  if (scrubbing) seekFromPointer(e.clientX);
});
const endScrub = (e: PointerEvent) => {
  if (!scrubbing) return;
  scrubbing = false;
  if (scrub.hasPointerCapture(e.pointerId)) scrub.releasePointerCapture(e.pointerId);
};
scrub.addEventListener('pointerup', endScrub);
scrub.addEventListener('pointercancel', endScrub);

scrub.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') session.seek(session.time - 5);
  else if (e.key === 'ArrowRight') session.seek(session.time + 5);
  else return;
  e.preventDefault();
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && ['INPUT', 'BUTTON'].includes(e.target.tagName) && e.key === ' ') {
    return; // let the focused control handle its own activation
  }
  if (session.duration === 0) return;

  if (e.key === ' ') {
    e.preventDefault();
    session.toggle();
    reflectPlayState();
  } else if (e.key === 'ArrowLeft') {
    session.seek(session.time - 5);
  } else if (e.key === 'ArrowRight') {
    session.seek(session.time + 5);
  } else if (e.key.toLowerCase() === 'f') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  }
  markActive();
});

/* ---------------------------------------------------------------- idle chrome */

let idleTimer = 0;
function markActive() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (!session.isPlaying) return;
  idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 2800);
}
window.addEventListener('pointermove', markActive);
window.addEventListener('pointerdown', markActive);

/* ---------------------------------------------------------------- render loop */

window.addEventListener('resize', () => stage.resize());

function updateReadout() {
  const a = session.analysis;
  if (!a) {
    readout.textContent = '';
    return;
  }
  readout.textContent = a.weak
    ? 'free tempo'
    : `${Math.round(a.bpm)} bpm · ${a.beats.length} beats`;
}

function bandsFromSpectrum(data: Uint8Array) {
  if (data.length === 0) return undefined;
  // The analyser covers 0..nyquist across its bins; these splits mirror the
  // offline band edges closely enough to cross-fade with them.
  const bassEnd = Math.max(1, Math.floor(data.length * 0.014));
  const midEnd = Math.max(bassEnd + 1, Math.floor(data.length * 0.16));
  const mean = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += data[i];
    return sum / Math.max(1, to - from) / 255;
  };
  return {
    bass: mean(0, bassEnd),
    mid: mean(bassEnd, midEnd),
    high: mean(midEnd, data.length),
  };
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - lastTimestamp) / 1000);
  lastTimestamp = now;

  // The idle clock always advances, so a paused or unloaded stage still has a
  // clock to breathe and drift the lights against.
  idleClock += dt;
  const playing = session.isPlaying;
  const time = playing ? session.time : idleClock;

  const state = director.update(
    time,
    dt,
    playing ? bandsFromSpectrum(session.sampleSpectrum()) : undefined,
    !playing,
  );
  stage.render(dt, time, state);

  if (session.duration > 0) {
    const position = session.time;
    const ratio = position / session.duration;
    scrubFill.style.width = `${(ratio * 100).toFixed(2)}%`;
    scrub.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    elapsedLabel.textContent = formatTime(position);
  }

  if (recorder.isRecording) {
    recordLabel.textContent = `Stop ${formatTime(recorder.elapsedMs / 1000)}`;
  }

  requestAnimationFrame(frame);
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- boot */

window.addEventListener('beforeunload', () => session.dispose());

if (import.meta.env.DEV) {
  // Lets a headless check drive the stage frame by frame and read pixels back,
  // which requestAnimationFrame cannot do while the tab is not compositing.
  Object.assign(window, {
    __stagelight: {
      stage,
      director,
      session,
      resize: (w: number, h: number) => stage.resize(w, h),
      /** Feed the normal intake path from a served file, for analyser checks. */
      async loadUrl(url: string) {
        const blob = await fetch(url).then((r) => r.blob());
        await accept(new File([blob], url.split('/').pop() ?? 'test.mp3', { type: 'audio/mpeg' }));
        return session.analysis;
      },
      /** Advance to `time` in `frames` steps so smoothed values settle. */
      seekAndRender(time: number, frames = 60, dt = 1 / 60) {
        const start = Math.max(0, time - frames * dt);
        for (let i = 0; i < frames; i++) {
          const t = start + i * dt;
          stage.render(dt, t, director.update(t, dt));
        }
      },
      shot: () => canvas.toDataURL('image/png'),
    },
  });
}

stage
  .loadAvatar(`${import.meta.env.BASE_URL}sprites`.replace(/\/+$/, ''))
  .catch(() => fail('The dancer could not be loaded. Try a reload.'));

stage.resize();
requestAnimationFrame(frame);
