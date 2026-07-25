import * as THREE from 'three';
import type { DanceState } from '../choreo/director';

const WHITE = new THREE.Color(0xffffff);

export interface AtlasMeta {
  image: string;
  columns: number;
  rows: number;
  frameCount: number;
  cellSize: number;
  /** Where the feet sit inside a cell, as a fraction of cell height from the top. */
  baseline: number;
}

/**
 * The avatar: a billboard of hand-drawn poses that is nevertheless a real
 * citizen of the lit scene — it takes spotlight colour, casts a cut-out shadow,
 * and carries an additive rim halo driven by the back light.
 */
export class Dancer {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly reflection: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly meta: AtlasMeta;
  private readonly maps: THREE.Texture[] = [];
  private currentFrame = -1;
  private readonly height: number;
  private readonly feetFromCenter: number;

  constructor(texture: THREE.Texture, meta: AtlasMeta, height = 3.4) {
    this.meta = meta;
    this.height = height;

    const repeatX = 1 / meta.columns;
    const repeatY = 1 / meta.rows;

    // Three independent texture views over the same image so body, halo and
    // reflection can share one upload but keep their own filtering.
    const makeMap = () => {
      const t = texture.clone();
      t.needsUpdate = true;
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.repeat.set(repeatX, repeatY);
      this.maps.push(t);
      return t;
    };

    const bodyMap = makeMap();
    const haloMap = makeMap();
    const reflectionMap = makeMap();

    const width = height; // atlas cells are square
    const geometry = new THREE.PlaneGeometry(width, height);

    this.body = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        map: bodyMap,
        transparent: true,
        alphaTest: 0.35,
        roughness: 0.62,
        metalness: 0,
        // A little self-illumination keeps her readable when the rig goes dark.
        emissive: new THREE.Color(0x0a0d14),
        side: THREE.DoubleSide,
      }),
    );
    this.body.castShadow = true;
    // Without this the shadow would be the plane's rectangle, not her outline.
    this.body.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: bodyMap,
      alphaTest: 0.5,
    });

    this.halo = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        map: haloMap,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.4,
        color: new THREE.Color(0x59d3ff),
      }),
    );
    this.halo.scale.setScalar(1.035);
    this.halo.position.z = -0.02;
    this.halo.renderOrder = -1;

    // Mirrored below the deck, fading out with distance from the contact point
    // the way a wet floor does. Cheaper and far more controllable than a real
    // planar reflection, and it is the only reflection that has to look right.
    this.reflection = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: reflectionMap },
          // A raw ShaderMaterial gets no uv transform from three, so the atlas
          // cell has to be applied by hand or the quad shows the whole sheet.
          uRepeat: { value: new THREE.Vector2(repeatX, repeatY) },
          uOffset: { value: new THREE.Vector2(0, 0) },
          uStrength: { value: 0.2 },
          uTint: { value: new THREE.Color(0xffffff) },
          // Fraction of the plane, measured up from its bottom edge, where the
          // feet sit — the reflection fades away from there.
          uContact: { value: 1 - meta.baseline },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          uniform vec2 uRepeat;
          uniform vec2 uOffset;
          uniform float uStrength;
          uniform float uContact;
          uniform vec3 uTint;
          varying vec2 vUv;
          void main() {
            vec4 texel = texture2D(uMap, vUv * uRepeat + uOffset);
            if (texel.a < 0.02) discard;
            // The quad is flipped, so vUv.y climbs as we travel away from the floor.
            float distance = max(0.0, vUv.y - uContact) / max(0.001, 1.0 - uContact);
            float fade = pow(1.0 - clamp(distance, 0.0, 1.0), 1.05);
            float a = texel.a * fade * uStrength;
            gl_FragColor = vec4(texel.rgb * uTint, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        // The mirrored quad sits below y=0, so the opaque deck would hide it
        // outright. Skipping the depth test lets it read as an image lying on
        // the floor, which is what a reflection is.
        depthTest: false,
        // Normal blending, not additive: an additive mirror drops every dark
        // part of her and leaves only a bright smear where the shoes were.
        blending: THREE.NormalBlending,
      }),
    );
    this.reflection.scale.y = -1;
    this.reflection.renderOrder = -2;

    // Feet on y = 0: the drawing's baseline sits `baseline` down from the cell top.
    const feetFromCenter = (meta.baseline - 0.5) * height;
    this.feetFromCenter = feetFromCenter;
    this.body.position.y = feetFromCenter;
    this.halo.position.y = feetFromCenter;
    // Flipping about the floor plane puts the mirrored centre as far below y=0
    // as the real one is above it.
    this.reflection.position.y = -feetFromCenter;

    this.group.add(this.reflection, this.halo, this.body);
    this.setFrame(0);
  }

  /** Height of the plane in world units — used to aim lights at her chest. */
  get planeHeight(): number {
    return this.height;
  }

  private setFrame(index: number) {
    if (index === this.currentFrame) return;
    const i = ((index % this.meta.frameCount) + this.meta.frameCount) % this.meta.frameCount;
    const col = i % this.meta.columns;
    const row = Math.floor(i / this.meta.columns);
    const x = col / this.meta.columns;
    const y = 1 - (row + 1) / this.meta.rows;
    for (const map of this.maps) map.offset.set(x, y);
    // The reflection samples the atlas through its own uniforms, so it has to
    // be advanced alongside the shared texture offsets.
    (this.reflection?.material.uniforms.uOffset.value as THREE.Vector2 | undefined)?.set(x, y);
    this.currentFrame = i;
  }

  update(state: DanceState, rimColor: THREE.Color, cameraPosition: THREE.Vector3) {
    this.setFrame(state.frame);

    this.group.position.x = state.sway;
    this.group.position.y = state.lift;
    // Turn to face the camera as it orbits, or the drawing foreshortens and she
    // drifts off her own light pool. 'YXZ' puts the lean inside the billboard
    // rotation, so it stays a screen-space tilt.
    this.group.rotation.order = 'YXZ';
    this.group.rotation.y = Math.atan2(
      cameraPosition.x - this.group.position.x,
      cameraPosition.z - this.group.position.z,
    );
    this.group.rotation.z = state.lean;
    this.group.scale.set(1 / Math.sqrt(state.squash), state.squash, 1);

    const heat = state.beatPulse * (0.35 + state.high * 0.65);
    this.halo.material.color.copy(rimColor);
    this.halo.material.opacity = 0.18 + heat * 0.5 + state.intensity * 0.12;
    this.halo.scale.setScalar(1.02 + heat * 0.045);

    const uniforms = this.reflection.material.uniforms;
    // The group's lift moves both copies up; the mirror image has to travel the
    // same distance the other way, so cancel it twice over.
    this.reflection.position.y = -this.feetFromCenter - state.lift * 2;
    (uniforms.uTint.value as THREE.Color).copy(rimColor).lerp(WHITE, 0.6);
    uniforms.uStrength.value = Math.max(0, 0.62 - state.lift * 0.4) * (0.6 + state.intensity * 0.4);
  }

  dispose() {
    this.body.geometry.dispose();
    this.body.material.dispose();
    this.halo.material.dispose();
    this.reflection.material.dispose();
    this.body.customDepthMaterial?.dispose();
    for (const map of this.maps) map.dispose();
  }
}

export async function loadDancer(baseUrl: string): Promise<{ texture: THREE.Texture; meta: AtlasMeta }> {
  const meta: AtlasMeta = await fetch(`${baseUrl}/dancer-atlas.json`).then((r) => {
    if (!r.ok) throw new Error('Could not load the sprite atlas');
    return r.json();
  });
  const texture = await new THREE.TextureLoader().loadAsync(`${baseUrl}/${meta.image}`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, meta };
}
