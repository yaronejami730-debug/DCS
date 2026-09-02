import { describe, expect, it } from 'vitest';
import { zoneVariantIndex } from '../src/services/variants.js';

describe('zoneVariantIndex', () => {
  it('keeps the first zone on the document variant and gives every other zone a distinct index', () => {
    const seen = new Set<number>();
    for (let doc = 0; doc < 24; doc++) {
      expect(zoneVariantIndex(doc, 0)).toBe(doc);
      for (let k = 0; k < 8; k++) {
        const idx = zoneVariantIndex(doc, k);
        expect(seen.has(idx), `doc ${doc} zone ${k} collides`).toBe(false);
        seen.add(idx);
      }
    }
  });
});
