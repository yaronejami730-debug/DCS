import { describe, expect, it } from 'vitest';
import {
  CAPTURE_ORDER,
  HANDWRITTEN_MARKS,
  ZONE_TYPE,
  ZONE_TYPE_INSTRUCTION,
  ZONE_TYPE_LABEL,
  marksToCapture,
  type ZoneType,
} from '../src/status.js';

describe('CAPTURE_ORDER', () => {
  it('covers every mark', () => {
    // A hand-written list dropped `signature_stamp`, so a folder needing a
    // signed stamp was never asked for one and failed at processing with
    // "aucune zone n'a été sélectionnée". Nothing may be left out again.
    expect([...CAPTURE_ORDER].sort()).toEqual([...ZONE_TYPE].sort());
  });

  it('starts with the signature', () => {
    expect(CAPTURE_ORDER[0]).toBe('signature');
  });
});

describe('marksToCapture', () => {
  it('asks for exactly what the folder needs', () => {
    expect(marksToCapture({ signature: 1, mention: 2 })).toEqual(['signature', 'mention']);
    expect(marksToCapture({ stamp: 1 })).toEqual(['stamp']);
  });

  it('includes the combined mark — the case that was being dropped', () => {
    // Two documents in one folder, wanting different things: this is the real
    // folder that failed.
    const needed = marksToCapture({ signature: 1, mention: 2, signature_stamp: 1 });
    expect(needed).toContain('signature_stamp');
    expect(needed).toEqual(['signature', 'signature_stamp', 'mention']);
  });

  it('handles a folder wanting all four legacy marks', () => {
    const needed = marksToCapture({ signature: 1, stamp: 1, mention: 1, signature_stamp: 1 });
    // Not "all of ZONE_TYPE": the list has since grown past these four, and
    // marks the folder does not ask for must not be captured.
    expect([...needed].sort()).toEqual(
      ['signature', 'signature_stamp', 'stamp', 'mention'].sort(),
    );
  });

  it('asks for the extended marks when the templates want them', () => {
    const needed = marksToCapture({ signature: 1, quote_date: 2, checkbox: 1 });
    expect(needed).toEqual(['signature', 'quote_date', 'checkbox']);
  });

  it('ignores marks with a zero count', () => {
    expect(marksToCapture({ signature: 1, stamp: 0, mention: 0 })).toEqual(['signature']);
  });

  it('still asks for a signature when nothing is configured', () => {
    expect(marksToCapture({})).toEqual(['signature']);
  });
});

describe('mark vocabulary', () => {
  it('gives every mark a label and an instruction', () => {
    for (const mark of ZONE_TYPE) {
      expect(ZONE_TYPE_LABEL[mark as ZoneType]).toBeTruthy();
      expect(ZONE_TYPE_INSTRUCTION[mark as ZoneType]).toBeTruthy();
    }
  });

  it('treats every ink mark except the stamp as handwritten', () => {
    // A stamp is a physical die: it reproduces identically and must not vary.
    expect([...HANDWRITTEN_MARKS].sort()).toEqual(
      ZONE_TYPE.filter((m) => m !== 'stamp').sort(),
    );
  });
});
