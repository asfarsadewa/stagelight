import * as THREE from 'three';
import type { AtlasMeta } from './dancer';

/**
 * The cast of avatars.
 *
 * Every character is drawn to the same twelve-pose contract, in the same frame
 * order, so the entire choreography and transition grammar is shared — swapping
 * avatar is genuinely just a different sheet of paper.
 */
export interface Character {
  id: string;
  name: string;
  /** One short line for the picker. */
  tagline: string;
  /**
   * Multiplier on the stage height. Atlases are normalised against their own
   * tallest pose, so a character carrying a prop above her head ends up drawn
   * smaller; this puts them back on equal footing.
   */
  scale?: number;
}

export interface CastManifest {
  default: string;
  characters: Character[];
}

export interface LoadedAtlas {
  texture: THREE.Texture;
  meta: AtlasMeta;
}

/** Base plane height in stage units before a character's own scale is applied. */
export const BASE_HEIGHT = 3.4;

export async function loadCast(baseUrl: string): Promise<CastManifest> {
  const response = await fetch(`${baseUrl}/characters.json`);
  if (!response.ok) throw new Error('Could not load the cast list');
  const manifest = (await response.json()) as CastManifest;
  if (!manifest.characters?.length) throw new Error('The cast list is empty');
  return manifest;
}

/**
 * Portraits are cut from the atlas itself by `tools/build_heads.py`, so the
 * face on the picker is the face that appears on stage and cannot drift from
 * it. The path is derived rather than listed, like the atlas.
 */
export function headUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/${id}-head.webp`;
}

/**
 * Who stands behind the lead: the next character in the cast, wrapping.
 *
 * With three in the cast this reaches every possible pairing, so no separate
 * partner picker is needed — changing the lead cycles the pair.
 */
export function partnerFor(manifest: CastManifest, leadId: string): Character | null {
  const list = manifest.characters;
  if (list.length < 2) return null;
  const at = list.findIndex((c) => c.id === leadId);
  return list[(Math.max(0, at) + 1) % list.length];
}

export function findCharacter(manifest: CastManifest, id: string | null): Character {
  return (
    manifest.characters.find((c) => c.id === id) ??
    manifest.characters.find((c) => c.id === manifest.default) ??
    manifest.characters[0]
  );
}

/**
 * Atlases are cached after first use, so switching back to a character already
 * seen is instant and costs no network.
 */
export class AtlasCache {
  private readonly entries = new Map<string, Promise<LoadedAtlas>>();

  constructor(private readonly baseUrl: string) {}

  load(id: string): Promise<LoadedAtlas> {
    const cached = this.entries.get(id);
    if (cached) return cached;

    const pending = this.fetch(id).catch((err) => {
      // Do not cache a failure; a retry should be able to succeed.
      this.entries.delete(id);
      throw err;
    });
    this.entries.set(id, pending);
    return pending;
  }

  private async fetch(id: string): Promise<LoadedAtlas> {
    const meta: AtlasMeta = await fetch(`${this.baseUrl}/${id}-atlas.json`).then((r) => {
      if (!r.ok) throw new Error(`Could not load the sprite atlas for ${id}`);
      return r.json();
    });
    const texture = await new THREE.TextureLoader().loadAsync(`${this.baseUrl}/${meta.image}`);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { texture, meta };
  }

  dispose() {
    for (const pending of this.entries.values()) {
      void pending.then(({ texture }) => texture.dispose()).catch(() => {});
    }
    this.entries.clear();
  }
}
