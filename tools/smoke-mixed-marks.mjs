#!/usr/bin/env node
/**
 * A folder whose documents want DIFFERENT marks — the shape that failed.
 *
 * One document wants a signed stamp plus a mention, the other a plain
 * signature plus a mention. The capture flow has to ask for the union of the
 * three, and each document must then receive only what its own template calls
 * for.
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
  return body;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log('    ✓ ' + m);

const auth = await call('/auth/login', {
  method: 'POST',
  json: { email: process.argv[2], password: process.argv[3] },
});
token = auth.accessToken;

const stamp = Date.now();
const makeTemplate = async (name, zones) => {
  const pdf = await makeContractPdf({ title: `${name} ${stamp}`, pages: 2 });
  const f = new FormData();
  f.append('name', `${name} ${stamp}`);
  f.append('file', new Blob([pdf], { type: 'application/pdf' }), `${name}.pdf`);
  const t = await call('/templates/upload', { method: 'POST', form: f });
  await call(`/templates/${t.id}`, {
    method: 'PUT',
    json: {
      name: t.name,
      reusable: true,
      documentHash: t.documentHash,
      pageCount: t.pageCount,
      zones: zones.map((z, i) => ({ ...z, index: i })),
    },
  });
  return { template: t, pdf };
};

console.log('\n[1] Deux documents aux exigences différentes');
const facture = await makeTemplate('Facture', [
  { page: 2, type: 'signature_stamp', rect: { x: 0.55, y: 0.7, width: 0.34, height: 0.18 } },
  { page: 2, type: 'mention', rect: { x: 0.1, y: 0.72, width: 0.32, height: 0.06 } },
]);
const bilan = await makeTemplate('Bilan', [
  { page: 1, type: 'signature', rect: { x: 0.6, y: 0.78, width: 0.3, height: 0.08 } },
  { page: 1, type: 'mention', rect: { x: 0.1, y: 0.72, width: 0.32, height: 0.06 } },
]);
ok('facture : tampon signé + mention');
ok('bilan   : signature + mention');

const device = await call('/devices/register', {
  method: 'POST',
  json: { name: 'iPhone mixte', platform: 'ios', installationId: 'smoke-mixed' },
});
const folder = await call('/folders', { method: 'POST', json: { name: 'Mixte ' + stamp } });

for (const [label, made] of [['facture', facture], ['bilan', bilan]]) {
  const f = new FormData();
  f.append('files', new Blob([made.pdf], { type: 'application/pdf' }), `${label}.pdf`);
  const res = await call(`/folders/${folder.id}/documents`, { method: 'POST', form: f });
  const doc = res.documents.find((d) => d.filename === `${label}.pdf`);
  if (doc.status === 'awaiting_template') {
    await call(`/documents/${doc.id}/template`, {
      method: 'POST',
      json: { templateId: made.template.id },
    });
  }
}

console.log('\n[2] Les marques demandées couvrent bien les deux');
const marks = await call(`/folders/${folder.id}/required-marks`);
ok(`signature=${marks.signature} tampon_signé=${marks.signature_stamp} mention=${marks.mention}`);
if (marks.signature < 1) throw new Error('signature manquante');
if (marks.signature_stamp < 1) throw new Error('tampon signé manquant — c’est le bug');
if (marks.mention < 1) throw new Error('mention manquante');

await call(`/folders/${folder.id}/send`, { method: 'POST', json: { deviceId: device.id } });
await call(`/folders/${folder.id}/ack`, { method: 'POST' });

console.log('\n[3] Capture des trois marques dans une seule session');
const opened = await call(`/folders/${folder.id}/signing-sessions?captureMode=per_mark`, {
  method: 'POST',
});
const sid = opened.session.id;
const photo = await makeSignatureSheetPhoto();
for (const mark of ['signature', 'signature_stamp', 'mention']) {
  const f = new FormData();
  f.append('photo', new Blob([photo], { type: 'image/jpeg' }), `${mark}.jpg`);
  await call(`/signing-sessions/${sid}/photo/${mark}`, { method: 'POST', form: f });
  ok(`photo ${mark}`);
}

await call(`/signing-sessions/${sid}/regions`, {
  method: 'POST',
  json: {
    signature: SHEET_REGIONS.signature,
    signature_stamp: SHEET_REGIONS.stamp,
    mention: SHEET_REGIONS.signature,
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

console.log('\n[4] Chaque document reçoit ce que SON template demande');
const done = await call(`/folders/${folder.id}`);
for (const doc of done.documents) {
  if (doc.status !== 'completed') throw new Error(`${doc.filename}: ${doc.status} ${doc.errorMessage ?? ''}`);
  const { url } = await call(`/documents/${doc.id}/final-url`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('pas un PDF');
  ok(`${doc.filename} signé — ${(bytes.length / 1024).toFixed(0)} ko`);
}
await call(`/folders/${folder.id}`, { method: 'DELETE' });
console.log('\n✅ Dossier à exigences mixtes validé.\n');
