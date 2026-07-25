# Stagelight

Drop in an MP3 and it gets danced back to you. A hand-drawn anime avatar performs
on a lit stage, locked to the track's actual beat grid.

Everything — decode, beat detection, rendering — happens in the browser. The
user's file is never uploaded, never written to storage, and is dropped when the
tab closes. There is no backend.

## Running it

```bash
npm install && npm run dev
```

Keyboard: **space** play/pause, **←/→** seek 5s, **F** fullscreen.

## Deploying

Static assets on Cloudflare Workers, no Worker script needed:

```bash
npm run deploy
```

## How the beat tracking works

`src/audio/analyzer.worker.ts` runs off the main thread on a mono 22.05 kHz
downmix:

1. **STFT** — 1024-point FFT, 256-sample hop (~86 frames/sec).
2. **Onset envelope** — log-compressed spectral flux, half-wave rectified, with
   a local mean subtracted so quiet passages weigh as much as loud ones.
3. **Tempo** — autocorrelation over 70–190 BPM, comb-filtered across four
   harmonics so a strong off-beat cannot pull the estimate to double time, and
   weighted by a log-normal prior centred near 124 BPM.
4. **Beat grid** — an Ellis-style dynamic-programming tracker picks the beat
   sequence that jointly maximises onset strength and regularity, so it follows
   gentle tempo drift instead of assuming a rigid click.
5. **Downbeats** — whichever of every four beats carries the most bass.

If the tempo correlation is too weak to trust, the result is flagged `weak` and
the stage falls back to free-running motion rather than faking a lock.

Measured on the bundled samples: a 3½-minute track analyses in about two seconds,
with 23–35 ms of spacing jitter across ~500 beats.

## How the dancing works

Twelve drawn poses would read as a flipbook on their own. `src/choreo/director.ts`
layers them:

- **Moves** are 4- or 8-step pose sequences filling one bar, chosen per bar from
  the ones whose intensity window matches the current arrangement energy. The
  choice is a hash of the bar index, so seeking back replays the same routine.
- **Procedural motion** on top — an arc through each pose, kick-driven squash,
  extra airtime on the jump and spin poses, slow sway and lean.

## Art pipeline

The atlas is generated, not hand-drawn:

```bash
# 1. one 4x3 sheet on a chroma-key background (prompt in assets-src/)
python ~/.claude/skills/sprite-pipeline/scripts/image_gen.py generate \
  --prompt "$(cat assets-src/dancer.prompt.txt)" \
  --quality medium --size 2048x1536 --out assets-src/dancer-raw.png

# 2. key it out
python ~/.claude/skills/sprite-pipeline/scripts/remove_chroma_key.py \
  --input assets-src/dancer-raw.png --out assets-src/dancer-keyed.png \
  --auto-key border --soft-matte --despill

# 3. fixed-cell atlas
python tools/build_atlas.py --input assets-src/dancer-keyed.png \
  --out public/sprites/dancer-atlas.png --meta public/sprites/dancer-atlas.json
```

`tools/build_atlas.py` deliberately uses **one global scale** for every frame and
anchors on the feet, so a crouch really is shorter than a standing pose. Scaling
each pose to fill its own cell — the usual default — makes the figure pop between
frames.

## Stage

`src/stage/` — four moving heads with visible beams, a warm key, a clipped back
rim, an even deck wash, drifting haze, downbeat rings, and a mirrored sprite for
the floor reflection. Palettes change on bar lines, never mid-phrase; keys stay
near white so colour comes from the fills and rim, as on a real stage.

## Sample tracks

`public/samples/` holds two demo tracks so the app can be tried without a file of
your own. They belong to their respective rights holders and are included for
demonstration.

## Dev-only helpers

`npm run dev` exposes `window.__stagelight` (`loadUrl`, `seekAndRender`, `shot`)
and a `POST /__shot` endpoint that writes canvas captures to `.dev-shots/`. Both
are stripped from production builds.
