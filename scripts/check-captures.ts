#!/usr/bin/env node
/** The five user-flow captures must be written by captureFlow(), never by a
 *  bare page.screenshot().
 *
 *  measure_user_flow.py trusts the .json sidecar that captureFlow writes next
 *  to each PNG. A bare screenshot to one of those paths overwrites the picture
 *  and leaves the previous sidecar in place, so the metric keeps scoring a
 *  capture that no longer exists. Catching it here means the bypass cannot be
 *  committed, rather than being discovered later by whoever reads the number.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const METRIC_CAPTURES = ['auth.png', 'inbox.png', 'room-chat.png', 'team.png', 'files.png'];

const specs = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'tests/*.spec.ts'])
  .toString('utf8').split('\0').filter(Boolean);

const violations: string[] = [];
for (const file of specs) {
  const text = readFileSync(file, 'utf8');
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.includes('.screenshot(')) continue;
    const hit = METRIC_CAPTURES.find((name) => line.includes(`docs/screenshots/${name}`));
    if (hit) violations.push(`${file}:${index + 1} writes ${hit} with a bare screenshot; use captureFlow()`);
  }
}

if (violations.length) throw new Error(`Capture bypass:\n  ${violations.join('\n  ')}`);
console.log(`Capture gate: PASS (${METRIC_CAPTURES.length} user-flow captures written only by captureFlow)`);
