#!/usr/bin/env node
/**
 * End-to-end smoke test of the whole product, against a running stack.
 *
 * Walks the real workflow, using the real HTTP API, the real Supabase project
 * and the real extraction engine:
 *
 *   sign in -> register a device -> create a folder -> upload two PDFs
 *   -> build a template for each (zones in normalized coordinates)
 *   -> send the folder to the device -> device acknowledges
 *   -> upload the capture photo -> submit the signature/stamp regions
 *   -> poll until processing finishes -> download the signed PDFs
 *
 * Usage:
 *   node tools/smoke.mjs                       # uses SMOKE_EMAIL / SMOKE_PASSWORD
 *   node tools/smoke.mjs you@example.com pass
 *
 * Prerequisites: API on API_URL, extraction engine on SIGNATURE_SERVICE_URL.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { makeContractPdf, makeSignatureSheetPhoto, SHEET_REGIONS } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../.env'), quiet: true });

const API = process.env.API_URL ?? process.env.VITE_API_URL ?? 'http://localhost:8787';
const EMAIL = process.argv[2] ?? process.env.SMOKE_EMAIL;
const PASSWORD = process.argv[3] ?? process.env.SMOKE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('usage: node tools/smoke.mjs <email> <password>   (or set SMOKE_EMAIL/SMOKE_PASSWORD)');
  process.exit(1);
}

let token = '';
const step = (n, label) => console.log(`\n[${n}] ${label}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);

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

// --- 0. preflight ---------------------------------------------------------
step(0, 'Preflight');
const health = await call('/health');
ok(`API up at ${API}`);
if (!health.extractor?.healthy) {
  throw new Error(
    `Extraction engine unreachable at ${health.extractor?.url}. Start it with "pnpm extractor:up".`,
  );
}
ok(`extraction engine "${health.extractor.name}" healthy`);

// --- 1. sign in -----------------------------------------------------------
step(1, 'Sign in (same account the phone uses)');
const session = await call('/auth/login', { method: 'POST', json: { email: EMAIL, password: PASSWORD } });
token = session.accessToken;
ok(`signed in as ${session.user.email}`);

// --- 2. register a device -------------------------------------------------
step(2, 'Register the iPhone');
const device = await call('/devices/register', {
  method: 'POST',
  json: {
    name: 'iPhone Smoke Test',
    platform: 'ios',
    installationId: `smoke-${process.env.USER ?? 'local'}`,
  },
});
ok(`device ${device.name} (${device.id})`);

// --- 3. folder + documents ------------------------------------------------
step(3, 'Create a folder and import two PDFs');
const folder = await call('/folders', { method: 'POST', json: { name: 'Smoke — Contrat véhicule' } });
ok(`folder #${String(folder.reference).padStart(6, '0')}`);

const contrat = await makeContractPdf({ pages: 4 });
const mandat = await makeContractPdf({ title: 'Mandat de gestion', pages: 2 });

const upload = new FormData();
upload.append('files', new Blob([contrat], { type: 'application/pdf' }), 'contrat.pdf');
upload.append('files', new Blob([mandat], { type: 'application/pdf' }), 'mandat.pdf');
const withDocs = await call(`/folders/${folder.id}/documents`, { method: 'POST', form: upload });
ok(`${withDocs.documents.length} documents imported`);
for (const d of withDocs.documents) {
  ok(`  ${d.filename}: ${d.pageCount} pages, status=${d.status}`);
}
if (!withDocs.documents.every((d) => d.status === 'awaiting_template')) {
  ok('  (some documents matched an existing template by hash)');
}

// --- 4. templates ---------------------------------------------------------
step(4, 'Build a template per document');
for (const doc of withDocs.documents) {
  if (doc.status === 'ready') {
    ok(`${doc.filename} already matched template "${doc.template?.name}"`);
    continue;
  }
  const lastPage = doc.pageCount;
  const zones =
    doc.pageCount >= 4
      ? [
          { page: lastPage, type: 'signature', rect: { x: 0.63, y: 0.79, width: 0.28, height: 0.09 }, index: 0 },
          { page: lastPage, type: 'stamp', rect: { x: 0.11, y: 0.77, width: 0.19, height: 0.12 }, index: 0 },
        ]
      : [
          { page: lastPage, type: 'signature', rect: { x: 0.63, y: 0.79, width: 0.28, height: 0.09 }, index: 0 },
        ];

  const template = await call('/templates', {
    method: 'POST',
    json: {
      name: `Smoke — ${doc.filename}`,
      documentHash: doc.documentHash,
      pageCount: doc.pageCount,
      zones,
    },
  });
  await call(`/documents/${doc.id}/template`, { method: 'POST', json: { templateId: template.id } });
  ok(`${doc.filename} -> template "${template.name}" (${zones.length} zones)`);
}

// --- 5. send to the device ------------------------------------------------
step(5, 'Send the folder to the device');
const sent = await call(`/folders/${folder.id}/send`, { method: 'POST', json: { deviceId: device.id } });
ok(`folder status: ${sent.status}`);

step(6, 'Phone acknowledges reception');
const acked = await call(`/folders/${folder.id}/ack`, { method: 'POST' });
ok(`folder status: ${acked.status}`);

// --- 7. capture -----------------------------------------------------------
step(7, 'Upload the capture photo');
const photo = await makeSignatureSheetPhoto();
const photoForm = new FormData();
photoForm.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'capture.jpg');
const created = await call(`/folders/${folder.id}/signing-sessions?captureMode=single`, {
  method: 'POST',
  form: photoForm,
});
ok(`session ${created.session.id}, photo ${created.photo.width}x${created.photo.height}`);
ok(
  `marques attendues: ${Object.entries(created.marks)
    .filter(([, n]) => n > 0)
    .map(([m, n]) => `${m}×${n}`)
    .join(', ')}`,
);
if (created.suggestions?.signature) ok('zones détectées automatiquement');

step(8, 'Submit the signature and stamp regions');
await call(`/signing-sessions/${created.session.id}/regions`, {
  method: 'POST',
  json: { signature: SHEET_REGIONS.signature, stamp: SHEET_REGIONS.stamp },
});
ok('regions accepted, processing queued');

// --- 9. wait --------------------------------------------------------------
step(9, 'Wait for processing');
let final = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const s = await call(`/signing-sessions/${created.session.id}`);
  if (s.status === 'completed' || s.status === 'error') {
    final = s;
    break;
  }
}
if (!final) throw new Error('timed out waiting for processing');
if (final.status === 'error') {
  throw new Error(`processing failed: ${final.errorCode} — ${final.errorMessage}`);
}
ok('session completed');

// --- 10. download ---------------------------------------------------------
step(10, 'Download the signed PDFs');
const done = await call(`/folders/${folder.id}`);
if (done.status !== 'completed') {
  throw new Error(`folder ended as ${done.status}: ${done.errorCode} ${done.errorMessage}`);
}
const outDir = resolve(here, 'fixtures', 'output');
mkdirSync(outDir, { recursive: true });

for (const doc of done.documents) {
  if (doc.status !== 'completed') throw new Error(`${doc.filename} ended as ${doc.status}: ${doc.errorMessage}`);
  const { url, filename } = await call(`/documents/${doc.id}/final-url`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  const path = resolve(outDir, filename);
  writeFileSync(path, bytes);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${filename} is not a PDF`);
  ok(`${filename} — ${(bytes.length / 1024).toFixed(1)} kB -> ${path}`);
}

console.log(`\n✅ End-to-end workflow passed. Signed PDFs in ${outDir}\n`);
