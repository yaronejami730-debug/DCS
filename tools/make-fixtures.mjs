#!/usr/bin/env node
/** Writes the test fixtures to tools/fixtures/. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContractPdf, makeSignatureSheetPhoto } from './fixtures.mjs';

const out = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(out, { recursive: true });

writeFileSync(resolve(out, 'contrat.pdf'), await makeContractPdf());
writeFileSync(resolve(out, 'mandat.pdf'), await makeContractPdf({ title: 'Mandat de gestion', pages: 2 }));
writeFileSync(resolve(out, 'feuille-signature.jpg'), await makeSignatureSheetPhoto());

console.log(`fixtures written to ${out}`);
