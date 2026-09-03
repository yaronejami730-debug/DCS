import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_SHEET_V1,
  SHEET_PAGE,
  sheetFieldMarkerCentres,
  sheetFieldTargetsDocument,
  sheetFieldsForDocument,
  sheetPageMarkerCentres,
} from '../src/index.js';

const byId = (id: string) => ATTESTATION_SHEET_V1.fields.find((f) => f.id === id)!;

describe('capture sheet layout', () => {
  it('keeps every field and its markers inside the page, without overlaps', () => {
    const rects = ATTESTATION_SHEET_V1.fields.map((f) => f.rect);
    for (const f of ATTESTATION_SHEET_V1.fields) {
      for (const c of sheetFieldMarkerCentres(f)) {
        expect(c.x).toBeGreaterThan(0);
        expect(c.y).toBeGreaterThan(0);
        expect(c.x).toBeLessThan(SHEET_PAGE.width);
        expect(c.y).toBeLessThan(SHEET_PAGE.height);
      }
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    // Field markers must stay clear of the page markers.
    for (const p of sheetPageMarkerCentres()) {
      for (const f of ATTESTATION_SHEET_V1.fields) {
        for (const c of sheetFieldMarkerCentres(f)) {
          expect(Math.hypot(c.x - p.x, c.y - p.y)).toBeGreaterThan(30);
        }
      }
    }
  });

  it('has exactly three signature boxes with disjoint document groups', () => {
    const sigs = ATTESTATION_SHEET_V1.fields.filter((f) => f.type === 'signature');
    expect(sigs).toHaveLength(3);
    const all = sigs.flatMap((f) => f.targets);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('sheetFieldTargetsDocument', () => {
  it('matches accent-free whole words in the template name or filename', () => {
    const s1 = byId('signature_1');
    expect(sheetFieldTargetsDocument(s1, ['Devis'])).toBe(true);
    expect(sheetFieldTargetsDocument(s1, ["Documents d'étude"])).toBe(true);
    expect(sheetFieldTargetsDocument(s1, [null, 'absence-de-tampon-2024.pdf'])).toBe(true);
    // The stamp itself is not the "absence de tampon" document.
    expect(sheetFieldTargetsDocument(s1, ['Tampon société'])).toBe(false);
    expect(sheetFieldTargetsDocument(s1, ['Attestation de stockage'])).toBe(false);

    const s2 = byId('signature_2');
    expect(sheetFieldTargetsDocument(s2, ['AH'])).toBe(true);
    expect(sheetFieldTargetsDocument(s2, ["Attestation sur l'honneur"])).toBe(true);
    // "ah" must not fire inside another word.
    expect(sheetFieldTargetsDocument(s2, ['Cahier des charges'])).toBe(false);

    const s3 = byId('signature_3');
    expect(sheetFieldTargetsDocument(s3, ["Attestation de fin d'installation"])).toBe(true);
    expect(sheetFieldTargetsDocument(s2, ["Attestation de fin d'installation"])).toBe(false);
  });

  it('sends untargeted fields everywhere', () => {
    expect(sheetFieldTargetsDocument(byId('mention'), ['anything'])).toBe(true);
    expect(sheetFieldTargetsDocument(byId('quote_date'), [])).toBe(true);
  });
});

describe('sheetFieldsForDocument', () => {
  const fields = ATTESTATION_SHEET_V1.fields;

  it('picks the signature of the right group plus the shared marks the document has zones for', () => {
    const picked = sheetFieldsForDocument(
      fields,
      { filename: 'contrat.pdf', templateName: 'Attestation de stockage' },
      ['signature', 'mention', 'quote_date'],
    );
    expect(picked.signature?.id).toBe('signature_2');
    expect(picked.mention?.id).toBe('mention');
    expect(picked.quote_date?.id).toBe('quote_date');
    expect(picked.free_text).toBeUndefined(); // no such zone on the document
  });

  it('sends the "absence de tampon" attestation to group 1 even when its filename starts with AH', () => {
    const picked = sheetFieldsForDocument(
      fields,
      { filename: 'AH_absence_de_tampon_de_societe_DE794260901-2_CLARA_LOIC.pdf', templateName: null },
      ['signature'],
    );
    expect(picked.signature?.id).toBe('signature_1');
    const ah = sheetFieldsForDocument(
      fields,
      { filename: 'AH_DE794251106-10_Monrazel_.pdf', templateName: null },
      ['signature'],
    );
    expect(ah.signature?.id).toBe('signature_2');
  });

  it('lets an explicit template association override the keywords', () => {
    const picked = sheetFieldsForDocument(
      fields,
      { filename: 'devis-1048.pdf', templateName: 'Devis', sheetField: 'signature_3' },
      ['signature'],
    );
    expect(picked.signature?.id).toBe('signature_3');
  });

  it('routes the invoice date by keyword even when the template chose its signature box', () => {
    const picked = sheetFieldsForDocument(
      fields,
      { filename: 'AH_DE794260903-7_SISAHAYE_JEAN.pdf', templateName: 'AH', sheetField: 'signature_2' },
      ['signature', 'stamp', 'invoice_date'],
    );
    expect(picked.signature?.id).toBe('signature_2');
    expect(picked.invoice_date?.id).toBe('invoice_date');
    expect(picked.stamp?.id).toBe('stamp');
    // …and not to a document outside the AH group.
    const fin = sheetFieldsForDocument(
      fields,
      { filename: 'x.pdf', templateName: "Attestation de fin d'installation", sheetField: 'signature_3' },
      ['signature', 'invoice_date'],
    );
    expect(fin.invoice_date).toBeUndefined();
  });

  it('offers no signature to a document no group names', () => {
    const picked = sheetFieldsForDocument(
      fields,
      { filename: 'bon-de-commande.pdf', templateName: 'Bon de commande' },
      ['signature', 'free_text'],
    );
    expect(picked.signature).toBeUndefined();
    expect(picked.free_text?.id).toBe('name');
  });
});
