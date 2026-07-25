# Gap

Known limitations and deferred work, parked deliberately rather than forgotten.
Nothing here is blocking; each entry says what it is, why it was left, and what
picking it up would involve.

## Targeted in-between drawings

The transition grammar (`src/choreo/poses.ts`) sells each pose cut with
anticipation and settlement, which covers all 144 edges by derivation. The
original plan was to follow it with four or five hand-picked in-between
drawings for the worst-reading transitions:

1. `CROUCH → JUMP`
2. `JUMP → LAND`
3. `SPIN_BACK → SPIN_FRONT`
4. `POINT_LEFT → SWEEP`
5. `LAND → a neutral recovery pose`

**Why parked:** on review no single transition stood out as bad, so there is
nothing to aim at. Guessing at five drawings would be spending generation
budget on a problem that has not been identified. `SPIN_BACK → SPIN_FRONT` is
the most likely first candidate, since a turn is the hardest thing to sell
without an in-between.

**Picking it up:** generate the extra drawings into the existing sheet layout,
extend `frameCount` in the atlas metadata, and add the new indices to `POSE`
plus the relevant move sequences. The atlas builder and choreography both read
frame counts from metadata, so nothing is hard-coded to twelve.

## WebM duration header

`MediaRecorder` does not write a duration into the WebM header, so some players
report an exported performance's length as unknown until the file is fully
loaded. It plays and uploads correctly — social platforms re-encode anyway —
but scrubbing can be awkward locally.

**Why parked:** fixing it properly means rewriting the EBML header after
recording, which is fiddly enough to risk producing subtly broken files. The
current output is correct, just under-described.

**Picking it up:** patch the Segment/Info/Duration element post-hoc, or adopt a
known-good implementation rather than hand-rolling one.

## The `transitions` branch

Merged into `main` (fast-forward, so history is linear) but never deleted, and
still present on the remote.

**Picking it up:** `git branch -d transitions && git push origin --delete transitions`.

## Edge-cached deleted assets

Cloudflare's edge still serves a cached copy of `/sprites/dancer-atlas.png`,
deleted when the atlases were renamed per character. Nothing requests it, so it
is harmless and will age out. Worth knowing only because a cache-busted request
returns the SPA fallback (`text/html`) while a plain one returns the stale PNG —
which looks like a dirty deployment and is not.

## No PNG fallback for WebP

Atlases and portraits ship only as WebP. That excludes Safari below 14 (2020)
and any browser without WebP support.

**Why parked:** a fallback would double the shipped art weight to serve
browsers that would struggle with the WebGL stage regardless.
