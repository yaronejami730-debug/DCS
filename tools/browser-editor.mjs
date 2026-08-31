#!/usr/bin/env node
/** Open a template in the editor and report whether the zone tools work. */
import { chromium } from 'playwright';

const [url, email, password, templateId] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e));
page.on('console', (m) => m.type() === 'error' && errors.push('CONSOLE: ' + m.text()));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.getByLabel('Email').fill(email);
await page.getByLabel('Mot de passe').fill(password);
await page.getByRole('button', { name: 'Se connecter' }).click();
await page.waitForURL('**/dashboard');

await page.goto(`${url}/templates/${templateId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

const text = await page.evaluate(() => document.body.innerText);
console.log('--- texte visible ---');
console.log(text.replace(/\n{2,}/g, '\n').slice(0, 700));

for (const name of ['+ Signature', '+ Tampon', 'Enregistrer', 'Télécharger le PDF']) {
  const btn = page.getByRole('button', { name });
  console.log(`bouton "${name}" :`, (await btn.count()) > 0 ? 'présent' : 'ABSENT');
}
const canvas = await page.locator('canvas').count();
console.log('canvas PDF        :', canvas > 0 ? `${canvas} présent(s)` : 'ABSENT');

await page.screenshot({ path: '/tmp/editor.png', fullPage: true });
console.log('\nerreurs:', errors.length);
errors.slice(0, 8).forEach((e) => console.log('  !', e));
await browser.close();
