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

### Transitions

Twelve drawings cut hard from one to the next. The aim is not to smooth that
over — the art suits limited animation — but to give each cut momentum,
preparation and impact, so the missing in-betweens feel implied.

**Hold → anticipate → snap → settle.** The drawing changes `CUT_LEAD_BEATS`
before the nominal step boundary, so the overshoot straddles the beat and the
*impact* is what lands on the transient rather than the swap. Before the cut the
body prepares; after it, it resolves. The pose's own arc now starts at the cut,
not at the beat, which is the difference between motion following the drawing
and motion carrying it.

**A transition vocabulary, not an animation system.** `poses.ts` holds a small
table of what each drawing is — height, facing, airborne, effort — from which
`transitionKind` derives one of `rise | drop | turn | gesture | recover |
neutral` for all 144 edges, with a handful of overrides where the derived answer
is wrong. Each kind has a motion recipe of pre- and post-cut deltas. A `rise`
into a grounded pose becomes vertical stretch rather than lift, so she reaches
up instead of floating.

**Transition-aware bar planning.** Moves are curated internally, but the seam
between two independently chosen bars was not — one bar could end mid-air and
the next open on a calm arm pose. The routine is now planned forward one move
per bar, scoring candidates by `transitionCost` from the previous bar's closing
pose. That kills bad cuts before they are drawn. It also makes the routine a
pure function of the analysis, so seeking replays exactly what you saw.

**Afterimage, not crossfade.** Dissolving two drawings of the same character
gives you four arms and two heads. Instead the outgoing drawing is held behind
the new one for ~80 ms, additive, tinted with the rim light and offset against
the direction of travel. It is gated to high intensity and hard cuts, and capped
to a fraction of the step so fast eight-step bars do not ghost throughout.

## Exporting a performance

The **Record** button in the transport captures the stage to a local file:
`canvas.captureStream()` for video, a `MediaStreamAudioDestinationNode` tapped
off the analyser for audio, muxed live by `MediaRecorder` into VP9/Opus WebM and
handed straight to the browser's download. Nothing is uploaded and nothing is
transcoded on a server, so the privacy promise is unchanged.

Recording starts from wherever you are — press it before playing for a whole
performance, or mid-track for a short clip — and stops automatically at the end
of the track. You get `cosmic-dance-stagelight.webm`.

Known limitation: `MediaRecorder` does not write a duration into the WebM
header, so some players report the length as unknown until the file is fully
loaded. It plays and uploads correctly; fixing it properly means rewriting the
EBML header after the fact.

## Tests

```bash
npm test
```

67 tests, no DOM and no network — everything under test is pure, and every
signal is synthesised from a seeded generator so runs are bit-for-bit
repeatable.

- `tests/fft.test.ts` — the transform against a naive DFT, plus Parseval,
  bin placement and window symmetry.
- `tests/analyze.test.ts` — tempo lock at five tempi on synthetic drum loops,
  beat *phase* (not just spacing), octave-error resistance, downbeat count,
  and that silence and structureless noise are reported `weak` rather than
  guessed at.
- `tests/director.test.ts` — that waiting never uses a dance pose or pulses the
  rig, that frames stay inside the atlas, that seeking replays identical
  choreography, and that only airborne poses leave the ground.
- `tests/recorder.test.ts` — export filename handling, including accents,
  punctuation, truncation and empty input.

The suite earned its keep immediately: it caught a **tempo octave error** where
a 96 BPM loop with offbeat hi-hats was detected as 191 BPM, and a `weak` flag
that almost never fired because it compared autocorrelation to the peak instead
of to the envelope's variance. Both are fixed in `estimateTempo`.

## The cast

Three avatars, swappable from the picker at any time — including mid-track:

| id | who |
| --- | --- |
| `mint` | cropped hoodie, silver bob with mint tips |
| `shadow` | kunoichi in black, crimson scarf |
| `comtesse` | rococo noblewoman with a lace parasol |

Every character is drawn to the **same twelve-pose contract in the same frame
order**, so the whole choreography and transition grammar is shared — a new
avatar is genuinely just a different sheet of paper. Adding one means generating
a sheet against the same frame list, running the two build steps below, and
adding a line to `public/sprites/characters.json`.

`scale` in the manifest exists because atlases are normalised against their own
tallest pose: the Comtesse's parasol eats into her height budget, so she is
drawn smaller and scaled back up to read as the adult she is.

### Why the atlases are WebP

They started as PNGs at 1.3–2.3 MB each, which made "preload the whole cast"
a real trade-off. WebP at quality 92 removes the trade-off entirely:

| | PNG | WebP q92 |
| --- | --- | --- |
| mint | 1324 KB | 349 KB |
| shadow | 1265 KB | 298 KB |
| comtesse | 2317 KB | 575 KB |
| **all three** | **4906 KB** | **1222 KB** |

The whole cast now costs less than one sheet used to. Measured on visible
pixels only, that is 33–38 dB PSNR, and the **alpha channel is bit-identical**,
so sprite edges cannot fringe — the encoder is told `alpha_quality=100` and only
the colour is lossy. At 3× magnification it is indistinguishable from the PNG,
and on stage the sprite is downscaled rather than magnified.

So the default atlas loads first and the rest are warmed on
`requestIdleCallback` once the stage is already up. First paint is never held
up, and by the time anyone reaches for the picker the switch is instant —
measured at 8 ms with no network at all.

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
python tools/build_atlas.py --input assets-src/mint-keyed.png \
  --out public/sprites/mint-atlas.png --meta public/sprites/mint-atlas.json

# 4. head portraits for the picker, cut from the finished atlases
python tools/build_heads.py
```

`build_heads.py` crops from the sprite sheet rather than generating separate
portraits, so the face on the picker is the face that appears on stage and
cannot drift as sheets are regenerated. The crop boxes are hand-picked per
character because the heads cannot be found by alpha alone — the Comtesse's
parasol canopy merges with her hair into a single silhouette.

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
