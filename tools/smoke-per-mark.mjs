#!/usr/bin/env node
/**
 * Per-mark capture end to end, and the failure it used to produce.
 *
 * Every mark must land in ONE session. A regression that opens a second
 * session for the second mark leaves the first mark's photo orphaned, and the
 * signed document comes back "Photo de signature manquante" — which is exactly
 * what happened in production.
 */
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
  return { status: res.status, body };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log('    ✓ ' + m);

const auth = await call('/auth/login', {
  method: 'POST',
  json: { email: process.argv[2], password: process.argv[3] },
});
token = auth.body.accessToken;

console.log('\n[1] Dossier attendant signature + mention');
const pdf = await makeContractPdf({ title: 'Par marque ' + Date.now(), pages: 2 });
const tf = new FormData();
tf.append('name', 'Par marque ' + Date.now());
tf.append('file', new Blob([pdf], { type: 'application/pdf' }), 't.pdf');
const template = (await call('/templates/upload', { method: 'POST', form: tf })).body;
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
const device = (await call('/devices/register', {
  method: 'POST',
  json: { name: 'iPhone par marque', platform: 'ios', installationId: 'smoke-per-mark' },
})).body;
const folder = (await call('/folders', { method: 'POST', json: { name: 'Par marque ' + Date.now() } })).body;
const up = new FormData();
up.append('files', new Blob([pdf], { type: 'application/pdf' }), 'contrat.pdf');
const withDocs = (await call(`/folders/${folder.id}/documents`, { method: 'POST', form: up })).body;
for (const d of withDocs.documents) {
  if (d.status === 'awaiting_template') {
    await call(`/documents/${d.id}/template`, { method: 'POST', json: { templateId: template.id } });
  }
}
await call(`/folders/${folder.id}/send`, { method: 'POST', json: { deviceId: device.id } });
await call(`/folders/${folder.id}/ack`, { method: 'POST' });
ok('signature + mention attendues');

console.log('\n[2] Une seule session pour les deux marques');
const opened = (await call(`/folders/${folder.id}/signing-sessions?captureMode=per_mark`, {
  method: 'POST',
})).body;
const sid = opened.session.id;
ok(`session ${sid.slice(0, 8)}`);

const photo = await makeSignatureSheetPhoto();
for (const mark of ['signature', 'mention']) {
  const f = new FormData();
  f.append('photo', new Blob([photo], { type: 'image/jpeg' }), `${mark}.jpg`);
  await call(`/signing-sessions/${sid}/photo/${mark}`, { method: 'POST', form: f });
  ok(`photo ${mark} déposée dans la MÊME session`);
}

console.log('\n[3] Le serveur refuse une marque sans photo');
const orphan = (await call(`/folders/${folder.id}/signing-sessions?captureMode=per_mark`, {
  method: 'POST',
})).body;
const bad = await call(`/signing-sessions/${orphan.session.id}/regions`, {
  method: 'POST',
  json: { signature: SHEET_REGIONS.signature },
  expect: [400],
});
ok(`refus immédiat : HTTP ${bad.status} — ${bad.body.error}`);
if (bad.body.code !== 'IMAGE_PROCESSING_FAILED') throw new Error('code d’erreur inattendu');

console.log('\n[4] La bonne session aboutit');
await call(`/signing-sessions/${sid}/regions`, {
  method: 'POST',
  json: { signature: SHEET_REGIONS.signature, mention: SHEET_REGIONS.signature },
});
let final = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const s = (await call(`/signing-sessions/${sid}`)).body;
  if (s.status === 'completed' || s.status === 'error') { final = s; break; }
}
if (!final) throw new Error('timeout');
if (final.status === 'error') throw new Error(`${final.errorCode} — ${final.errorMessage}`);
ok('traitement terminé');

const done = (await call(`/folders/${folder.id}`)).body;
for (const doc of done.documents) {
  if (doc.status !== 'completed') throw new Error(`${doc.filename}: ${doc.status}`);
  ok(`${doc.filename} signé`);
}
await call(`/folders/${folder.id}`, { method: 'DELETE' });
console.log('\n✅ Capture par marque validée : une session, toutes les marques.\n');
