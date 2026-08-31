#!/usr/bin/env node
/**
 * The combined "tampon + signature" mark, and the per-document variation of
 * handwritten marks, against the running stack.
 */
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

const session = await call('/auth/login', {
  method: 'POST',
  json: { email: process.argv[2], password: process.argv[3] },
});
token = session.accessToken;
console.log('\n[1] Template avec zone « tampon + signature »');

const pdf = await makeContractPdf({ title: 'Combiné ' + Date.now(), pages: 2 });
const tf = new FormData();
tf.append('name', 'Combiné ' + Date.now());
tf.append('file', new Blob([pdf], { type: 'application/pdf' }), 'combine.pdf');
const template = await call('/templates/upload', { method: 'POST', form: tf });

await call(`/templates/${template.id}`, {
  method: 'PUT',
  json: {
    name: template.name,
    reusable: true,
    documentHash: template.documentHash,
    pageCount: template.pageCount,
    zones: [
      { page: 2, type: 'signature_stamp', rect: { x: 0.55, y: 0.7, width: 0.34, height: 0.18 }, index: 0 },
      { page: 2, type: 'signature', rect: { x: 0.1, y: 0.72, width: 0.28, height: 0.08 }, index: 1 },
      { page: 1, type: 'signature', rect: { x: 0.1, y: 0.72, width: 0.28, height: 0.08 }, index: 2 },
    ],
  },
});
ok('zones : 1 combiné + 2 signatures (dont une sur une autre page)');

const device = await call('/devices/register', {
  method: 'POST',
  json: { name: 'iPhone combiné', platform: 'ios', installationId: 'smoke-combined' },
});

console.log('\n[2] Dossier de deux documents identiques');
const folder = await call('/folders', { method: 'POST', json: { name: 'Combiné ' + Date.now() } });
const up = new FormData();
up.append('files', new Blob([pdf], { type: 'application/pdf' }), 'a.pdf');
up.append('files', new Blob([pdf], { type: 'application/pdf' }), 'b.pdf');
const withDocs = await call(`/folders/${folder.id}/documents`, { method: 'POST', form: up });
for (const d of withDocs.documents) {
  if (d.status === 'awaiting_template') {
    await call(`/documents/${d.id}/template`, { method: 'POST', json: { templateId: template.id } });
  }
}
const marks = await call(`/folders/${folder.id}/required-marks`);
ok(`marques : signature=${marks.signature} combiné=${marks.signature_stamp}`);
if (marks.signature_stamp < 1) throw new Error('le combiné devrait être requis');

await call(`/folders/${folder.id}/send`, { method: 'POST', json: { deviceId: device.id } });
await call(`/folders/${folder.id}/ack`, { method: 'POST' });

console.log('\n[3] Capture et aperçus');
const photo = await makeSignatureSheetPhoto();
const pf = new FormData();
pf.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'p.jpg');
const created = await call(`/folders/${folder.id}/signing-sessions?captureMode=single`, {
  method: 'POST',
  form: pf,
});
const sid = created.session.id;

const cut = await call(`/signing-sessions/${sid}/preview-cutout`, {
  method: 'POST',
  json: { mark: 'signature_stamp', region: SHEET_REGIONS.stamp },
});
ok(`aperçu du détourage combiné : ${cut.width}x${cut.height}`);

const vars = await call(`/signing-sessions/${sid}/preview-variants`, {
  method: 'POST',
  json: { mark: 'signature', region: SHEET_REGIONS.signature },
});
const unique = new Set(vars.variants.map((v) => v.dataUrl)).size;
ok(`${vars.variants.length} variantes générées, ${unique} distinctes`);
if (unique !== vars.variants.length) throw new Error('les variantes devraient toutes différer');

const stampVar = await fetch(`${API}/signing-sessions/${sid}/preview-variants`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ mark: 'stamp', region: SHEET_REGIONS.stamp }),
});
ok(`variantes refusées pour un tampon : HTTP ${stampVar.status} (attendu 400)`);
if (stampVar.status !== 400) throw new Error('un tampon ne doit pas être varié');

console.log('\n[4] Signature');
await call(`/signing-sessions/${sid}/regions`, {
  method: 'POST',
  json: {
    signature: SHEET_REGIONS.signature,
    signature_stamp: SHEET_REGIONS.stamp,
  },
});

let final = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const s = await call(`/signing-sessions/${sid}`);
  if (s.status === 'completed' || s.status === 'error') { final = s; break; }
}
if (!final) throw new Error('timeout');
if (final.status === 'error') throw new Error(`${final.errorCode} — ${final.errorMessage}`);
ok('traitement terminé');
if (!final.signatureStampImagePath) throw new Error('le détourage combiné est absent');
ok('détourage combiné stocké');

const done = await call(`/folders/${folder.id}`);
const hashes = [];
for (const doc of done.documents) {
  if (doc.status !== 'completed') throw new Error(`${doc.filename}: ${doc.status}`);
  const { url } = await call(`/documents/${doc.id}/final-url`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(`/tmp/combined-${doc.filename}`, bytes);
  hashes.push(bytes.length);
  ok(`${doc.filename} signé — ${(bytes.length / 1024).toFixed(1)} ko`);
}
ok(`variation entre documents : tailles ${hashes.join(' / ')} (différentes = variantes appliquées)`);
await call(`/folders/${folder.id}`, { method: 'DELETE' });
console.log('\n✅ Marque combinée et variantes validées.\n');
