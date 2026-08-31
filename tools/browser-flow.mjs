#!/usr/bin/env node
/** Sign in and walk the console, reporting any error the browser raises. */
import { chromium } from 'playwright';

const [url, email, password] = [
  process.argv[2] ?? 'http://localhost:5173',
  process.argv[3],
  process.argv[4],
];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));

const shot = (n) => page.screenshot({ path: `/tmp/flow-${n}.png`, fullPage: true });

await page.goto(url, { waitUntil: 'networkidle' });
await page.getByLabel('Email').fill(email);
await page.getByLabel('Mot de passe').fill(password);
await page.getByRole('button', { name: 'Se connecter' }).click();

await page.waitForURL('**/dashboard', { timeout: 20000 });
await page.waitForTimeout(2500);
console.log('dashboard :', (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 220));
await shot('dashboard');

for (const [label, path] of [['Dossiers', '/folders'], ['Appareils', '/devices'], ['Templates', '/templates']]) {
  await page.getByRole('link', { name: label }).click();
  await page.waitForURL(`**${path}`, { timeout: 15000 });
  await page.waitForTimeout(1800);
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ');
  console.log(`${label.padEnd(10)}:`, text.slice(0, 200));
  await shot(label.toLowerCase());
}

console.log('\nerreurs   :', errors.length);
errors.slice(0, 10).forEach((e) => console.log('  !', e));
await browser.close();
