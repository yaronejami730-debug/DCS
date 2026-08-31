#!/usr/bin/env node
/**
 * Check the ports `start` is about to claim, and say something useful when one
 * is taken.
 *
 * Starting a dev server on a busy port fails with a stack trace that names the
 * port and nothing else, which reads as "the project is broken" when the real
 * situation is "it is already running". This turns that into a sentence.
 *
 * It never kills anything: a process on one of these ports might be another
 * project, and terminating someone's work to free a port is not this script's
 * decision to make.
 */
import { execSync } from 'node:child_process';

const SERVICES = [
  { port: 8787, name: 'API', url: 'http://localhost:8787/health' },
  { port: 5173, name: 'Console web', url: 'http://localhost:5173' },
  { port: 8083, name: 'Metro (Expo)', url: null },
];

const EXTRACTOR = { port: 8000, name: 'Moteur de détourage', url: 'http://127.0.0.1:8000/health' };

const pidOn = (port) => {
  try {
    return execSync(`lsof -ti :${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
};

const commandOf = (pid) => {
  try {
    return execSync(`ps -p ${pid} -o command=`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .slice(0, 90);
  } catch {
    return 'processus inconnu';
  }
};

const busy = SERVICES.map((s) => ({ ...s, pid: pidOn(s.port) })).filter((s) => s.pid);

// The extractor is not started by `start`; it just has to be there.
const extractorPid = pidOn(EXTRACTOR.port);
if (!extractorPid) {
  console.log(
    `\n⚠️  ${EXTRACTOR.name} absent sur le port ${EXTRACTOR.port}.\n` +
      `   Sans lui, le détourage des signatures échouera.\n` +
      `   Lancez-le avec :  pnpm extractor:up\n` +
      `   (ou, sans Docker, voir services/signature-remove-bg/README.md)\n`,
  );
}

if (busy.length === 0) process.exit(0);

console.error('\n❌ Ces services tournent déjà :\n');
for (const s of busy) {
  console.error(`   ${s.name} — port ${s.port} (pid ${s.pid})`);
  console.error(`      ${commandOf(s.pid)}`);
}
console.error(
  '\n   Soit ils font déjà ce que vous voulez — ouvrez simplement\n' +
    '   http://localhost:5173 et rechargez Expo Go.\n' +
    '\n   Soit vous voulez repartir de zéro :\n' +
    `      kill ${busy.map((s) => s.pid).join(' ')}\n` +
    '      npm start\n' +
    '\n   Pour ne relancer qu’une partie :\n' +
    '      pnpm dev:api      pnpm dev:admin      pnpm dev:mobile\n',
);
process.exit(1);
