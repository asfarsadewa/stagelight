import { describe, expect, it } from 'vitest';
import { findCharacter, headUrl, partnerFor, type CastManifest } from '../src/stage/cast';

const manifest: CastManifest = {
  default: 'shadow',
  characters: [
    { id: 'mint', name: 'Mint', tagline: 'hoodie' },
    { id: 'shadow', name: 'Shadow', tagline: 'kunoichi' },
    { id: 'comtesse', name: 'Comtesse', tagline: 'parasol', scale: 1.14 },
  ],
};

describe('findCharacter', () => {
  it('returns the requested character', () => {
    expect(findCharacter(manifest, 'comtesse').name).toBe('Comtesse');
  });

  it('falls back to the declared default for an unknown id', () => {
    expect(findCharacter(manifest, 'nobody').id).toBe('shadow');
  });

  it('falls back to the declared default when nothing is requested', () => {
    expect(findCharacter(manifest, null).id).toBe('shadow');
  });

  it('falls back to the first entry when the default is itself missing', () => {
    const broken: CastManifest = { ...manifest, default: 'ghost' };
    expect(findCharacter(broken, null).id).toBe('mint');
  });

  it('never returns undefined for a non-empty cast', () => {
    for (const id of ['mint', 'shadow', 'comtesse', 'nope', '', null]) {
      expect(findCharacter(manifest, id).id).toBeTruthy();
    }
  });
});

describe('headUrl', () => {
  it('derives the portrait path from the character id', () => {
    expect(headUrl('/sprites', 'mint')).toBe('/sprites/mint-head.webp');
  });

  it('works under a non-root base path', () => {
    expect(headUrl('/app/sprites', 'comtesse')).toBe('/app/sprites/comtesse-head.webp');
  });
});

describe('partnerFor', () => {
  it('takes the next character in the cast', () => {
    expect(partnerFor(manifest, 'mint')?.id).toBe('shadow');
    expect(partnerFor(manifest, 'shadow')?.id).toBe('comtesse');
  });

  it('wraps around at the end', () => {
    expect(partnerFor(manifest, 'comtesse')?.id).toBe('mint');
  });

  it('never pairs anyone with themselves', () => {
    for (const c of manifest.characters) {
      expect(partnerFor(manifest, c.id)?.id).not.toBe(c.id);
    }
  });

  it('reaches every pairing as the lead changes', () => {
    // With three in the cast this is why no separate partner picker is needed.
    const pairs = new Set(
      manifest.characters.map((c) => [c.id, partnerFor(manifest, c.id)!.id].sort().join('+')),
    );
    expect(pairs.size).toBe(3);
  });

  it('has nobody to offer in a cast of one', () => {
    expect(partnerFor({ default: 'solo', characters: [manifest.characters[0]] }, 'mint')).toBeNull();
  });

  it('falls back to the first character for an unknown lead', () => {
    expect(partnerFor(manifest, 'nobody')?.id).toBe('shadow');
  });
});

describe('cast contract', () => {
  it('gives every character a scale that keeps them a believable size', () => {
    for (const character of manifest.characters) {
      const scale = character.scale ?? 1;
      expect(scale).toBeGreaterThan(0.5);
      expect(scale).toBeLessThan(2);
    }
  });

  it('uses unique ids, since they address both atlas and portrait', () => {
    const ids = manifest.characters.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
