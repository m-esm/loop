import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regenerates EVIDENCE.md from repository facts and the lint/test/build
 * commands. --check compares the committed file to a fresh generation and
 * ignores the parent-commit SHA line so committing the file does not fail
 * the gate.
 */
const CHECK = process.argv.includes('--check');
const INNER = process.env.LOOP_EVIDENCE_INNER === '1';

if (CHECK && INNER) process.exit(0);

const ROOT = process.cwd();
const TARGET = 'EVIDENCE.md';
const SHA_PREFIX = 'Parent commit: ';

function gitLines(args: string[]): string[] {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\0')
    .map((path) => path.replace(/\n$/, ''))
    .filter((path) => path.length > 0)
    .sort();
}

function walkTs(dir: string, hits: string[]) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (['node_modules', 'dist', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(path, hits);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (text.includes('.insert(events)')) hits.push(`${path}:${index + 1}`);
    });
  }
}

function pngSize(path: string): string {
  const buf = readFileSync(path);
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return 'unknown';
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

function specTitles(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const titles: string[] = [];
  const pattern = /\btest\s*\(\s*(['"])([\s\S]*?)\1/;
  let rest = source;
  while (rest.length) {
    const match = pattern.exec(rest);
    if (!match) break;
    titles.push(match[2].replace(/\s+/g, ' '));
    rest = rest.slice((match.index ?? 0) + match[0].length);
  }
  return titles;
}

function runNpm(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number; output: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    npm_config_progress: 'false',
    npm_config_fund: 'false',
    ...extraEnv,
  };
  delete env.FORCE_COLOR;
  const result = spawnSync('npm', args, { encoding: 'utf8', cwd: ROOT, env });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status ?? 1, output };
}

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  return text.split(esc).map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, ''))).join('');
}

function sanitize(text: string): string {
  let out = stripAnsi(text);
  out = out.split(ROOT).join('.');
  const home = process.env.HOME;
  if (home) out = out.split(home).join('~');
  return out
    .split(/\r?\n/)
    .filter((line) => !/duration_ms/i.test(line))
    .filter((line) => !/^\(node:\d+\)/.test(line))
    .map((line) => line
      .replace(/\busing \d+ workers\b/g, 'using workers')
      .replace(/\b(?:in|took) \d+(?:\.\d+)?m?s\b/gi, '')
      .replace(/no em dashes in \d+ tracked files/g, 'no em dashes in tracked files')
      .replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function keepLines(text: string, allow: (line: string) => boolean): string {
  return sanitize(text).split('\n').filter(allow).join('\n').trim();
}

function tapCounts(text: string): { tests: number; pass: number; fail: number; skipped: number } {
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const line of text.split(/\r?\n/)) {
    const match = /^# (tests|pass|fail|skipped) (\d+)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1] as keyof typeof totals;
    totals[key] += Number(match[2]);
  }
  return totals;
}

function comparable(markdown: string): string {
  return markdown.replace(new RegExp(`^${SHA_PREFIX}[0-9a-f]{40}$`, 'm'), `${SHA_PREFIX}<sha>`);
}

function diffSummary(committed: string, generated: string): string {
  const a = comparable(committed).split('\n');
  const b = comparable(generated).split('\n');
  const lines: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && lines.length < 24; i++) {
    if (a[i] === b[i]) continue;
    lines.push(`line ${i + 1}:`);
    if (i < a.length) lines.push(`  committed: ${a[i]}`);
    if (i < b.length) lines.push(`  generated: ${b[i]}`);
  }
  if (a.length !== b.length) lines.push(`line counts: committed ${a.length}, generated ${b.length}`);
  return lines.join('\n');
}

function generate(): string {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const rootPkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    workspaces: string[];
    engines?: { node?: string };
  };
  const workspacePatterns = rootPkg.workspaces;
  const workspaceNames: string[] = [];
  for (const pattern of workspacePatterns) {
    if (!pattern.endsWith('/*')) continue;
    const dir = pattern.slice(0, -2);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      try {
        const name = JSON.parse(readFileSync(join(dir, entry.name, 'package.json'), 'utf8')).name as string;
        workspaceNames.push(name);
      } catch {
        continue;
      }
    }
  }

  const migrations = gitLines(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps/api/migrations/*.sql']);
  // Same --others as migrations and specs: a screenshot written by the run that
  // regenerates this file is still untracked, so a tracked-only listing omits it.
  const screenshots = gitLines(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'docs/screenshots']).map((path) => `${path} ${pngSize(path)}`);
  const insertHits: string[] = [];
  walkTs('apps', insertHits);
  walkTs('packages', insertHits);
  const specFiles = gitLines(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'tests/*.spec.ts']);
  const specs = specFiles.map((file) => ({ file, titles: specTitles(file) }));

  const lint = runNpm(['run', 'lint'], { LOOP_EVIDENCE_INNER: '1' });
  const test = runNpm(['test']);
  const build = runNpm(['run', 'build']);
  const tap = tapCounts(test.output);
  const tapBlock = keepLines(test.output, (line) => /^# (tests|pass|fail|cancelled|skipped|todo) /.test(line) || /^> /.test(line));
  const lintBlock = keepLines(lint.output, (line) => {
    if (!line) return false;
    if (/^> /.test(line)) return true;
    if (/gate: (PASS|FAIL)/.test(line)) return true;
    if (/error/.test(line) && !/^npm error/.test(line)) return true;
    return false;
  });
  const buildBlock = keepLines(build.output, (line) => {
    if (/^> /.test(line)) return true;
    if (/^▲ Next\.js /.test(line)) return true;
    if (/^Route \(app\)/.test(line)) return true;
    if (/^[┌└├│○]/.test(line)) return true;
    if (/^\(Static\)/.test(line) || /^○ {2}\(Static\)/.test(line)) return true;
    if (/Compiled successfully/.test(line)) return true;
    if (/Generating static pages using workers/.test(line)) return true;
    return false;
  });

  const specSection = specs.map((spec) => {
    const titles = spec.titles.length ? spec.titles.map((title) => `- ${title}`).join('\n') : '- (no test() titles found)';
    return `${spec.file}\n${titles}`;
  }).join('\n\n');

  const insertSection = insertHits.length
    ? insertHits.map((hit) => `- ${hit}`).join('\n')
    : '- none';

  const lines = [
    '# Verification evidence',
    '',
    'Generated by `npm run evidence` from repository facts plus the lint, test, and build commands.',
    'Browser tests are listed by spec name and are not executed here.',
    `${SHA_PREFIX}${sha}`,
    'The recorded SHA is the commit the generator ran against. This file is committed afterwards, so the SHA is the parent of the evidence commit. The staleness gate ignores that line.',
    '',
    '## Workspaces',
    '',
    `package.json workspaces: ${workspacePatterns.map((pattern) => `\`${pattern}\``).join(', ')}`,
    `Resolved packages: ${workspaceNames.map((name) => `\`${name}\``).join(', ')}`,
    `Node ${process.version}, engines ${rootPkg.engines?.node ?? 'unspecified'}`,
    '',
    '## Commands and results',
    '',
    `Lint exit ${lint.status}`,
    '',
    '```text',
    lintBlock || '(no stable lint lines)',
    '```',
    '',
    `Test exit ${test.status}. TAP totals: tests ${tap.tests}, pass ${tap.pass}, fail ${tap.fail}, skipped ${tap.skipped}.`,
    '',
    '```text',
    tapBlock || '(no TAP summaries)',
    '```',
    '',
    `Build exit ${build.status}`,
    '',
    '```text',
    buildBlock || '(no stable build lines)',
    '```',
    '',
    '## Browser specs (not executed)',
    '',
    specSection || '(no tests/*.spec.ts files)',
    '',
    '## Migrations',
    '',
    migrations.map((path) => `- ${path}`).join('\n') || '- none',
    '',
    '## Event insertion',
    '',
    `\`insert(events)\` call sites: ${insertHits.length}`,
    insertSection,
    '',
    '## Screenshots',
    '',
    screenshots.map((row) => `- ${row}`).join('\n') || '- none',
    '',
    '## Tree notes',
    '',
    'The runner loads `agents.json` (`LOOP_AGENTS_PATH`, default repo root) at API start and spawns with `shell: false`.',
    'A room owner picks an agent from that catalog; the command never comes from the request. `task.agentId` is the room mention name, resolved through `room_agents` for that room only, then mapped to the catalog command. An unassigned task uses the first room agent whose catalog id is present. An unknown mention or catalog id is claimed then failed through `store.finish`; a room with no runnable agents fails with a message saying so.',
    'Stdout and stderr stream into the task log. Exit 0 finishes `done` with the last nonempty stdout line; nonzero fails with the last nonempty stderr line.',
    'An agent asks by writing a `LOOP_ASK:` line; the runner parks the task in `needs_input` and reruns the same agent with `LOOP_TASK_ANSWER` after a human answers.',
    'An agent proposes by writing a `LOOP_PROPOSE:` JSON line; the runner parks the task in `needs_input` and reruns with `LOOP_TASK_CHOICE` after a human decides. A malformed proposal fails the task.',
    'An agent spawns a child by writing a `LOOP_SPAWN:` JSON line. The parent keeps running. A malformed spawn is logged on the parent and does not fail it. The child is created through the task store so the runner can claim it next.',
    'A finished task can be accepted or rejected. Reject requeues the same agent, clears the previous run, and passes `LOOP_TASK_NOTE` on the next spawn. `parentTaskId` survives finish and send-back.',
    'The seeded echo agent stays first and keeps the `FAIL:` and `ASK:` title conventions so existing browser specs still pass. A second seeded reviewer agent has a different command.',
    'Claim, progress, finish, ask, answer, review, propose, and decide go through the task store; the bus remains the single `insert(events)` path.',
    'Migration `0002_task_run.sql` adds `claimed_by`, `run_id`, `log`, `result`, and `error`.',
    'Migration `0003_task_question.sql` adds `question`, `answer`, and `answered_by`.',
    'Migration `0004_task_agent.sql` adds nullable `agent_id`.',
    'Migration `0005_task_verdict.sql` adds nullable `verdict`, `verdict_note`, and `verdict_by`.',
    'Migration `0006_task_proposal.sql` adds nullable `proposal`, `proposal_choice`, and `proposal_by`.',
    'Migration `0007_task_parent.sql` adds nullable `parent_task_id` referencing `tasks(id)`.',
    'Migration `0008_auth.sql` adds `principals`, `credentials`, `sessions`, and `room_members`, plus nullable `*_principal_id` columns next to the legacy attribution strings.',
    'Migration `0009_room_agents.sql` adds `room_agents` (catalog id, mention name, no command) unique on `(room_id, name)`, and seeds echo and reviewer into the default room.',
    'Migration `0010_invites.sql` adds `invites` (room, email, role, token hash, invited by, accepted at, expires at) unique on token hash and on pending `(room_id, email)`. An owner copies the invite link; Loop does not send email. Register accepts an optional invite token and joins that room in the same transaction that marks the invite accepted.',
    'Migration `0012_room_name.sql` adds `rooms.name` and backfills the seeded default room as Loop. `GET /rooms` lists memberships only. `POST /rooms` inserts the room row, owner membership, and catalog agents in one transaction.',
    'A global guard requires a live `loop_session` cookie except on register, login, and health. Attribution is stamped from the session, not the request body. Agents get principals at boot and never get a session.',
    '',
  ];

  if ([lint.status, test.status, build.status].some((status) => status !== 0)) {
    lines.push('One or more captured commands exited non-zero.');
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const markdown = generate();
if (CHECK) {
  let committed = '';
  try {
    committed = readFileSync(TARGET, 'utf8');
  } catch {
    throw new Error('EVIDENCE.md is missing. Run npm run evidence.');
  }
  if (comparable(committed) !== comparable(markdown)) {
    throw new Error(`EVIDENCE.md is stale. Run npm run evidence.\n${diffSummary(committed, markdown)}`);
  }
  console.log('Evidence gate: PASS (EVIDENCE.md matches regeneration)');
} else {
  writeFileSync(TARGET, markdown);
  console.log('Wrote EVIDENCE.md');
}
