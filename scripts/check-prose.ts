import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Em dashes are banned in this repo. The four spec documents are authored
 * outside it and are exempt; everything else that git tracks is checked, so a
 * generated file cannot reintroduce one without failing lint.
 */
const EXEMPT = new Set(['IDEA.md', 'UI.md', 'REUSE.md', 'CHANNEL-PROMPT.md', 'LICENSE']);

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((path) => path.length > 0 && !EXEMPT.has(path));

const violations: string[] = [];
for (const path of tracked) {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  const line = source.split('\n').findIndex((text) => text.includes('\u2014'));
  if (line >= 0) violations.push(`${path}:${line + 1}`);
}

if (violations.length) {
  throw new Error(`Em dash found in: ${violations.join(', ')}`);
}
console.log(`Prose gate: PASS (no em dashes in ${tracked.length} tracked files)`);
