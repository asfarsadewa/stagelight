import * as THREE from 'three';
import type { DanceState } from '../choreo/director';

export interface Palette {
  name: string;
  key: number;
  fillA: number;
  fillB: number;
  rim: number;
  haze: number;
  floor: number;
}

/**
 * Deliberately restrained: two hues plus a complement, never a rainbow.
 * Keys stay close to white on purpose — as on a real stage, the key light keeps
 * the performer readable and the colour comes from the fills and the rim.
 */
export const PALETTES: Palette[] = [
  { name: 'aurora', key: 0xfff0dd, fillA: 0x2fd4c8, fillB: 0x4f6bff, rim: 0x64e0ff, haze: 0x1b3a52, floor: 0x142838 },
  { name: 'ember', key: 0xfff1e0, fillA: 0xff7a3c, fillB: 0xd63a6a, rim: 0xffab5e, haze: 0x3a1e1c, floor: 0x33201c },
  { name: 'orchid', key: 0xfdeeff, fillA: 0xa055ff, fillB: 0xff5fa8, rim: 0xd08bff, haze: 0x2c1b45, floor: 0x281b3a },
  { name: 'chartreuse', key: 0xfaffee, fillA: 0x8bdc4a, fillB: 0x18a5a5, rim: 0xb6f06a, haze: 0x1d3320, floor: 0x1b2c1e },
  { name: 'ice', key: 0xffffff, fillA: 0x7fb2ff, fillB: 0xb08cff, rim: 0xa8d8ff, haze: 0x1e2740, floor: 0x1a2135 },
];

const BEAM_VERT = /* glsl */ `
  varying float vHeight;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    // ConeGeometry runs from -h/2 (base) to +h/2 (apex) in local Y.
    vHeight = uv.y;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vHeight;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    // Densest at the lamp, thinning out as the cone widens.
    float along = pow(clamp(vHeight, 0.0, 1.0), 2.3);
    // Grazing angles carry almost all of it — looking through the flat face of
    // a cone should be near-invisible, otherwise the beam reads as a glass wedge.
    float edge = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir)));
    float a = along * (0.08 + 0.92 * pow(edge, 2.0)) * uIntensity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

/** A spotlight plus the visible shaft of haze it carves out of the air. */
class MovingHead {
  readonly light: THREE.SpotLight;
  readonly beam: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  private readonly pivot = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    origin: THREE.Vector3,
    color: number,
    private readonly baseIntensity: number,
    castShadow: boolean,
  ) {
    this.pivot.copy(origin);

    const coneAngle = THREE.MathUtils.degToRad(11);
    this.light = new THREE.SpotLight(color, baseIntensity, 42, coneAngle, 0.75, 1.4);
    this.light.position.copy(origin);
    this.light.target.position.set(0, 1.4, 0);
    this.light.castShadow = castShadow;
    if (castShadow) {
      this.light.shadow.mapSize.set(1024, 1024);
      this.light.shadow.bias = -0.0012;
      this.light.shadow.normalBias = 0.02;
      this.light.shadow.camera.near = 1;
      this.light.shadow.camera.far = 40;
    }
    scene.add(this.light, this.light.target);

    // Just long enough to reach the deck: a shaft that carries on through the
    // floor and out the far side of the room never reads as light.
    const length = origin.length() + 1.2;
    const radius = Math.tan(coneAngle) * length;
    const geometry = new THREE.ConeGeometry(radius, length, 48, 20, true);
    this.beam = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uIntensity: { value: 0.0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.beam.renderOrder = 4;
    scene.add(this.beam);

    this.aim.set(0, 1.4, 0);
    this.desired.copy(this.aim);
  }

  retarget(x: number, z: number) {
    this.desired.set(x, 1.3, z);
  }

  update(dt: number, color: THREE.Color, intensity: number, beamDensity: number) {
    this.aim.lerp(this.desired, Math.min(1, dt * 3.4));
    this.light.target.position.copy(this.aim);
    this.light.target.updateMatrixWorld();

    this.color.lerp(color, Math.min(1, dt * 2.2));
    this.light.color.copy(this.color);
    this.light.intensity = this.baseIntensity * intensity;

    // Sit the cone so its apex is at the lamp and its axis points at the aim.
    const dir = this.aim.clone().sub(this.pivot);
    const length = this.beam.geometry.parameters.height;
    const axis = dir.clone().normalize();
    this.beam.position.copy(this.pivot).addScaledVector(axis, length / 2);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().negate());

    const mat = this.beam.material;
    (mat.uniforms.uColor.value as THREE.Color).copy(this.color);
    mat.uniforms.uIntensity.value = beamDensity * intensity;
  }

  dispose() {
    this.beam.geometry.dispose();
    this.beam.material.dispose();
    this.light.dispose();
  }
}

/**
 * The whole lighting rig: four moving heads, a warm key, a back rim and just
 * enough ambient to keep the shadows from going to pure black.
 */
export class LightRig {
  private readonly heads: MovingHead[] = [];
  private readonly rim: THREE.SpotLight;
  private readonly ambient: THREE.HemisphereLight;
  private readonly key: THREE.DirectionalLight;
  /** Wide, dim light from straight overhead so the whole deck is legible. */
  private readonly deckWash: THREE.SpotLight;

  private paletteIndex = 0;
  private readonly current: Palette;
  private readonly colors = {
    key: new THREE.Color(),
    fillA: new THREE.Color(),
    fillB: new THREE.Color(),
    rim: new THREE.Color(),
    haze: new THREE.Color(),
    floor: new THREE.Color(),
  };
  private lastBar = -1;

  constructor(scene: THREE.Scene) {
    this.current = { ...PALETTES[0] };
    this.applyPaletteImmediate(PALETTES[0]);

    // Hung low enough that a good length of each shaft falls inside the frame;
    // the lamps themselves stay just above it, so the beams read as entering
    // from an unseen truss.
    const positions: [number, number, number][] = [
      [-6.2, 6.4, 3.6],
      [6.2, 6.4, 3.6],
      [-4.6, 5.8, -4.6],
      [4.6, 5.8, -4.6],
    ];
    positions.forEach((p, i) => {
      this.heads.push(
        new MovingHead(scene, new THREE.Vector3(...p), PALETTES[0].fillA, i < 2 ? 24 : 17, i === 0),
      );
    });

    this.key = new THREE.DirectionalLight(PALETTES[0].key, 1.1);
    this.key.position.set(2.5, 6, 7);
    scene.add(this.key);

    // Rakes her from behind. Kept narrow and weak — aimed at the performer, it
    // otherwise dumps most of its output onto the deck and blows it out.
    // The range is clipped just past her so the cone dies before it reaches the
    // near deck; otherwise it lays a bright wedge across the floor in front.
    this.rim = new THREE.SpotLight(PALETTES[0].rim, 18, 11.5, THREE.MathUtils.degToRad(24), 0.9, 1.3);
    this.rim.position.set(0, 5.4, -8.2);
    this.rim.target.position.set(0, 1.8, 0);
    scene.add(this.rim, this.rim.target);

    // decay 0 on purpose: this is a flood, not a lamp. Physical falloff from a
    // single overhead point crushes the deck to black a metre from centre and
    // leaves one blown-out pool under her feet.
    this.deckWash = new THREE.SpotLight(PALETTES[0].haze, 3, 40, THREE.MathUtils.degToRad(62), 1.0, 0.0);
    this.deckWash.position.set(0, 13, 0);
    this.deckWash.target.position.set(0, 0, 0);
    scene.add(this.deckWash, this.deckWash.target);

    this.ambient = new THREE.HemisphereLight(PALETTES[0].haze, 0x05070a, 0.42);
    scene.add(this.ambient);
  }

  get rimColor(): THREE.Color {
    return this.colors.rim;
  }

  get hazeColor(): THREE.Color {
    return this.colors.haze;
  }

  get floorColor(): THREE.Color {
    return this.colors.floor;
  }

  private applyPaletteImmediate(p: Palette) {
    this.colors.key.setHex(p.key);
    this.colors.fillA.setHex(p.fillA);
    this.colors.fillB.setHex(p.fillB);
    this.colors.rim.setHex(p.rim);
    this.colors.haze.setHex(p.haze);
    this.colors.floor.setHex(p.floor);
  }

  /** Palettes change on a bar line, never mid-phrase. */
  private maybeShiftPalette(bar: number, intensity: number, idle: boolean) {
    if (bar === this.lastBar) return;
    this.lastBar = bar;

    // Roughly every 8 bars, and more eagerly when the track opens up. Waiting,
    // it drifts far more slowly — a colour change every few seconds on an empty
    // stage looks like a fault.
    const period = idle ? 24 : intensity > 0.66 ? 4 : 8;
    if (bar % period !== 0) return;
    this.paletteIndex = (this.paletteIndex + 1) % PALETTES.length;

    const next = PALETTES[this.paletteIndex];
    this.current.key = next.key;
    this.current.fillA = next.fillA;
    this.current.fillB = next.fillB;
    this.current.rim = next.rim;
    this.current.haze = next.haze;
    this.current.floor = next.floor;

    // Moving heads pick fresh positions on the same cue.
    const spread = 2.4 + intensity * 2.6;
    this.heads.forEach((h, i) => {
      const angle = ((hash(bar * 7 + i) % 360) / 360) * Math.PI * 2;
      h.retarget(Math.cos(angle) * spread * (i % 2 ? 1 : -1) * 0.5, Math.sin(angle) * spread * 0.5);
    });
  }

  update(dt: number, state: DanceState, time: number) {
    const bar = Math.floor(time / Math.max(0.25, (60 / state.bpm) * 4));
    this.maybeShiftPalette(bar, state.intensity, state.idle);

    const target = {
      key: new THREE.Color(this.current.key),
      fillA: new THREE.Color(this.current.fillA),
      fillB: new THREE.Color(this.current.fillB),
      rim: new THREE.Color(this.current.rim),
      haze: new THREE.Color(this.current.haze),
      floor: new THREE.Color(this.current.floor),
    };
    const k = Math.min(1, dt * 1.6);
    this.colors.key.lerp(target.key, k);
    this.colors.fillA.lerp(target.fillA, k);
    this.colors.fillB.lerp(target.fillB, k);
    this.colors.rim.lerp(target.rim, k);
    this.colors.haze.lerp(target.haze, k);
    this.colors.floor.lerp(target.floor, k);

    // Kick drives the front pair, hats the back pair — so the rig reads the mix
    // rather than just blinking on every beat.
    const kick = 0.45 + state.bass * 0.75 + state.beatPulse * 0.55;
    const shimmer = 0.35 + state.high * 0.85 + state.beatPulse * 0.25;
    // Never fully off: an unlit rig reads as a bug, not as restraint.
    const density = 0.9 + state.intensity * 0.8 + state.barPulse * 0.25;

    // Waiting: a house rig between numbers. Lit, slowly drifting, not performing.
    const breath = state.idle ? 0.86 + Math.sin(time * 0.5) * 0.1 : 1;

    this.heads.forEach((h, i) => {
      const front = i < 2;
      const color = i % 2 === 0 ? this.colors.fillA : this.colors.fillB;
      const sweep = state.idle ? 0.7 : 1.6 + state.intensity * 2.2;
      const speed = state.idle ? 0.16 : front ? 0.6 : 0.43;
      const swing = Math.sin(time * speed + i * 1.9) * sweep;
      h.retarget(swing, Math.cos(time * (state.idle ? 0.11 : 0.37) + i) * (state.idle ? 0.9 : 1.6));
      h.update(dt, color, (front ? kick : shimmer) * breath, density * (front ? 1 : 0.8) * breath);
    });

    this.key.color.copy(this.colors.key);
    this.key.intensity = 1.35 + state.intensity * 0.75 + state.beatPulse * 0.25;

    this.rim.color.copy(this.colors.rim);
    this.rim.intensity = 12 + state.intensity * 24 + state.beatPulse * 12;

    this.deckWash.color.copy(this.colors.fillA).lerp(this.colors.haze, 0.55);
    this.deckWash.intensity = 2.6 + state.intensity * 2.2 + state.barPulse * 0.7;

    this.ambient.color.copy(this.colors.haze);
    this.ambient.intensity = 0.3 + state.level * 0.35;
  }

  dispose() {
    for (const h of this.heads) h.dispose();
  }
}

function hash(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
