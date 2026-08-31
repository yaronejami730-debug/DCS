#!/usr/bin/env node
/**
 * The per-document variant flow: one variant per document, assigned by the
 * signer, and the assigned variant is what ends up on that document.
 */
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { makeContractPdf, makeSignatureSheetPhoto, SHEET_REGIONS } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../.env'), quiet: true });
const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
let token = '';

const call = async (path, { method = 'GET', json, form, expect = [200, 201, 202] } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json ? { 'content-type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : form,
  });
  const body = await res.json().catch(() => ({}));
  if (!expect.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log('    ✓ ' + m);

const auth = await call('/auth/login', {
  method: 'POST',
  json: { email: process.argv[2], password: process.argv[3] },
});
token = auth.accessToken;

console.log('\n[1] Dossier de quatre documents');
const tpl = await makeContractPdf({ title: 'Variantes ' + Date.now(), pages: 2 });
const tf = new FormData();
tf.append('name', 'Variantes ' + Date.now());
tf.append('file', new Blob([tpl], { type: 'application/pdf' }), 't.pdf');
const template = await call('/templates/upload', { method: 'POST', form: tf });
await call(`/templates/${template.id}`, {
  method: 'PUT',
  json: {
    name: template.name,
    reusable: true,
    documentHash: template.documentHash,
    pageCount: template.pageCount,
    zones: [
      { page: 2, type: 'signature', rect: { x: 0.6, y: 0.78, width: 0.3, height: 0.08 }, index: 0 },
      { page: 2, type: 'mention', rect: { x: 0.1, y: 0.7, width: 0.35, height: 0.06 }, index: 1 },
    ],
  },
});

const device = await call('/devices/register', {
  method: 'POST',
  json: { name: 'iPhone variantes', platform: 'ios', installationId: 'smoke-variants' },
});
const folder = await call('/folders', { method: 'POST', json: { name: 'Variantes ' + Date.now() } });

const names = ['facture.pdf', 'devis.pdf', 'attestation.pdf', 'mandat.pdf'];
const up = new FormData();
for (const n of names) up.append('files', new Blob([tpl], { type: 'application/pdf' }), n);
const withDocs = await call(`/folders/${folder.id}/documents`, { method: 'POST', form: up });
for (const d of withDocs.documents) {
  if (d.status === 'awaiting_template') {
    await call(`/documents/${d.id}/template`, { method: 'POST', json: { templateId: template.id } });
  }
}
ok(`${withDocs.documents.length} documents : ${names.join(', ')}`);

await call(`/folders/${folder.id}/send`, { method: 'POST', json: { deviceId: device.id } });
await call(`/folders/${folder.id}/ack`, { method: 'POST' });

console.log('\n[2] Capture puis variantes');
const photo = await makeSignatureSheetPhoto();
const pf = new FormData();
pf.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'p.jpg');
const session = await call(`/folders/${folder.id}/signing-sessions?captureMode=single`, {
  method: 'POST',
  form: pf,
});
const sid = session.session.id;

const docs = await call(`/signing-sessions/${sid}/documents`);
ok(`la session voit ${docs.items.length} documents à signer`);
if (docs.items.length !== 4) throw new Error('nombre de documents inattendu');

const gen = await call(`/signing-sessions/${sid}/preview-variants`, {
  method: 'POST',
  json: { mark: 'signature', region: SHEET_REGIONS.signature, count: docs.items.length },
});
ok(`${gen.variants.length} variantes générées, une par document`);
if (gen.variants.length !== 4) throw new Error('il faut une variante par document');

const unique = new Set(gen.variants.map((v) => v.dataUrl)).size;
if (unique !== 4) throw new Error('les variantes doivent toutes différer');
ok('les 4 variantes sont distinctes');

// Measure that they differ to the eye, not merely as files.
const norm = async (d) =>
  sharp(Buffer.from(d.split(',')[1], 'base64'))
    .resize(600, 180, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
const base = await norm(gen.variants[0].dataUrl);
for (let i = 1; i < 4; i++) {
  const other = await norm(gen.variants[i].dataUrl);
  let ink = 0;
  let moved = 0;
  for (let j = 3; j < base.length; j += 4) {
    if (base[j] > 32 || other[j] > 32) ink++;
    if (Math.abs(base[j] - other[j]) > 64) moved++;
  }
  const share = (moved / ink) * 100;
  ok(`variante 1 vs ${i + 1} : ${share.toFixed(0)}% de l'encre a bougé`);
  if (share < 40) throw new Error('variation trop faible pour être visible');
}

console.log('\n[3] Attribution : une variante par document');
// facture -> 0, devis -> 1, attestation -> 2, mandat -> 3
const assignment = {};
docs.items.forEach((d, i) => {
  assignment[d.id] = i;
});
for (const d of docs.items) ok(`${d.filename} -> variante ${assignment[d.id] + 1}`);

await call(`/signing-sessions/${sid}/regions`, {
  method: 'POST',
  json: {
    signature: SHEET_REGIONS.signature,
    mention: SHEET_REGIONS.signature,
    assignments: { signature: assignment, mention: assignment },
  },
});

let final = null;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const s = await call(`/signing-sessions/${sid}`);
  if (s.status === 'completed' || s.status === 'error') { final = s; break; }
}
if (!final) throw new Error('timeout');
if (final.status === 'error') throw new Error(`${final.errorCode} — ${final.errorMessage}`);
ok('traitement terminé');

console.log('\n[4] Chaque document a bien reçu une signature différente');
const done = await call(`/folders/${folder.id}`);
const sizes = [];
for (const doc of done.documents) {
  if (doc.status !== 'completed') throw new Error(`${doc.filename}: ${doc.status}`);
  const { url } = await call(`/documents/${doc.id}/final-url`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(`/tmp/assigned-${doc.filename}`, bytes);
  sizes.push(bytes.length);
  ok(`${doc.filename} — ${(bytes.length / 1024).toFixed(0)} ko`);
}
if (new Set(sizes).size !== sizes.length) {
  throw new Error('deux documents ont un contenu identique : les variantes ne sont pas appliquées');
}
ok('les quatre PDF diffèrent — chaque document porte sa propre variante');

await call(`/folders/${folder.id}`, { method: 'DELETE' });
console.log('\n✅ Variantes par document validées.\n');
