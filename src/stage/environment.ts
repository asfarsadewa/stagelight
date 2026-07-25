import * as THREE from 'three';
import type { DanceState } from '../choreo/director';

const STAGE_RADIUS = 7.2;
/** Lowest a haze particle may drift; keeps the deck free of floating specks. */
const HAZE_FLOOR = 1.1;

/**
 * Everything around the avatar: a polished stage disc that genuinely mirrors
 * the rig, drifting haze for the beams to cut through, a pool of bounce light
 * at her feet, and rings that break on the downbeat.
 */
export class Environment {
  readonly group = new THREE.Group();

  private readonly deck: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  private readonly edge: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly pool: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly backdrop: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly haze: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly hazeVelocity: Float32Array;
  private readonly rings: {
    mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
    age: number;
  }[] = [];
  private nextRing = 0;
  private lastBarPhase = 1;

  constructor() {
    // A lit, glossy deck rather than a true mirror. A Reflector costs a second
    // full scene pass and, against a near-black set, returns little more than a
    // smear — the avatar's own mirrored quad sells the reflection far better.
    this.deck = new THREE.Mesh(
      new THREE.CircleGeometry(STAGE_RADIUS, 96),
      new THREE.MeshStandardMaterial({
        color: 0x0a1620,
        // Concentric deck seams. Without them a plain disc viewed near edge-on
        // reads as a dome instead of a floor — the rings supply the perspective.
        map: deckTexture(),
        roughness: 0.42,
        metalness: 0.15,
      }),
    );
    this.deck.rotation.x = -Math.PI / 2;
    this.deck.receiveShadow = true;

    this.edge = new THREE.Mesh(
      new THREE.RingGeometry(STAGE_RADIUS - 0.05, STAGE_RADIUS, 128),
      new THREE.MeshBasicMaterial({
        color: 0x64e0ff,
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.edge.rotation.x = -Math.PI / 2;
    this.edge.position.y = 0.008;

    // Kept small and soft: a wide bright pool washes out the mirrored figure
    // right where the reflection needs to meet her feet.
    this.pool = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({
        map: radialTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.22,
      }),
    );
    this.pool.rotation.x = -Math.PI / 2;
    this.pool.position.y = 0.012;

    this.backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(46, 32, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uTop: { value: new THREE.Color(0x020306) },
          uBottom: { value: new THREE.Color(0x080d15) },
          uGlow: { value: 0.0 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop;
          uniform vec3 uBottom;
          uniform float uGlow;
          varying vec3 vPos;
          void main() {
            float h = clamp(vPos.y / 46.0 * 0.5 + 0.5, 0.0, 1.0);
            vec3 c = mix(uBottom, uTop, pow(h, 0.75));
            // A faint wash behind the stage so she never floats in pure black.
            float halo = smoothstep(0.62, 0.0, length(vPos.xy / 46.0)) * uGlow;
            gl_FragColor = vec4(c + uBottom * halo * 2.2, 1.0);
          }
        `,
      }),
    );

    const { points, velocity } = makeHaze(900);
    this.haze = points;
    this.hazeVelocity = velocity;

    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.0, 96),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.016;
      mesh.visible = false;
      this.rings.push({ mesh, age: Infinity });
      this.group.add(mesh);
    }

    this.group.add(this.deck, this.edge, this.pool, this.backdrop, this.haze);
  }

  update(dt: number, state: DanceState, time: number, colors: { rim: THREE.Color; haze: THREE.Color; floor: THREE.Color }) {
    this.deck.material.color.copy(colors.floor);

    this.edge.material.color.copy(colors.rim);
    // Kept low on purpose: a bright ring here becomes the strongest line in the
    // frame and turns the deck into a horizon.
    this.edge.material.opacity = 0.1 + state.beatPulse * 0.2 + state.intensity * 0.1;

    this.pool.material.color.copy(colors.rim);
    // Only a contact glow — the moving heads already pool light on the deck.
    this.pool.material.opacity = 0.03 + state.bass * 0.07 + state.beatPulse * 0.05;
    this.pool.position.x = state.sway;
    const poolScale = 1 + state.beatPulse * 0.09 + state.intensity * 0.12;
    this.pool.scale.set(poolScale, poolScale, 1);

    const backdropMat = this.backdrop.material;
    (backdropMat.uniforms.uBottom.value as THREE.Color).lerp(colors.haze, Math.min(1, dt * 1.4));
    backdropMat.uniforms.uGlow.value = 0.14 + state.intensity * 0.34;

    this.updateHaze(dt, state, colors.haze);
    this.updateRings(dt, state, colors.rim);

    // A slow breath on the whole rig keeps static shots from feeling dead.
    this.group.rotation.y = Math.sin(time * 0.05) * 0.02;
  }

  private updateHaze(dt: number, state: DanceState, color: THREE.Color) {
    const pos = this.haze.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const drift = 0.35 + state.intensity * 0.75;

    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += this.hazeVelocity[i] * dt * drift;
      arr[i + 1] += this.hazeVelocity[i + 1] * dt * drift;
      arr[i + 2] += this.hazeVelocity[i + 2] * dt * drift;
      // Recycled well clear of the deck: a particle sitting at floor level
      // reads as a speck of dirt on the stage, not as haze in the air.
      if (arr[i + 1] > 12) arr[i + 1] = HAZE_FLOOR;
      if (arr[i + 1] < HAZE_FLOOR) arr[i + 1] = 12;
      const r = Math.hypot(arr[i], arr[i + 2]);
      if (r > 13) {
        arr[i] *= -0.94;
        arr[i + 2] *= -0.94;
      }
    }
    pos.needsUpdate = true;

    this.haze.material.color.copy(color).multiplyScalar(2.4);
    this.haze.material.opacity = 0.16 + state.intensity * 0.22 + state.barPulse * 0.06;
    this.haze.material.size = 0.16 + state.high * 0.1;
  }

  private updateRings(dt: number, state: DanceState, color: THREE.Color) {
    // barPhase wrapping past 1 back to 0 is the downbeat. Nothing is playing
    // while idle, so there are no downbeats to break on.
    if (!state.idle && state.barPhase < this.lastBarPhase) this.spawnRing(color, state.intensity);
    this.lastBarPhase = state.barPhase;

    for (const ring of this.rings) {
      if (ring.age === Infinity) continue;
      ring.age += dt;
      const life = 1.7;
      if (ring.age > life) {
        ring.age = Infinity;
        ring.mesh.visible = false;
        continue;
      }
      const t = ring.age / life;
      const scale = 0.6 + t * (STAGE_RADIUS - 0.6);
      ring.mesh.scale.set(scale, scale, 1);
      ring.mesh.material.opacity = (1 - t) * (1 - t) * 0.28;
    }
  }

  private spawnRing(color: THREE.Color, intensity: number) {
    if (intensity < 0.12) return;
    const ring = this.rings[this.nextRing];
    this.nextRing = (this.nextRing + 1) % this.rings.length;
    ring.age = 0;
    ring.mesh.visible = true;
    ring.mesh.material.color.copy(color);
  }

  dispose() {
    this.deck.geometry.dispose();
    this.deck.material.map?.dispose();
    this.deck.material.dispose();
    this.edge.geometry.dispose();
    this.edge.material.dispose();
    this.pool.geometry.dispose();
    this.pool.material.map?.dispose();
    this.pool.material.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
    this.haze.geometry.dispose();
    this.haze.material.map?.dispose();
    this.haze.material.dispose();
    for (const r of this.rings) {
      r.mesh.geometry.dispose();
      r.mesh.material.dispose();
    }
  }
}

function makeHaze(count: number) {
  const positions = new Float32Array(count * 3);
  const velocity = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(Math.random()) * 12;
    const a = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = HAZE_FLOOR + Math.random() * (12 - HAZE_FLOOR);
    positions[i * 3 + 2] = Math.sin(a) * r;
    velocity[i * 3] = (Math.random() - 0.5) * 0.28;
    velocity[i * 3 + 1] = 0.12 + Math.random() * 0.34;
    velocity[i * 3 + 2] = (Math.random() - 0.5) * 0.28;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.18,
      map: radialTexture(),
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  );
  return { points, velocity };
}

/** Concentric seams on the deck, low contrast — a perspective cue, not decor. */
function deckTexture(): THREE.Texture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const c = size / 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.34)';
  ctx.lineWidth = 2;
  for (let i = 1; i <= 9; i++) {
    ctx.beginPath();
    ctx.arc(c, c, (i / 9) * c * 0.985, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * c * 0.22, c + Math.sin(a) * c * 0.22);
    ctx.lineTo(c + Math.cos(a) * c * 0.985, c + Math.sin(a) * c * 0.985);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Soft round falloff, generated rather than shipped as a file. */
function radialTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
