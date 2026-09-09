# Bootstrap evidence

Verified on 2026-09-10 in the supplied worktree. No commit, push or PR was made.

## Commands and results

The shell defaults to Node 24. All npm commands below used Node 22.23.2:

```sh
export PATH=/Users/moshe/.hermes/node/bin:$PATH
node -v
# v22.23.2
```

Final verification ran sequentially with `set -e`:

```sh
npm run lint > /tmp/loop-lint.log 2>&1
npm run test > /tmp/loop-test.log 2>&1
npm run build > /tmp/loop-build.log 2>&1
npm run test:e2e > /tmp/loop-e2e.log 2>&1
```

The command exited 0 and printed `lint=0 test=0 build=0 browser=0`.

Lint tail:

```text
> lint
> npm run lint --workspaces && eslint scripts tests *.ts *.mjs && node --import tsx scripts/check-vocabulary.ts


> @loop/types@0.0.0 lint
> eslint src


> @loop/api@0.0.0 lint
> eslint src test


> @loop/web@0.0.0 lint
> eslint app components lib test

Status vocabulary gate: PASS (no mirrored status lists in apps or packages)
```

Test tail:

```text
  ---
  duration_ms: 0.277333
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 85.155417
```

Workspace summaries, in types / API / web order, total 13 passing tests:

```text
# tests 1
# pass 1
# fail 0
# tests 10
# pass 10
# fail 0
# tests 2
# pass 2
# fail 0
```

API tests exercise every route: create, snapshot list, get by id, status patch,
and stream replay/live. They cover invalid input, missing tasks, matching
persisted/published ids and payloads, rollback on event failure, subscriber
isolation, 555-event replay across database pages, and the 25-second heartbeat
with disconnect cleanup. The heartbeat test uses Node's mock clock.

Build tail:

```text


> @loop/web@0.0.0 build
> next build

▲ Next.js 16.3.4 (Turbopack)
✓ Running next.config.ts took 17ms

  Creating an optimized production build ...
✓ Compiled successfully in 264ms
  Running TypeScript ...
  Finished TypeScript in 970ms ...
  Collecting page data using 4 workers ...
  Generating static pages using 4 workers (0/3) ...
✓ Generating static pages using 4 workers (3/3) in 233ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
└ ○ /_not-found


○  (Static)  prerendered as static content
```

Boot command:

```sh
npm run dev > /tmp/loop-boot.log 2>&1
```

Boot output excerpt:

```text
[web] - Local:         http://127.0.0.1:3000
[web] ✓ Ready in 269ms
[types] 2:17:09 AM - Found 0 errors. Watching for file changes.
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [NestApplication] Nest application successfully started +1ms
[api] Loop API ready at http://127.0.0.1:3001/api
```

While both processes were running:

```sh
curl -fsS -o /tmp/loop-web.html -w 'GET / => %{http_code}\n' http://localhost:3000
curl -fsS -w '\nGET /api/tasks => %{http_code}\n' http://127.0.0.1:3001/api/tasks
```

```text
GET / => 200
{"tasks":[],"since":0}
GET /api/tasks => 200
```

Stopped the root dev process with Ctrl-C after the smoke check.

Boot log tail, including the requested shutdown:

```text
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [RoutesResolver] TasksController {/api/tasks}: +2ms
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [RouterExplorer] Mapped {/api/tasks, GET} route +1ms
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [RouterExplorer] Mapped {/api/tasks/:id, GET} route +0ms
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [RouterExplorer] Mapped {/api/tasks, POST} route +1ms
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [RouterExplorer] Mapped {/api/tasks/:id/status, PATCH} route +0ms
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [RoutesResolver] StreamController {/api/stream}: +0ms
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [RouterExplorer] Mapped {/api/stream, GET} route +0ms
[api] [Nest] 77548  - 09/10/2026, 2:17:09 AM     LOG [NestApplication] Nest application successfully started +1ms
[api] Loop API ready at http://127.0.0.1:3001/api
[web]  POST /api/platform/runner/heartbeat 404 in 817ms (next.js: 744ms, application-code: 73ms)
[web]  POST /api/platform/runner/heartbeat 404 in 44ms (next.js: 9ms, application-code: 35ms)
[web]  POST /api/platform/runner/heartbeat 404 in 22ms (next.js: 3ms, application-code: 19ms)
[web]  GET / 200 in 139ms (next.js: 119ms, application-code: 21ms)
[types] npm run dev -w @loop/types exited with code SIGINT
--> Sending SIGTERM to other processes..
[api] 2:17:31 AM [tsx] Previous process hasn't exited yet. Force killing...
[web] 
[api] npm run dev -w @loop/api exited with code 0
--> Sending SIGTERM to other processes..
[web] npm run dev -w @loop/web exited with code 0
```

An existing local caller posted to the unimplemented runner heartbeat path
while port 3000 was open; those requests returned 404. The web and tasks
smoke requests returned 200. The dev watcher force-killed its previous child
during the explicit shutdown, then both app commands exited 0.

## Live-update transcript and screenshot

`tests/live-feed.spec.ts` is a headless Playwright test using two independent
browser contexts. It submits the actual form in tab A, asserts tab B's new row
within one second, patches its status through the API, kills the API with
SIGKILL, restarts against the same SQLite file, creates missed events while
clients are offline, and asserts cursor replay without duplicate rows or
task-list fetches. It also simulates hidden visibility in tab A and checks
that reconnection waits for visibilitychange.

Passing output:

```text
Tab A submitted the form; Tab B displayed one row in 274ms without navigation or a task-list fetch.
API PATCH changed the task to accepted; Tab B updated the existing row within 1 second.
Killed and restarted API with the same SQLite file. Reconnected using since=2; missed create and status replayed, exactly 2 rows, 0 task-list fetches.
Tab A made no reconnect attempts while simulated hidden; visibilitychange triggered one reconnect and replay.
Saved docs/screenshots/tasks-list.png at 1440x900 with 3 tasks in different states; no browser runtime errors.
  ✓  1 tests/live-feed.spec.ts:9:5 › two tabs receive creates and status changes, then reconnect and replay after API restart (3.0s)
  1 passed (5.0s)
```

Screenshot: [tasks-list.png](docs/screenshots/tasks-list.png).
Captured headlessly at 1440x900. Inspected the image: all three columns are
visible, three task rows have distinct states, the feed says Live, and the
selected task's owner and definition of done appear in the right panel.

## Regression found and fixed

Expanded replay coverage from 55 to 555 events. The original implementation
destroyed the response on backpressure and failed with this output excerpt:

```text
error: 'terminated'
# pass 8
# fail 1
```

Replay now waits for the socket to drain. The event store is the durable queue;
bus notifications trigger draining without polling. The same 555-event
assertion passes in the final run. Only one database page is held per stream.

## Decisions

- Drizzle with better-sqlite3 and checked-in SQL migrations. Migrations run at
  API startup. No separate database service or Python dependency.
- Keep the referenced 3DVP status semantics. One metadata object in
  `packages/types` derives the status set, active/running helpers and chip
  classes. No mirrored status enum in the SQLite migration.
- Port the reference bus, stream route, status helpers, and client feed.
  Commit each task mutation and its event together before publication.
  Return a snapshot cursor to close the initial list/subscription gap.
- Drain all missed events instead of limiting replay to the last 50.
  Full task payloads update rows directly rather than re-fetching lists.
- The provider manifest was read for its single-source pattern. Provider
  selection and runners belong to a separate step, so this task introduces
  no unused or replacement provider list.
- Single local project room, single API process, no authentication in this
  bootstrap. Status PATCH accepts any value from the shared vocabulary.
  Runner execution and transition policy are outside this task.
- CORS allows both local host spellings by default. Environment overrides
  are documented in README. No response compression middleware is installed;
  SSE sets identity encoding, no-transform and X-Accel-Buffering: no.
- Next dev generated AGENTS.md and CLAUDE.md containing prohibited punctuation.
  They are deleted, gitignored, and `scripts/check-prose.ts` now fails lint if
  an em dash reappears in any tracked file, so regeneration cannot slip through
  review again. No dependency files were modified. The installed Next
  documentation was consulted.

## Dependency audit and invariants

Commands run for dependency setup and audit:

```sh
npm install > /tmp/loop-install.log 2>&1
npm audit --json > /tmp/loop-audit.json
npm update multer > /tmp/loop-dependency-update.log 2>&1
npm audit > /tmp/loop-audit.log 2>&1
npm ls multer
```

The initial audit reported three high findings through Nest's Multer 2.2 pin.
The root override selects Multer 2.3.0, the patched release in the
[upstream advisory](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm).
An initial install retained the stale resolution; targeted `npm update multer`
applied the override. Final audit:

```text
found 0 vulnerabilities
```

Structural discovery used `git ls-files`: the initial tree had seven
documentation/configuration files and no source, so CGC was skipped.
`ast-grep run -p 'new EventSource($$$)' --lang tsx apps/web/components`
located the single client stream owner.

The lint vocabulary gate parses TypeScript and rejects mirrored status arrays,
unions and keyed objects outside the canonical source, across apps and packages.
Protected input documents were not modified. `git diff --check` passed.
