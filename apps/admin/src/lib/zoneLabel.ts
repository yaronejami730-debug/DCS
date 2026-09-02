import {
  ATTESTATION_SHEET_V1,
  HANDWRITTEN_MARKS,
  ZONE_TYPE_LABEL,
  type ZoneType,
} from '@scansign/shared';

/**
 * What to call a zone, in the sheet's words.
 *
 * A signature zone tied to a box of the sheet is "Signature repère 2"; the
 * second zone tied to the same box is "Variante signature repère 2", because
 * that is what it will receive — a different variant of the same signature.
 * Any other handwritten mark repeated on a document is a variant too.
 */
export interface LabelledZone {
  type: ZoneType;
  sheetField?: string | null;
}

const boxNumber = (fieldId: string): number | null => {
  const boxes = ATTESTATION_SHEET_V1.fields.filter((f) => f.type === 'signature');
  const i = boxes.findIndex((f) => f.id === fieldId);
  return i === -1 ? null : i + 1;
};

export const zoneLabel = <Z extends LabelledZone>(zone: Z, zones: readonly Z[]): string => {
  const before = zones.slice(0, zones.indexOf(zone));
  if (zone.type === 'signature' && zone.sheetField) {
    const n = boxNumber(zone.sheetField);
    const ordinal = before.filter(
      (z) => z.type === 'signature' && z.sheetField === zone.sheetField,
    ).length;
    const base = n ? `Signature repère ${n}` : 'Signature';
    return ordinal > 0 ? `Variante ${base.toLowerCase()}` : base;
  }
  const ordinal = before.filter((z) => z.type === zone.type).length;
  if (ordinal > 0 && HANDWRITTEN_MARKS.includes(zone.type)) {
    return `${ZONE_TYPE_LABEL[zone.type]} · variante ${ordinal + 1}`;
  }
  return ZONE_TYPE_LABEL[zone.type];
};
