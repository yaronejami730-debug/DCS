import type { NormalizedRect } from './geometry.js';
import type { ZoneType } from './status.js';

/**
 * The capture sheet — the page of the "attestation simplifiée" the signer
 * actually writes on.
 *
 * It is a form with fiducial markers: four solid black squares in the page
 * corners fix the page in a photograph, and four smaller squares frame each
 * field. From those the server recovers every field's rectangle in the photo
 * without anyone drawing a box, and — because each field is declared here with
 * a type and the documents it is meant for — knows where each mark goes.
 *
 * Both sides read this one file: the console draws the PDF from it, the API
 * detects against it. A field moved here moves in both places at once, which
 * is the only way a printed sheet and its detector can stay in agreement.
 *
 * Coordinates are PDF points on an A4 portrait page, origin TOP-LEFT (the
 * normalized convention of the rest of the code base). The PDF writer flips y.
 */

export const SHEET_PAGE = { width: 595.28, height: 841.89 } as const;

/**
 * Page-corner markers: solid black squares, one per corner, centred `inset`
 * points from both edges. Big enough to survive a phone photo, distinct in
 * size from the field markers so the detector can tell them apart.
 */
export const SHEET_PAGE_MARKER = { inset: 34, size: 22 } as const;

/**
 * Field markers: solid black squares at the four corners of a field, sitting
 * OUTSIDE the field's white area by `gap` points. The gap matters: the crop is
 * the white area alone, so a printed marker never ends up extracted as ink.
 */
export const SHEET_FIELD_MARKER = { size: 9, gap: 6 } as const;

export interface SheetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetField {
  /** Stable identity of the box — what the marker "means". */
  id: string;
  /** Printed above the box, e.g. "ÉTUDE · DEVIS · TAMPON". */
  title: string;
  /** The same, for screens and running text: "Étude · Devis · Tampon". */
  label: string;
  /** What the operator clicks to add this mark's zone on a template: "Signature", "Lu et approuvé"… */
  shortLabel: string;
  /** Printed under the box, tells the signer what to put in it. */
  hint: string;
  /** The kind of mark written here — decides which zones can receive it. */
  type: ZoneType;
  /**
   * Which documents this mark is for, as lowercase accent-free keywords matched
   * against a document's template name and filename. Empty = every document
   * that has a zone of this type (the mention, the name, the date are the same
   * on every contract).
   */
  targets: readonly string[];
  /** The white writing area, in sheet points, origin top-left. */
  rect: SheetRect;
}

export interface CaptureSheetLayout {
  id: string;
  title: string;
  fields: readonly SheetField[];
}

const MARGIN = 48;
const CONTENT_W = SHEET_PAGE.width - MARGIN * 2;

// Row 1: three signature squares, one per document group.
const SIG_GAP = 34;
const SIG_W = (CONTENT_W - SIG_GAP * 2) / 3;
const SIG_H = SIG_W;
const SIG_TOP = 150;

// Row 2: the handwritten mention (left) and the company stamp (right).
const MENTION_TOP = SIG_TOP + SIG_H + 92;
const MENTION_H = 100;
const ROW2_GAP = 34;
const MENTION_W = (CONTENT_W - ROW2_GAP) * 0.6;
const STAMP_W = CONTENT_W - ROW2_GAP - MENTION_W;

// Row 3: name, quote date and invoice date side by side.
const ROW3_TOP = MENTION_TOP + MENTION_H + 78;
const ROW3_H = 74;
const ROW3_GAP = 34;
const NAME_W = (CONTENT_W - ROW3_GAP * 2) * 0.42;
const DATE_W = (CONTENT_W - ROW3_GAP * 2 - NAME_W) / 2;

export const ATTESTATION_SHEET_V1: CaptureSheetLayout = {
  id: 'attestation-v1',
  title: 'Feuille de signature',
  fields: [
    {
      id: 'signature_1',
      title: 'ÉTUDE · DEVIS · ABSENCE DE TAMPON',
      label: 'Étude · Devis · Absence de tampon',
      shortLabel: 'Signature',
      hint: 'Signature du dirigeant',
      type: 'signature',
      // "Absence de tampon" is a document — the attestation a client signs when
      // the company has no stamp — not the stamp mark. Kept as a phrase so a
      // template about the stamp itself never lands here.
      targets: ['etude', 'devis', 'absence de tampon'],
      rect: { x: MARGIN, y: SIG_TOP, width: SIG_W, height: SIG_H },
    },
    {
      id: 'signature_2',
      title: 'AH · STOCKAGE',
      label: 'AH · Stockage',
      shortLabel: 'Signature',
      hint: 'Signature du dirigeant',
      type: 'signature',
      targets: ['ah', 'honneur', 'stockage'],
      rect: { x: MARGIN + SIG_W + SIG_GAP, y: SIG_TOP, width: SIG_W, height: SIG_H },
    },
    {
      id: 'signature_3',
      title: "ATTESTATION DE FIN · ATTESTATION D'INSTALLATION",
      label: "Attestation de fin · Attestation d'installation",
      shortLabel: 'Signature',
      hint: 'Signature du dirigeant',
      type: 'signature',
      targets: ['fin', 'installation'],
      rect: { x: MARGIN + (SIG_W + SIG_GAP) * 2, y: SIG_TOP, width: SIG_W, height: SIG_H },
    },
    {
      id: 'mention',
      title: 'MENTION MANUSCRITE',
      label: 'Mention manuscrite',
      shortLabel: 'Lu et approuvé',
      hint: 'Écrivez à la main : « Lu et approuvé, bon pour accord »',
      type: 'mention',
      targets: [],
      rect: { x: MARGIN, y: MENTION_TOP, width: MENTION_W, height: MENTION_H },
    },
    {
      id: 'stamp',
      title: 'TAMPON DE LA SOCIÉTÉ',
      label: 'Tampon de la société',
      shortLabel: 'Tampon',
      hint: 'Apposez le tampon de la société',
      type: 'stamp',
      // Every document with a stamp zone gets it — a stamp is the same on all.
      targets: [],
      rect: { x: MARGIN + MENTION_W + ROW2_GAP, y: MENTION_TOP, width: STAMP_W, height: MENTION_H },
    },
    {
      id: 'name',
      title: 'NOM ET PRÉNOM DU GÉRANT',
      label: 'Nom et prénom du gérant',
      shortLabel: 'Nom du gérant',
      hint: 'Écrivez à la main : nom, prénom, « le gérant »',
      type: 'free_text',
      targets: [],
      rect: { x: MARGIN, y: ROW3_TOP, width: NAME_W, height: ROW3_H },
    },
    {
      id: 'quote_date',
      title: 'DATE DU DEVIS',
      label: 'Date du devis',
      shortLabel: 'Date du devis',
      hint: 'Écrivez à la main la date du devis',
      type: 'quote_date',
      targets: [],
      rect: { x: MARGIN + NAME_W + ROW3_GAP, y: ROW3_TOP, width: DATE_W, height: ROW3_H },
    },
    {
      id: 'invoice_date',
      title: 'DATE DE FACTURE',
      label: 'Date de facture',
      shortLabel: 'Date de facture',
      hint: 'Écrivez à la main la date de facture',
      type: 'invoice_date',
      // The invoice date goes onto the AH (attestation sur l'honneur) and the
      // attestation de fin de travaux (AFT) — the two documents that quote it.
      targets: ['ah', 'honneur', 'stockage', 'fin', 'aft', 'travaux'],
      rect: {
        x: MARGIN + NAME_W + ROW3_GAP + DATE_W + ROW3_GAP,
        y: ROW3_TOP,
        width: DATE_W,
        height: ROW3_H,
      },
    },
  ],
};

/** Every layout the detector knows. One today; the id is what will tell them apart. */
export const CAPTURE_SHEET_LAYOUTS: readonly CaptureSheetLayout[] = [ATTESTATION_SHEET_V1];

export interface SheetPoint {
  x: number;
  y: number;
}

/** Centres of the four page markers, in sheet points: TL, TR, BR, BL. */
export const sheetPageMarkerCentres = (): [SheetPoint, SheetPoint, SheetPoint, SheetPoint] => {
  const { inset } = SHEET_PAGE_MARKER;
  return [
    { x: inset, y: inset },
    { x: SHEET_PAGE.width - inset, y: inset },
    { x: SHEET_PAGE.width - inset, y: SHEET_PAGE.height - inset },
    { x: inset, y: SHEET_PAGE.height - inset },
  ];
};

/** Centres of a field's four markers, in sheet points: TL, TR, BR, BL. */
export const sheetFieldMarkerCentres = (
  field: SheetField,
): [SheetPoint, SheetPoint, SheetPoint, SheetPoint] => {
  const { size, gap } = SHEET_FIELD_MARKER;
  const offset = gap + size / 2;
  const { x, y, width, height } = field.rect;
  return [
    { x: x - offset, y: y - offset },
    { x: x + width + offset, y: y - offset },
    { x: x + width + offset, y: y + height + offset },
    { x: x - offset, y: y + height + offset },
  ];
};

/** A field's writing area as a normalized rect of the sheet page. */
export const sheetFieldNormalizedRect = (field: SheetField): NormalizedRect => ({
  x: field.rect.x / SHEET_PAGE.width,
  y: field.rect.y / SHEET_PAGE.height,
  width: field.rect.width / SHEET_PAGE.width,
  height: field.rect.height / SHEET_PAGE.height,
});

/** Lowercase, accents stripped, punctuation to spaces — for keyword matching. */
export const normalizeForMatch = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * How specifically this field's keywords name a document with these names:
 * 0 = not at all; otherwise the length of the longest keyword that matched.
 *
 * Keywords match whole words — "ah" does not fire on "cahier" — and a keyword
 * with spaces matches as a phrase, so "absence de tampon" needs those three
 * words in a row. The score lets a phrase win over a short word when a filename
 * carries both (AH_absence_de_tampon… is the "absence de tampon" document, not
 * the AH).
 */
export const sheetFieldTargetScore = (
  field: Pick<SheetField, 'targets'>,
  names: ReadonlyArray<string | null | undefined>,
): number => {
  const joined = names
    .filter((n): n is string => Boolean(n))
    .map((n) => normalizeForMatch(n))
    .filter(Boolean)
    .join(' ');
  if (!joined) return 0;
  const padded = ` ${joined} `;
  let best = 0;
  for (const keyword of field.targets) {
    if (padded.includes(` ${keyword} `)) best = Math.max(best, keyword.length);
  }
  return best;
};

/**
 * Does this field's mark belong on a document with these names? A field with
 * no targets goes everywhere: it is the operator's zones, not this list, that
 * then decide whether the document can receive it.
 */
export const sheetFieldTargetsDocument = (
  field: Pick<SheetField, 'targets'>,
  names: ReadonlyArray<string | null | undefined>,
): boolean => field.targets.length === 0 || sheetFieldTargetScore(field, names) > 0;

/** What the routing needs to know about a document to pick its boxes. */
export interface SheetRoutingDocument {
  filename: string;
  templateName?: string | null;
  /** Explicit box chosen on the template; beats the keywords when set. */
  sheetField?: string | null;
}

/**
 * Which detected boxes go onto this document — at most one per mark type.
 *
 * A signature box is taken when the template names it explicitly, or, failing
 * that, when its keywords match the template's name or the filename. Boxes
 * with no targets (mention, name, date) go everywhere. In every case the
 * document must have a zone of that type: a mark with nowhere to land is not
 * offered. Deterministic: the first matching box in layout order wins.
 */
export const sheetFieldsForDocument = <F extends Pick<SheetField, 'id' | 'type' | 'targets'>>(
  fields: readonly F[],
  document: SheetRoutingDocument,
  zoneTypes: readonly ZoneType[],
): Partial<Record<ZoneType, F>> => {
  const out: Partial<Record<ZoneType, F>> = {};
  const score: Partial<Record<ZoneType, number>> = {};
  const names = [document.templateName, document.filename];
  for (const field of fields) {
    if (!zoneTypes.includes(field.type)) continue;
    // Untargeted fields go everywhere. An explicit choice on the template
    // names a SIGNATURE box and is final for signature fields only — the
    // invoice date is not "signature_2" and must not be refused because the
    // template chose that box. Every other targeted field follows its
    // keywords; the most specific match wins, first in layout order on a tie.
    let s: number;
    if (field.targets.length === 0) s = 1;
    else if (document.sheetField && field.type === 'signature') {
      s = document.sheetField === field.id ? Number.MAX_SAFE_INTEGER : 0;
    } else s = sheetFieldTargetScore(field, names);
    if (s > 0 && s > (score[field.type] ?? 0)) {
      out[field.type] = field;
      score[field.type] = s;
    }
  }
  return out;
};
