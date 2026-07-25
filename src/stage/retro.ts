import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * VHS-on-a-CRT pass — curvature, tracking-band skew, chroma bleed, ghosting,
 * grain, dropouts, wobble, scanlines and vignette.
 *
 * Adapted from the same effect in the sibling `spaceshooter` project, with two
 * changes this stage needs:
 *
 * 1. It runs as the last pass of an EffectComposer, after OutputPass has
 *    already tone-mapped and encoded to sRGB. The original ended with its own
 *    gamma curve; keeping that here would double-encode and wash everything out.
 * 2. The original lifts blacks hard, which suits a bright arcade game. This
 *    stage is deliberately almost entirely near-black, so the lift is much
 *    gentler — enough to read as tape, not enough to turn the set grey.
 *
 * It also takes a beat uniform, so tracking errors land on the music rather
 * than drifting independently of it.
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform float uBeat;
  uniform float uStrength;
  uniform vec2 uResolution;
  varying vec2 vUv;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

  void main() {
    vec2 uv = vUv;
    float s = uStrength;

    // CRT glass curvature
    vec2 cc = uv - 0.5;
    uv += cc * dot(cc, cc) * 0.07 * s;

    // tape wobble: per-line horizontal jitter plus a slow breathing sway
    uv.x += (sin(uv.y * 7.0 + uTime * 2.1) * 0.0012
           + sin(uv.y * 31.0 - uTime * 5.3) * 0.0005) * s;

    // Roaming tracking band that skews hard and carries dropout static. It
    // sweeps on its own, but bites harder on the beat.
    //
    // Gated so it comes and goes: the band sweeps continuously, so without this
    // there is always one somewhere on screen, which reads as a broken display
    // rather than as a tape occasionally losing its footing.
    float bandGate = step(0.58, hash(floor(uTime * 0.37)));
    float bandPos = fract(uTime * 0.11) * 1.2 - 0.1;
    float inBand = (1.0 - smoothstep(0.0, 0.03, abs(uv.y - bandPos))) * bandGate;
    float skewSeed = hash(floor(uTime * 16.0));
    uv.x += inBand * (skewSeed - 0.5) * 0.16 * s * (0.6 + uBeat * 0.9);

    // occasional whole-frame horizontal tear, more likely on a transient
    float frameSeed = hash(floor(uTime * 6.0));
    if (frameSeed > 0.93 - uBeat * 0.06) {
      uv.x += (hash(floor(uTime * 6.0) + 7.0) - 0.5)
            * 0.05 * s * step(0.85, fract(uv.y * 2.0 + uTime * 3.0));
    }

    vec2 px = 1.0 / uResolution;

    // chroma bleed: RGB sampled apart, then smeared sideways
    vec3 col;
    col.r = texture2D(tDiffuse, uv + vec2(px.x * 2.6 * s, 0.0)).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - vec2(px.x * 2.0 * s, 0.0)).b;

    vec3 smear = (
      texture2D(tDiffuse, uv + vec2(px.x * 5.0, 0.0)).rgb +
      texture2D(tDiffuse, uv - vec2(px.x * 5.0, 0.0)).rgb +
      texture2D(tDiffuse, uv + vec2(0.0, px.y * 1.6)).rgb +
      texture2D(tDiffuse, uv - vec2(0.0, px.y * 1.6)).rgb
    ) * 0.25;
    col = mix(col, smear, 0.34 * s);

    // ghost echoes (tape print-through): two faint delayed copies
    col += texture2D(tDiffuse, uv - vec2(px.x * 16.0, 0.0)).rgb * 0.10 * s;
    col += texture2D(tDiffuse, uv - vec2(px.x * 34.0, 0.0)).rgb * 0.045 * s;

    // Washed out: desaturate and squash the highlights. The black lift is kept
    // small — this set is mostly shadow, and lifting it reads as fog, not tape.
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(luma), 0.24 * s);
    col = col * (1.0 - 0.06 * s) + 0.016 * s;

    // Scanlines, vignette and desaturation each take a bite out of an image
    // that is already mostly shadow. Put some of it back, or the tape deck
    // reads as "someone turned the lights off" rather than as a tape.
    col *= 1.0 + 0.30 * s;

    // scanlines with a slight interlace flicker
    float scan = 1.0 - 0.18 * s * (0.5 - 0.5 * sin(uv.y * uResolution.y * 3.14159
                 + step(0.5, fract(uTime * 30.0)) * 3.14159));
    col *= scan;

    // tape grain
    col += (hash2(uv * uResolution.xy + uTime * 60.0) - 0.5) * 0.055 * s;

    // white dropout streaks riding the tracking band
    float streak = step(0.72, hash2(vec2(floor(uv.y * uResolution.y * 0.5),
                                         floor(uTime * 22.0))));
    col += inBand * streak * 0.32 * s;

    // vignette, and black beyond the edge of the glass
    col *= 1.0 - dot(cc, cc) * 0.55 * s;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

export function createRetroPass(): ShaderPass {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uStrength: { value: 1 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  pass.enabled = false;
  return pass;
}
