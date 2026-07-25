import { describe, expect, it } from 'vitest';
import { exportFileName } from '../src/video/recorder';

describe('exportFileName', () => {
  it('produces the advertised name for a sample track', () => {
    expect(exportFileName('Cosmic Dance')).toBe('cosmic-dance-stagelight.webm');
  });

  it('drops the source extension rather than embedding it', () => {
    expect(exportFileName('Dance Away.mp3')).toBe('dance-away-stagelight.webm');
    expect(exportFileName('track.m4a')).toBe('track-stagelight.webm');
    expect(exportFileName('take.FLAC')).toBe('take-stagelight.webm');
  });

  it('only strips a trailing extension, not one mid-name', () => {
    expect(exportFileName('mp3 collection.wav')).toBe('mp3-collection-stagelight.webm');
  });

  it('collapses punctuation and whitespace into single hyphens', () => {
    expect(exportFileName('01 - Hello,   World! (Remix).mp3')).toBe(
      '01-hello-world-remix-stagelight.webm',
    );
  });

  it('never leaves a leading or trailing hyphen on the slug', () => {
    expect(exportFileName('  ...spaced out...  ')).toBe('spaced-out-stagelight.webm');
    expect(exportFileName('!!!')).toBe('performance-stagelight.webm');
  });

  it('transliterates accents instead of discarding the word', () => {
    expect(exportFileName('Café Über')).toBe('cafe-uber-stagelight.webm');
  });

  it('falls back to a usable name when nothing survives', () => {
    expect(exportFileName('')).toBe('performance-stagelight.webm');
    expect(exportFileName('日本語')).toBe('performance-stagelight.webm');
    expect(exportFileName('.mp3')).toBe('performance-stagelight.webm');
  });

  it('keeps the filename to a sane length', () => {
    const name = exportFileName('a'.repeat(300));
    expect(name.length).toBeLessThanOrEqual(60 + '-stagelight.webm'.length);
    expect(name.endsWith('-stagelight.webm')).toBe(true);
  });

  it('does not end the slug with a hyphen after truncation', () => {
    // 60 characters of slug would land mid-separator without a second trim.
    const name = exportFileName(`${'b'.repeat(59)} tail`);
    expect(name).not.toContain('--stagelight');
    expect(name.endsWith('-stagelight.webm')).toBe(true);
  });

  it('always yields a webm the browser will accept as a download', () => {
    for (const input of ['', '///', 'ok', 'Ünïcödé ✨ Track', 'x'.repeat(500)]) {
      const name = exportFileName(input);
      expect(name).toMatch(/^[a-z0-9-]+-stagelight\.webm$/);
    }
  });
});
