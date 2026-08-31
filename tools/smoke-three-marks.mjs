#!/usr/bin/env node
/**
 * The full three-mark flow — signature, stamp and "Lu et approuvé" — in both
 * capture modes, against the running stack.
 *
 *   node tools/smoke-three-marks.mjs <email> <password>
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { makeContractPdf, makeSignatureSheetPhoto, SHEET_REGIONS } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../.env'), quiet: true });

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const [EMAIL, PASSWORD] = [process.argv[2], process.argv[3]];
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
  if (!expect.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log('    ✓ ' + m);

const session = await call('/auth/login', {
  method: 'POST',
  json: { email: EMAIL, password: PASSWORD },
});
token = session.accessToken;
console.log('\n[1] Connexion');
ok(session.user.email);

console.log('\n[2] Template à trois marques, créé sans dossier');
const pdf = await makeContractPdf({ title: 'Devis trois marques ' + Date.now(), pages: 2 });
const form = new FormData();
form.append('name', 'Devis (test 3 marques) ' + Date.now());
form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'devis.pdf');
const template = await call('/templates/upload', { method: 'POST', form });
ok(`template "${template.name}" — ${template.pageCount} page(s), PDF source stocké`);

await call(`/templates/${template.id}`, {
  method: 'PUT',
  json: {
    name: template.name,
    reusable: true,
    documentHash: template.documentHash,
    pageCount: template.pageCount,
    zones: [
      { page: 2, type: 'signature', rect: { x: 0.6, y: 0.78, width: 0.3, height: 0.08 }, index: 0 },
      { page: 2, type: 'stamp', rect: { x: 0.1, y: 0.76, width: 0.18, height: 0.12 }, index: 1 },
      { page: 2, type: 'mention', rect: { x: 0.55, y: 0.68, width: 0.35, height: 0.05 }, index: 2 },
    ],
  },
});
ok('3 zones : signature, tampon, lu et approuvé');

console.log('\n[3] Export annoté du template');
const exportRes = await fetch(`${API}/templates/${template.id}/export`, {
  headers: { authorization: `Bearer ${token}` },
});
const exported = Buffer.from(await exportRes.arrayBuffer());
if (exported.subarray(0, 5).toString() !== '%PDF-') throw new Error('export is not a PDF');
ok(`PDF annoté ${(exported.length / 1024).toFixed(1)} ko (sans document dans un dossier)`);

const device = await call('/devices/register', {
  method: 'POST',
  json: { name: 'iPhone 3-marques', platform: 'ios', installationId: 'smoke-3marks' },
});

const runMode = async (captureMode) => {
  console.log(`\n[4] Parcours complet — mode "${captureMode}"`);
  const folder = await call('/folders', {
    method: 'POST',
    json: { name: `3 marques ${captureMode} ${Date.now()}` },
  });
  const upload = new FormData();
  upload.append('files', new Blob([pdf], { type: 'application/pdf' }), 'devis.pdf');
  const withDocs = await call(`/folders/${folder.id}/documents`, { method: 'POST', form: upload });

  const doc = withDocs.documents[0];
  if (doc.status === 'awaiting_template') {
    await call(`/documents/${doc.id}/template`, { method: 'POST', json: { templateId: template.id } });
    ok('template associé');
  } else {
    ok(`template reconnu automatiquement (${doc.template?.name})`);
  }

  const marks = await call(`/folders/${folder.id}/required-marks`);
  ok(`marques attendues: signature=${marks.signature} tampon=${marks.stamp} mention=${marks.mention}`);
  if (marks.mention < 1) throw new Error('la mention devrait être requise');

  await call(`/folders/${folder.id}/send`, { method: 'POST', json: { deviceId: device.id } });
  await call(`/folders/${folder.id}/ack`, { method: 'POST' });

  const photo = await makeSignatureSheetPhoto();
  let sessionId;

  if (captureMode === 'single') {
    const f = new FormData();
    f.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'c.jpg');
    const created = await call(`/folders/${folder.id}/signing-sessions?captureMode=single`, {
      method: 'POST',
      form: f,
    });
    sessionId = created.session.id;
    ok(`session ouverte, photo ${created.photo.width}x${created.photo.height}`);
    await call(`/signing-sessions/${sessionId}/regions`, {
      method: 'POST',
      json: {
        signature: SHEET_REGIONS.signature,
        stamp: SHEET_REGIONS.stamp,
        // The mention is written where the signature sits on this fixture sheet.
        mention: SHEET_REGIONS.signature,
      },
    });
    ok('3 zones envoyées');
  } else {
    const created = await call(`/folders/${folder.id}/signing-sessions?captureMode=per_mark`, {
      method: 'POST',
    });
    sessionId = created.session.id;
    ok('session ouverte sans photo');
    for (const mark of ['signature', 'stamp', 'mention']) {
      const f = new FormData();
      f.append('photo', new Blob([photo], { type: 'image/jpeg' }), `${mark}.jpg`);
      const r = await call(`/signing-sessions/${sessionId}/photo/${mark}`, { method: 'POST', form: f });
      ok(`photo ${mark} envoyée${r.suggestion ? ' (zone détectée)' : ''}`);
    }
    await call(`/signing-sessions/${sessionId}/regions`, {
      method: 'POST',
      json: {
        signature: SHEET_REGIONS.signature,
        stamp: SHEET_REGIONS.stamp,
        mention: SHEET_REGIONS.signature,
      },
    });
    ok('zones envoyées');
  }

  let final = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const s = await call(`/signing-sessions/${sessionId}`);
    if (s.status === 'completed' || s.status === 'error') { final = s; break; }
  }
  if (!final) throw new Error('timeout');
  if (final.status === 'error') throw new Error(`échec: ${final.errorCode} — ${final.errorMessage}`);
  ok('traitement terminé');
  if (!final.mentionImagePath) throw new Error('la mention détourée est absente');
  ok('mention détourée et stockée');

  const done = await call(`/folders/${folder.id}`);
  if (done.status !== 'completed') throw new Error(`dossier ${done.status}`);
  const { url } = await call(`/documents/${done.documents[0].id}/final-url`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  ok(`PDF signé ${(bytes.length / 1024).toFixed(1)} ko`);
  await call(`/folders/${folder.id}`, { method: 'DELETE' });
};

await runMode('single');
await runMode('per_mark');

console.log('\n✅ Trois marques validées dans les deux modes de capture.\n');
