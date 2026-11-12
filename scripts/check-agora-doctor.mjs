#!/usr/bin/env node
// Fails when this repo's copy of the agora-doctor runner or command drifts from the reference copy
// @adonis-agora/durable publishes (dist/agora-doctor/*.ts.txt). Every @adonis-agora lib runs it in CI.
//
//   node scripts/check-agora-doctor.mjs \
//     [--reference-dir node_modules/@adonis-agora/durable/dist/agora-doctor] \
//     [--runner packages/<pkg>/src/doctor/agora_doctor.ts] \
//     [--command packages/<pkg>/commands/agora_doctor.ts]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const referenceDir = resolve(
  opt('reference-dir', 'node_modules/@adonis-agora/durable/dist/agora-doctor'),
);
const pairs = [
  [opt('runner', 'packages/adonis/src/doctor/agora_doctor.ts'), 'agora_doctor.ts.txt'],
  [opt('command', 'packages/adonis/commands/agora_doctor.ts'), 'agora_doctor_command.ts.txt'],
];

let failed = false;
for (const [local, reference] of pairs) {
  const [mine, theirs] = await Promise.all([
    readFile(resolve(local), 'utf8'),
    readFile(resolve(referenceDir, reference), 'utf8').catch(() => null),
  ]);
  if (theirs === null) {
    console.error(`agora-doctor: reference ${reference} not found in ${referenceDir}`);
    failed = true;
  } else if (mine !== theirs) {
    console.error(
      `agora-doctor: ${local} differs from the reference ${reference}. Copy it verbatim.`,
    );
    failed = true;
  } else {
    console.log(`agora-doctor: ${local} matches the reference.`);
  }
}
process.exit(failed ? 1 : 0);
