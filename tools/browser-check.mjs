#!/usr/bin/env node
/** Load the console in a real browser and report every error it produces. */
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
});

let navError = null;
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
} catch (e) {
  navError = String(e);
}
await page.waitForTimeout(2500);

const rootHtml = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length ?? -1);
const bodyText = (await page.evaluate(() => document.body.innerText)).trim();

console.log('URL           :', url);
console.log('nav error     :', navError ?? 'none');
console.log('title         :', await page.title());
console.log('#root size    :', rootHtml, 'chars');
console.log('visible text  :', JSON.stringify(bodyText.slice(0, 300)));
console.log('\npage errors   :', pageErrors.length);
pageErrors.forEach((e) => console.log('  !', e));
console.log('\nconsole       :', consoleErrors.length);
consoleErrors.slice(0, 15).forEach((e) => console.log('  -', e));
console.log('\nfailed reqs   :', failedRequests.length);
failedRequests.slice(0, 15).forEach((e) => console.log('  x', e));

await page.screenshot({ path: process.argv[3] ?? '/tmp/console.png', fullPage: true });
console.log('\nscreenshot ->', process.argv[3] ?? '/tmp/console.png');
await browser.close();
