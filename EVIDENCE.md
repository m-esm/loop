# Verification evidence

Verified on 2026-09-10 in the supplied worktree at `99cd291`, the current
main content through merged PR 2 (room chat), following PR 1 (task live feed).
`git log -5 --oneline` confirmed both merged changes.

## Commands and results

All npm commands used Node 22.23.2:

```sh
export PATH=/Users/moshe/.hermes/node/bin:$PATH
node -v
# v22.23.2
```

Commands run, with output captured under /tmp:

```sh
npm run lint > /tmp/loop-evidence-lint.log 2>&1
npm run test > /tmp/loop-evidence-test.log 2>&1
npm run build > /tmp/loop-evidence-build.log 2>&1
npm run test:e2e > /tmp/loop-evidence-test-e2e.log 2>&1
```

Lint and build exited 0. The sandboxed test and browser commands exited 1:
API hooks could not bind localhost, and the browser server failed to start.
The sandboxed audit also exited 1 because registry DNS was unavailable.
Actual failure excerpts:

```text
  error: 'listen EPERM: operation not permitted 127.0.0.1'
[WebServer] Error: listen EPERM: operation not permitted 127.0.0.1:3100
npm warn audit request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
```

Reran the affected commands with approved local port and registry access:

```sh
npm run test > /tmp/loop-evidence-unrestricted-test.log 2>&1
npm run test:e2e > /tmp/loop-evidence-unrestricted-test-e2e.log 2>&1
npm audit > /tmp/loop-evidence-unrestricted-audit.log 2>&1
```

Each rerun exited 0. No dependency installation or native-module rebuild was
needed. Lint was rerun after updating this tracked document.

Lint tail:

```text
> @loop/types@0.0.0 lint
> eslint src


> @loop/api@0.0.0 lint
> eslint src test


> @loop/web@0.0.0 lint
> eslint app components lib test

Status vocabulary gate: PASS (no mirrored status lists in apps or packages)
Prose gate: PASS (no em dashes in 60 tracked files)
```

Test tail from the successful rerun:

```text
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 135.27175
```

Workspace summaries extracted with
`rg '^# (tests|pass|fail)' /tmp/loop-evidence-unrestricted-test.log`,
in types / API / web order, total 19 passing tests:

```text
# tests 2
# pass 2
# fail 0
# tests 14
# pass 14
# fail 0
# tests 3
# pass 3
# fail 0
```

The tests cover shared composer parsing, message validation and rollback,
task-before-message event ordering, legacy migration preservation, task routes,
atomic event persistence/publication, subscriber isolation, replay across
database pages, heartbeat cleanup, mixed client replay and reconnect backoff.
The browser test adds one passing test, for 20 passing tests across both commands.

Build tail:

```text
> @loop/web@0.0.0 build
> next build

▲ Next.js 16.3.4 (Turbopack)
✓ Running next.config.ts took 1818ms

  Creating an optimized production build ...
✓ Compiled successfully in 1635ms
  Running TypeScript ...
  Finished TypeScript in 1031ms ...
  Collecting page data using 4 workers ...
  Generating static pages using 4 workers (0/3) ...
✓ Generating static pages using 4 workers (3/3) in 236ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
└ ○ /_not-found


○  (Static)  prerendered as static content
```

## Live-update transcript and screenshot

`tests/live-feed.spec.ts` runs independent browser contexts against a real
API and temporary SQLite database. It rejects an unknown composer command
without posting, sends chat text, creates a task through `/task`, and checks
that the other tab's task card receives a status change. It verifies transcript
autoscroll and preserves the reading position when scrolled back, then switches
to Tasks without opening another stream.

The same test creates and updates tasks across tabs, kills and restarts the
API against the same database, replays missed events without duplicate rows
or task-list fetches, and defers reconnection while a tab is hidden.

Actual output excerpt from the successful run:

```text
Running 1 test using 1 worker
```

```text
Tab A submitted the form; Tab B displayed one row in 123ms without navigation or a task-list fetch.
API PATCH changed the task to accepted; Tab B updated the existing row within 1 second.
Killed and restarted API with the same SQLite file. Reconnected using since=21; missed create and status replayed, exactly 3 rows, 0 task-list fetches.
Tab A made no reconnect attempts while simulated hidden; visibilitychange triggered one reconnect and replay.
Saved /tmp/loop-chat.png and /tmp/loop-tasks-list.png at 1440x900; no browser runtime errors.
  ✓  1 tests/live-feed.spec.ts:9:5 › two tabs receive creates and status changes, then reconnect and replay after API restart (5.0s)

  1 passed (7.2s)
```

Existing screenshots were inspected and left unchanged.
`sips -g pixelWidth -g pixelHeight docs/screenshots/*.png` reported
1440x900 for each.

[room-chat.png](docs/screenshots/room-chat.png) shows the Loop project sidebar,
Chat selected beside Tasks, and a Live indicator. Moshe's “Hello room” message
appears above “Build the chat,” a task card marked accepted, owned by Moshe,
with “Done when: Live cards update.” The composer shows Author set to Human,
an empty Message field, keyboard and slash-command guidance, and Send.
The right panel asks the reader to select a task.

[tasks-list.png](docs/screenshots/tasks-list.png) is the retained earlier task
view: task creation fields, rows with distinct states, a Live indicator, and
the selected task's owner and definition of done in the right panel. Its
navigation includes Agents and Files, so it is historical evidence rather
than a fresh rendering of the room-chat revision. The current e2e run wrote
its captures only to /tmp.

## Regression found and fixed

The PR 1 backpressure/replay regression remains relevant: expanded replay
coverage exposed a response being destroyed on backpressure, terminating the
stream. Replay now waits for the socket to drain. The event store is the
durable queue; bus notifications trigger draining without polling, and each
stream holds only a database page at a time.

The current `apps/api/test/routes.test.ts` uses `const count = 555` and
checks unique replay ids before receiving a live event. That test passed in
this run. The original failing revision was not rerun, so its historical
failure counts and output are not presented as current evidence.

## Decisions

- Drizzle with better-sqlite3 and checked-in SQL migrations. Migrations run at
  API startup. No separate database service or Python dependency.
- Keep the referenced 3DVP status semantics. One metadata object in
  `packages/types` derives the status set, active/running helpers and chip
  classes. No mirrored status enum in the SQLite migration.
- Port the reference bus, stream route, status helpers, and client feed.
  Commit each mutation and its event together before publication. Return
  snapshot cursors to close the initial list/subscription gap.
- Drain all missed events across database pages. Full event payloads update
  client state without re-fetching lists.
- The original `events.task_id NOT NULL` foreign key to `tasks` could not
  represent message events. It became nullable `subject_id` plus
  `NOT NULL room_id`, with a room foreign key. Messages and tasks share
  the same event stream.
- Migration `0001_rooms_messages.sql` rebuilds `tasks` and `events`,
  copies existing rows while preserving event ids, and adds room data to
  legacy task payloads. It drops the old tables and is not reversible.
  The legacy migration preservation test passes.
- Rooms are a real table seeded with one `default` row. There is no room
  switching or rooms REST surface yet.
- Composer grammar is a pure `parseComposer` in `packages/types`, used
  by the web composer and API message store so their `/task` grammar
  cannot drift.
- A `/task` post commits and publishes `task_created` before the
  referencing message. Replay from `since=0` therefore receives the task
  before its card. These are ordered commits, not a combined transaction.
- `applyTaskEvent` discriminates on `event.kind` and returns
  `{ tasks, messages }`. Message replay deduplicates ids; task events
  upsert the task used by the card.
- Single local project room, single API process, no authentication.
  Status PATCH accepts any value from the shared vocabulary. Provider
  selection, runner execution and transition policy remain separate work.
- CORS allows both local host spellings by default. Environment overrides
  are documented in README. SSE disables proxy buffering and compression.
- Generated Next instruction files remain gitignored. The tracked-file prose
  gate and status vocabulary gate both pass in this run.

## Dependency audit and invariants

Successful audit command and output:

```sh
npm audit > /tmp/loop-evidence-unrestricted-audit.log 2>&1
```

```text
found 0 vulnerabilities
```

Verified the application event insertion path with structural search:

```sh
ast-grep run -p '$DB.insert($TABLE)' --lang typescript apps packages
```

```text
apps/api/src/message-store.ts:42:      const message = this.database.db.insert(messages).values({
apps/api/src/task-store.ts:33:      const task = this.database.db.insert(tasks).values({
apps/api/src/bus.ts:20:      this.database.db.insert(events).values(mutate()).returning().get(),
```

Only `apps/api/src/bus.ts` inserts into `events` in application code.
Structural searches for raw `exec` and `prepare` calls in API source
found none; the database wrapper delegates migrations to Drizzle. The room
migration copies historical events into its replacement table, preserving ids,
rather than introducing a separate application event path.

Controller discovery found messages, tasks and stream routes, with no rooms
controller. The vocabulary gate rejects mirrored status definitions in apps
and packages; the prose gate checks tracked files. Both passed.

CGC was skipped for this documentation-only change: no symbols or callers
changed. Final `git diff --check` and lint passed, and
`git status --porcelain` listed only `EVIDENCE.md`.
