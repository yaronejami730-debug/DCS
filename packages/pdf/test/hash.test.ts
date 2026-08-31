import { describe, expect, it } from 'vitest';
import { matchesFilenamePattern, sha256 } from '../src/hash.js';

describe('sha256', () => {
  it('is stable and 64 hex chars', () => {
    const h = sha256(Buffer.from('scan&sign'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(Buffer.from('scan&sign'))).toBe(h);
  });

  it('changes when a single byte changes', () => {
    expect(sha256(Buffer.from('a'))).not.toBe(sha256(Buffer.from('b')));
  });
});

describe('matchesFilenamePattern', () => {
  it('matches wildcards case-insensitively', () => {
    expect(matchesFilenamePattern('contrat-vente-2026.pdf', 'contrat-vente-*.pdf')).toBe(true);
    expect(matchesFilenamePattern('CONTRAT-VENTE-2026.PDF', 'contrat-vente-*.pdf')).toBe(true);
    expect(matchesFilenamePattern('mandat.pdf', 'contrat-vente-*.pdf')).toBe(false);
  });

  it('does not let a dot act as a wildcard', () => {
    expect(matchesFilenamePattern('contratXvente.pdf', 'contrat.vente.pdf')).toBe(false);
  });

  it('supports single-character wildcards', () => {
    expect(matchesFilenamePattern('doc1.pdf', 'doc?.pdf')).toBe(true);
    expect(matchesFilenamePattern('doc12.pdf', 'doc?.pdf')).toBe(false);
  });
});
