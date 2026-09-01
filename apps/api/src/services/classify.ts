import Anthropic from '@anthropic-ai/sdk';
import { ZONE_TYPE, ZONE_TYPE_LABEL, type ZoneType } from '@scansign/shared';
import { env } from '../env.js';

/**
 * Recognise what a framed mark is, from its cropped image.
 *
 * The operator draws a box on a returned scan and the system says "that is a
 * signature" / "that is a date" — so the type dropdown pre-selects itself
 * instead of being chosen by hand every time. It is Claude vision behind a
 * strict, closed instruction: the answer must be one of the known zone types,
 * because the whole point is to match a captured mark to a zone of the SAME
 * type, and a free-text guess would match nothing.
 *
 * Advisory only. The operator always sees the pick and can override it, so a
 * wrong guess costs a click, never a mis-stamped document. And it is optional
 * infrastructure — no key, no classification, the manual dropdown unchanged.
 */

let client: Anthropic | null = null;
const getClient = (): Anthropic | null => {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
};

export const classificationAvailable = (): boolean => Boolean(env.ANTHROPIC_API_KEY);

const LABELS = ZONE_TYPE.map((t) => `- ${t}: ${ZONE_TYPE_LABEL[t]}`).join('\n');

export interface Classification {
  type: ZoneType | null;
  confidence: number | null;
}

export const classifyMark = async (pngCrop: Uint8Array): Promise<Classification> => {
  const anthropic = getClient();
  if (!anthropic) return { type: null, confidence: null };

  const base64 = Buffer.from(pngCrop).toString('base64');

  const response = await anthropic.messages.create({
    model: env.MARK_CLASSIFY_MODEL,
    max_tokens: 200,
    // Low effort: this is a one-shot visual classification, not a reasoning
    // task, and it runs each time the operator frames a mark.
    output_config: { effort: 'low' },
    system:
      'Tu classes une marque manuscrite recadrée sur un document. Réponds UNIQUEMENT ' +
      'avec un objet JSON {"type": <un des types>, "confidence": <0 à 1>}. ' +
      'Les types possibles sont :\n' +
      LABELS +
      '\nSi tu ne reconnais rien de manuscrit, réponds {"type": null, "confidence": 0}.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
          { type: 'text', text: 'Quel type de marque est-ce ?' },
        ],
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    // The model may wrap the JSON in prose; take the first object.
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as {
      type?: string;
      confidence?: number;
    };
    const type = ZONE_TYPE.includes(parsed.type as ZoneType) ? (parsed.type as ZoneType) : null;
    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null;
    return { type, confidence };
  } catch {
    return { type: null, confidence: null };
  }
};
