import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createRetroPass } from './retro';
import { Dancer } from './dancer';
import { AtlasCache, BASE_HEIGHT, type Character } from './cast';

/** Who stands where. The lead carries the number; the partner supports it. */
export type Slot = 'lead' | 'partner';

/**
 * Marks on the deck.
 *
 * The camera sits on +Z looking at the origin, so a dancer facing it has her
 * own left toward +X — screen right. The partner therefore stands upstage and
 * to +X: behind the lead and off her left shoulder, not shoulder to shoulder.
 * The lead is nudged downstage of centre so the two read as depth rather than
 * as a row.
 */
const MARKS: Record<'solo' | Slot, [number, number, number]> = {
  // Alone, she owns the stage and stands on its axis.
  solo: [0, 0, 0],
  // With a partner, both marks sit off centre so the pair straddles it: the
  // camera orbits, and two figures near the axis crowd each other at the ends
  // of the swing.
  lead: [-0.6, 0, 0.8],
  partner: [1.4, 0, -1.55],
};

/** How much of the lead's presence a partner carries. */
const PARTNER_PRESENCE = 0.82;
import { Environment } from './environment';
import { LightRig } from './rig';
import type { DanceState } from '../choreo/director';

export class Stage {
  readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly retro: ReturnType<typeof createRetroPass>;
  private readonly rig: LightRig;
  private readonly environment: Environment;
  private readonly cast: Record<Slot, Dancer | null> = { lead: null, partner: null };
  private atlases: AtlasCache | null = null;
  /** Increments per slot; only the newest request for a slot may take it. */
  private readonly characterToken: Record<Slot, number> = { lead: 0, partner: 0 };

  private readonly cameraTarget = new THREE.Vector3(0, 1.5, 0);
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // Kept on in production too. captureStream() is specified to work
      // without it, but implementations have historically handed back blank
      // frames from a WebGL canvas whose buffer was already discarded — and a
      // black export is a far worse trade than the small cost of retaining the
      // buffer on a scene this light.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.fog = new THREE.FogExp2(0x05070c, 0.024);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
    this.camera.position.set(0, 3.9, 8.8);

    this.rig = new LightRig(this.scene);
    this.environment = new Environment();
    this.scene.add(this.environment.group);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.7, 0.95);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // Last, after tone mapping and sRGB encoding — a tape deck sits in front of
    // the screen, not inside the lighting.
    this.retro = createRetroPass();
    this.composer.addPass(this.retro);

    this.resize();
  }

  /**
   * Swap in a different avatar. The outgoing dancer is only torn down once the
   * replacement's atlas has arrived, so a mid-performance change never leaves
   * an empty stage.
   *
   * Loads are ordered by a generation token rather than by completion, because
   * atlases differ in size and a request started earlier can finish later. A
   * slow default arriving after a fast deliberate choice would otherwise
   * overwrite it, leaving the picker describing someone who is not on stage.
   * Guarding here rather than in the caller keeps the stage correct whoever
   * calls it.
   *
   * @returns whether this call was the one applied.
   */
  async setCharacter(character: Character, baseUrl: string, slot: Slot = 'lead'): Promise<boolean> {
    const token = ++this.characterToken[slot];
    this.atlases ??= new AtlasCache(baseUrl);
    const { texture, meta } = await this.atlases.load(character.id);

    // Superseded while the atlas was in flight — drop it before building
    // anything, so a stale load costs nothing but the fetch.
    if (token !== this.characterToken[slot]) return false;

    const dancer = new Dancer(texture, meta, BASE_HEIGHT * (character.scale ?? 1));
    dancer.presence = slot === 'partner' ? PARTNER_PRESENCE : 1;

    const outgoing = this.cast[slot];
    this.cast[slot] = dancer;
    this.scene.add(dancer.group);
    this.applyMarks();

    if (outgoing) {
      this.scene.remove(outgoing.group);
      outgoing.dispose();
    }
    return true;
  }

  /** Clear a slot. Bumps the token so an in-flight load cannot revive it. */
  clearSlot(slot: Slot) {
    this.characterToken[slot]++;
    const outgoing = this.cast[slot];
    if (!outgoing) return;
    this.cast[slot] = null;
    this.scene.remove(outgoing.group);
    outgoing.dispose();
    this.applyMarks();
  }

  /**
   * Positions depend on who else is out there: a lone dancer belongs on the
   * stage's axis, a lead sharing it with a partner does not.
   */
  private applyMarks() {
    const paired = this.cast.partner !== null;
    this.cast.lead?.setMark(...MARKS[paired ? 'lead' : 'solo']);
    this.cast.partner?.setMark(...MARKS.partner);
  }

  hasSlot(slot: Slot): boolean {
    return this.cast[slot] !== null;
  }

  /** Run the stage through a tape deck. */
  setRetro(on: boolean) {
    this.retro.enabled = on;
  }

  get retroEnabled(): boolean {
    return this.retro.enabled;
  }

  /**
   * Warm the remaining atlases so switching is instant. Called once the stage
   * is already up, so it never competes with first paint — and the whole cast
   * is smaller than a single sheet used to be, so there is nothing to weigh.
   */
  prefetchCharacters(characters: Character[], baseUrl: string) {
    this.atlases ??= new AtlasCache(baseUrl);
    for (const character of characters) {
      void this.atlases.load(character.id).catch(() => {
        // A failed warm-up is not an error; the real load will report it.
      });
    }
  }

  resize(forcedWidth?: number, forcedHeight?: number) {
    const width = forcedWidth || this.canvas.clientWidth || window.innerWidth || 1280;
    const height = forcedHeight || this.canvas.clientHeight || window.innerHeight || 720;
    const pixelRatio = Math.min(2, window.devicePixelRatio);

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width, height);
    (this.retro.uniforms.uResolution.value as THREE.Vector2).set(
      width * pixelRatio,
      height * pixelRatio,
    );

    this.camera.aspect = width / height;
    // On a narrow viewport, back off so she still fits head-to-toe.
    const portrait = height / Math.max(1, width);
    this.camera.fov = THREE.MathUtils.clamp(30 + portrait * 16, 30, 56);
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param state    the lead's motion; the rig, camera and floor pool follow it
   * @param partner  the partner's own motion, when one is on stage
   */
  render(dt: number, time: number, state: DanceState, partner?: DanceState | null) {
    this.rig.update(dt, state, time);
    this.environment.update(dt, state, time, {
      rim: this.rig.rimColor,
      haze: this.rig.hazeColor,
      floor: this.rig.floorColor,
    });
    // Camera first, so the billboards face where the camera actually ended up.
    this.updateCamera(dt, time, state);
    this.cast.lead?.update(state, this.rig.rimColor, this.camera.position, dt);
    this.cast.partner?.update(partner ?? state, this.rig.rimColor, this.camera.position, dt);

    this.bloom.strength = 0.26 + state.intensity * 0.34 + state.beatPulse * 0.14;
    this.renderer.toneMappingExposure = 1.0 + state.beatPulse * 0.07 * state.intensity;

    if (this.retro.enabled) {
      this.retro.uniforms.uTime.value = time;
      // Tracking errors land on the music instead of drifting past it.
      this.retro.uniforms.uBeat.value = state.beatPulse * (0.35 + state.intensity * 0.65);
    }

    this.composer.render();
  }

  /** Slow, unhurried moves — the stage should never fight the performer. */
  private updateCamera(dt: number, time: number, state: DanceState) {
    const orbit = Math.sin(time * 0.075) * 0.42 * (0.5 + state.intensity * 0.5);
    const radius = 10.4 - state.intensity * 1.0;
    // High enough that the disc reads as a floor rather than a horizon.
    const height = 4.3 + Math.sin(time * 0.11) * 0.3 + state.intensity * 0.3;

    const targetPos = new THREE.Vector3(Math.sin(orbit) * radius, height, Math.cos(orbit) * radius);
    // A gentle push on the downbeat, damped out well before the next one.
    targetPos.multiplyScalar(1 - state.barPulse * 0.012);

    this.camera.position.lerp(targetPos, Math.min(1, dt * 1.1));
    this.cameraTarget.lerp(new THREE.Vector3(state.sway * 0.4, 2.05 + state.lift * 0.35, 0), Math.min(1, dt * 3));
    this.camera.lookAt(this.cameraTarget);
    this.camera.rotation.z += Math.sin(time * 0.19) * 0.006;
  }

  dispose() {
    this.cast.lead?.dispose();
    this.cast.partner?.dispose();
    this.environment.dispose();
    this.rig.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
