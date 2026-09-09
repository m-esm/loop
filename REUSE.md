# Reuse map: what Loop takes from 3d-vibing-platform and Hermes

Verdicts: **COPY** = drop in with light edits. **PORT** = rewrite the idea in
Loop's stack (NestJS + Next.js, TypeScript). **INSPIRE** = pattern only.

Source roots:
- `3DVP` = `/Users/moshe/Desktop/myprojects/3d-vibing-platform`
- `HERMES` = `/Users/moshe/.hermes`

Skip entirely: everything CAD in 3DVP (`src/`, `cad/`, `stl/`, `tests/`,
`viewer-next/src/lib/viewer/`), and in Hermes `node/` (vendored Node 22) and
`bin/` (vendored uv/tirith/browser-use binaries).

---

## A. Task store, states, lineage (from 3DVP)

| Verdict | Path | What | Size |
|---|---|---|---|
| PORT | `3DVP/viewer-next/src/lib/platform/db.ts` | SQLite store: `tasks`, `events`, `messages`, `runners`, `runner_tokens`, `product_members` DDL (`:449-486`), idempotent column migrations, atomic `claimQueuedTask` (`:859-885`). Only 3D coupling is a product-id validator. | 1020 ts |
| COPY | `3DVP/viewer-next/src/lib/platform/task-status.ts` | One status vocabulary shared by store and UI: `ACTIVE_STATUSES`, `isRunningStatus`, chip class, relative clock. | 73 ts |
| COPY | `3DVP/viewer-next/src/lib/platform/continuation.ts` | Lineage: replying to a finished task queues a new task whose prompt carries a `<continued-from>` fence with parent id, prompt, summary, log, touched files. This is Loop's lineage model. | 268 ts |
| PORT | `3DVP/viewer-next/src/components/TasksPanel.tsx:50-58` (`chainRows`) | Renders continuation chains as nested threads sorted by newest member. | part of 543 |
| COPY | `3DVP/runner/hosted_dispatch.py:354-425` | Per-tenant lease table (concurrency 1) plus `reclaim_stale_leases`: every `running` lease at startup is stale. | ~70 py |

Keep the state machine as is: `queued → accepted → running → needs_input →
done | failed | cancelling → cancelled` (`db.ts:44-56`). `cancelling` exists
because only the runner can confirm the agent process died. 3DVP keeps lineage
in prompt text on purpose (`continuation.ts:11-14`); Loop should add a real
`parent_task_id` column and keep the fence as the prompt payload.

Hermes adds the task record shape Loop's tasks should carry:

| Verdict | Path | What | Size |
|---|---|---|---|
| PORT | `HERMES/scripts/roadmap_gate.py:30-46` | Proposal front-matter: `state: proposed / promoted / building / shipped / killed`, `lens`, `metric`, `before` / `target` / `after`, `measure:` (an executable command), `evidence[]`, `slices: 0/3`. "Verifiable done" as data. | 1032 py |
| PORT | `HERMES/scripts/roadmap_gate.py:22-26` | Promotion is not the proposer's call: peer `REVIEW: <slug> PROMOTE`, a human reaction, or 24h unopposed. `CAP = 5` proposed at once, `EXPIRE_DAYS = 7`. | |
| PORT | `HERMES/scripts/roadmap_gate.py:911-925`, `:1002-1023` | Mode selection (HOLD → GOAL → BUILD → INVENT → BUILD → SLEEP) and the ranked DRAIN QUEUE: housekeeping first, continue an open epic before opening another. | |

---

## B. Runner and agent execution (from 3DVP)

| Verdict | Path | What | Size |
|---|---|---|---|
| PORT | `3DVP/runner/agent_loop.py` | The executor. `run_agent_round` (`:318`): spawn CLI, parse stream-json, post live events, poll cancel mid-round. `_run_rounds` (`:814`): multi-round with `needs_input` and mid-run steering. `finish_with_commit` (`:652`): verify, then commit atomically as `task:<id8>: <prompt>`, rebase-and-retry on push race (`:731-745`), and commit even when verification fails but mark the task `failed` (`:756-762`). Never leave a claimed task in `running` (`:910-930`). CAD coupling is confined to `verify.py` / `preview.py` calls. | 981 py |
| COPY | `3DVP/runner/agents.py` + `runner/agents.json` | Provider abstraction for claude / codex / grok / kimi. One manifest drives runner argv, UI selects, and API validation. Per-provider stream normalizers, `usage_of` token and cost extraction, `can_resume`. Zero 3D. | 295 + 254 |
| COPY | `3DVP/runner/oai_agent.py` | Fallback loop for providers that only offer chat/completions: own Bash/Read/Write/Edit tool dispatch, same block shape as the CLIs. | 298 py |
| COPY | `3DVP/runner/mcp_config.py` | Per-invocation MCP wiring (`kind: file | config-key | none`) so nothing is installed into the user's ambient CLI config. | 206 py |
| PORT | `3DVP/runner/task_context.py` | Prompt assembly with byte budgets: `preload_block` (paste cited source instead of paying a Read round-trip), whole-file vs index fallback, `continued_files_block`, `tasklog_block`. Swap the block sources; keep the budgeting. | 615 py |
| PORT | `3DVP/runner/agent_rules.md` | Standing rules pasted into every task: never re-Read preloaded source, never commit/stash/checkout, `NEEDS_INPUT:` protocol, end with a summary because it is the next task's starting context. ~30% CAD bullets to drop. | 81 md |
| INSPIRE | `3DVP/runner/verify.py` | Verification runs in the harness, not on the agent's word. Commands from the project manifest, full logs to a gitignored cache. | 286 py |
| INSPIRE | `3DVP/runner/preview.py` | Watcher that publishes mid-task artifacts as events, holding a file until size and mtime stop moving. Loop analogue: live preview of build output in the WIP card. | 139 py |

---

## C. Live streaming to the UI (from 3DVP)

| Verdict | Path | What | Size |
|---|---|---|---|
| COPY | `3DVP/viewer-next/src/lib/platform/bus.ts` | Every event insert goes through `emitEvent`, so the row and the live stream cannot diverge. | 38 ts |
| COPY | `3DVP/viewer-next/src/app/api/platform/stream/route.ts` | SSE with `since=` replay of last 50 events, ACL scrubbing computed once at connect, 25s heartbeat, `X-Accel-Buffering: no`. | 108 ts |
| COPY | `3DVP/viewer-next/src/components/TasksFeed.tsx` | Client `EventSource`: jittered backoff (`:31`), reconnect deferred while tab hidden (`:217`), dedupe by `since` plus id set. | 312 tsx |
| PORT | `3DVP/viewer-next/src/app/api/platform/runner/tasks/[id]/events/route.ts` | Runner-to-platform event ingest, bearer-authed, side effects keyed on event `kind`. | 123 ts |
| COPY | `3DVP/viewer-next/src/lib/platform/task-events.ts` + `task-notify.ts` | Which kinds to hide, tool-summary compaction with a regex fallback for truncated runner JSON (`:52-57`), which status transitions deserve an OS notification. | 153 + 34 |

Wire format to keep: runner posts `agent_progress`, `tool_use {name, summary}`,
`context`, `verify`, `committed`, `patch`, `pushed`, `metrics`, `failed`,
`cancelled`. Caps (`text[:8000]`, `summary[:800]`) applied at the runner, not
in the UI. This maps directly onto Loop's WIP card and result card.

---

## D. Queueing from the UI (from 3DVP)

| Verdict | Path | What | Size |
|---|---|---|---|
| PORT | `3DVP/viewer-next/src/app/api/platform/tasks/route.ts` | POST validates agent/model/effort against `agents.json` and checks the user connected that provider. GET batches metrics and continuation parsing to avoid N+1. | 145 ts |
| COPY | `3DVP/viewer-next/src/app/api/platform/runner/tasks/route.ts` | Long-poll claim endpoint: wait up to 60s, 1s ticks, abort-aware, 204 on empty. No message broker needed. | 78 ts |
| PORT | siblings `tasks/[id]/cancel`, `retry`, `continue`, `messages`, `preview` | Small per-action routes. | small |

---

## E. UI components (from 3DVP)

| Verdict | Path | What | Size |
|---|---|---|---|
| INSPIRE / PORT parts | `3DVP/viewer-next/src/components/TasksThread.tsx` | Chat plus log thread: messages and events interleaved by timestamp, tool rows, committed files with diff links, metrics strip, autocomplete composer. Heavily 3D-coupled overall; mine `logLabel`, `LogText`, `ToolRow`, `MetricsStrip` (`:97-330`). | 1001 tsx |
| PORT | `3DVP/viewer-next/src/components/TasksPanel.tsx` | Inbox/board with chain nesting. | 543 tsx |
| PORT | `3DVP/viewer-next/src/components/TasksQueueForm.tsx` | Composer with agent/model/effort selects, remembers last pick. | 230 tsx |
| COPY | `3DVP/viewer-next/src/components/AgentPicker.tsx` | `useAgentProviders()` fetches the registry from the API. No hardcoded model lists. | 215 tsx |
| COPY | `TasksRail.tsx`, `TaskCancel`, `TaskRetry`, `TaskNotifications` | Rail and small action components. | 165 + small |
| COPY | `3DVP/docs/DESIGN-SYSTEM.md` + `viewer-next/src/app/globals.css` + `viewer-next/scripts/verify_tokens.mjs` | OKLCH tokens on one hue, status hues equalized at L 0.78, mono tabular numbers, an explicit "never" list, and a gate that fails raw colors outside `globals.css`. Drop the stage/HUD section. | 122 md + 93 mjs |

---

## F. Auth, tenancy, ACL, sandbox, deploy (from 3DVP)

| Verdict | Path | What | Size |
|---|---|---|---|
| COPY design, PORT code | `3DVP/viewer-next/src/lib/platform/acl.ts` | `roleFor / can / visibleProducts / scrubEvent`. Roles owner / editor / viewer keyed by lowercased email, so sharing to an unregistered address is a pending invite. 404 not 403 on missing view. | 289 ts |
| COPY | `3DVP/viewer-next/src/lib/platform/runnerAuth.ts` | Hashed bearer tokens. The token forces the workspace; routes never honour a client `?workspace=`. | 175 ts |
| PORT | `3DVP/viewer-next/src/lib/platform/llmVault.ts` + `app/api/internal/llm-proxy/[provider]/[...path]/route.ts` | Brokered provider sessions: sandbox gets a short-lived task token, proxy strips auth headers, injects the real credential, records usage. Relevant if Loop agents run on user subscriptions. | 367 + 235 |
| COPY | `3DVP/deploy/sandbox/docker_flags.sh` | Shared flags: `--cap-drop ALL --security-opt no-new-privileges --memory=6g --pids-limit=256 --read-only --tmpfs /tmp`. One file so two entry points cannot drift. | 6 sh |
| COPY | `3DVP/runner/sandbox_cli.sh` | Only the agent CLI runs in the container; stdin/stdout pass through so the loop still parses stream-json. Per-tenant state volume so `--resume` survives `--rm`. | 78 sh |
| PORT | `3DVP/runner/hosted_dispatch.py` | prepare → lease → seed volume → run → harvest → cleanup, `_redact()` on every error string, env save/restore in `finally`. | 780 py |
| COPY pattern | `3DVP/deploy/docker-compose.yml`, `deploy/Caddyfile` | Anchored `x-logging` so no service can opt out of log caps; `/api/internal/*` returns 404 at the edge. | 129 + 30 |
| COPY pattern | `3DVP/viewer-next/scripts/verify_*.mjs` (42 files) | Cheap executable invariants, e.g. `verify_dispatcher_topology.mjs` asserts only the dispatcher has the docker socket. This is Loop's gate mechanism. | ~40 files |
| INSPIRE | `3DVP/docs/PLAN-BYOR-GITHUB.md:29-35`, `viewer-next/src/lib/platform/tenantPush.ts` | Trusted tier does the push: sandbox emits a patch, platform applies it with a minted 1h token onto a non-canonical branch. | 262 md + 209 ts |

---

## G. Agent personas and room briefs (from Hermes)

| Verdict | Path | What | Size |
|---|---|---|---|
| COPY | `HERMES/SOUL.md` | One-line always-on identity injected on every run. | 1 |
| COPY | `HERMES/scripts/channel-job-prompt.md` | The key file. One shared 20-line prompt template; per-agent difference is the computed gate output prepended to it, not hand-written personality. | 20 md |
| PORT | `HERMES/scripts/make-channel-jobs.py` | Generates N per-room agent jobs from one template and a room-to-repo map; upserts preserving ids and history. `jobs.json` is the derived artifact. | 113 py |
| PORT | `HERMES/cron/jobs.json` | Job shape: `prompt`, `skills[]`, `deliver`, `workdir`, `model` / `provider`. Discord only in `deliver`. | 754 json |
| PORT | `HERMES/config.yaml:76` (`display.personality`) | Host-level persona: voice, hours, default labor path, how to address the manager. | 1 field |
| INSPIRE | `HERMES/scripts/gate-3dvp.py` and siblings | 5-line wrappers around a shared gate. Roles as thin config over one engine. | 6 py |

Loop shape: one `AgentRole` prompt template, N role records, one
`computeBrief(role, room)` per turn. Personality is a few lines; the brief is
computed.

---

## H. Turn-taking and conversation protocol (from Hermes)

| Verdict | Path | What | Size |
|---|---|---|---|
| PORT, high priority | `HERMES/scripts/team-forum.py` + its `jobs.json` prompt | A working structured multi-agent conversation. 20 topic slugs (`:62-88`) read back from `TOPIC:` lines in room history so agents do not circle. Closed message grammar `CLAIM / EVIDENCE / PROPOSAL / KILL / Q`, under 14 lines. Peer replies once with `LOCK: <change> owner= proof=` or `DROP: <why>`; `check_proof()` (`:287`) verifies mechanically. Anti-stacking gate: hold the tick while the previous opener is unanswered and younger than `HOLD_HOURS = 6` (`:57`). `MIN_ANSWER_CHARS = 40` (`:119`): an ack is not an answer. Self-retro every `RETRO_EVERY = 5` sessions. Card-leak metric (`:94`, `:691`) counts tool-noise messages dumped into the room. Escalation rule (`:112`): do not ask the human to choose between agents; escalate only for money, deploy, or the human's own workflow. | 739 py |

This maps to Loop's proposal card, LOCK/DROP action bar, turn policy knob,
and "max consecutive agent messages" setting.

---

## I. Board, assignment, anti-make-work (from Hermes)

| Verdict | Path | What | Size |
|---|---|---|---|
| PORT concepts | `HERMES/scripts/artifact-ledger.py` | Sections (`:627-790`): MANDATORY ROWS (a room with unreconciled work has no free choice, `SKIP` illegal), BANNED (path or commit-subject skeletons repeated 3+ times in 14d, identifier families `:181-207`), TOKEN BUDGET (`DAILY_TOKEN_BUDGET`, 40% per room, prints `OPEN (n headroom)` / `BLOCKED`, never a ratio), CAPABILITY ROWS (`:758`, the generator: a funded idle room owes one named capability). Wake gate `{"wakeAgent": bool}` as last stdout line (`:824`). Zero Discord coupling; git-mining is the part to replace with Loop's task store. | 829 py |
| INSPIRE | `HERMES/scripts/design_ledger.py` | Second generator: work list derived from the product's actual surfaces, freshness from git, critiques with `- [ ] SEV=high` lines read back as queued work. | 403 py |
| PORT | `HERMES/scripts/roadmap_gate.py:14-24` | Two exclusive lanes: INVENT (cheap, may not ship code, outputs one proposal) vs BUILD (expensive, may not invent, drains the queue). An agent billed for both invents only what it can finish this turn. | |

---

## J. Silence, receipts, run ledger, token accounting (from Hermes)

| Verdict | Path | What | Size |
|---|---|---|---|
| COPY (rewrite in TS) | `HERMES/scripts/silence-audit.py` | Silence protocol: line 1 `[SILENT]`, then `checked:`, `negative:` or `action:`. `classify()` (`:68`) yields `failed / suppressed / spoke / silent+acted / silent+receipt / silent`. Findings: streak ≥ `STREAK_LIMIT = 3`, receiptless silence, failure streak from the scheduler record which outranks output files (`:172-175`). Auditor writes its own census receipt (`:87`). | 221 py |
| COPY schema | `HERMES/cron/executions.db` | `executions(id, job_id, source, pid, status IN claimed/running/completed/failed/unknown, claimed_at, started_at, finished_at, error)` and `cron_incidents(job_id, error_sig, state, failure_type, first_seen_at, last_seen_at, acked_at, closed_at, output_file)`. `error_sig` dedupes repeated failures into one incident. | sqlite |
| COPY | `HERMES/cron/usage_audit.jsonl` | One line per run: `ts, job_id, fire_id, prompt_tokens, completion_tokens, total_tokens, response_silent, deliver_target, model, duration_ms, error`. Prompt tokens dominate ~200:1, so trim the brief, not the reply. | jsonl |
| PORT invariant | `HERMES/cron/output/<job>/<ts>.md` | Assembled prompt above, `## Response` below. Loop gets this from its message store; keep the invariant that the assembled prompt is persisted next to the reply, the audit layer depends on it. | |
| INSPIRE | `HERMES/scripts/receipt-push.py` | Cross-host health push: numbers and enums only, no prompts, no run text. Boundary discipline for any supervisor service. | 250 py |

---

## K. Memory (from Hermes)

| Verdict | Path | What | Size |
|---|---|---|---|
| PORT | `HERMES/memories/MEMORY.md`, `memories/USER.md` + `config.yaml:105` limits | Two budget-capped files: project facts and the human's standing preferences. `memory_char_limit: 6000`, `user_char_limit: 1375`. Entries are corrections that cost something. Audit (`docs/fleet-config-audit-2026-09-07.md:16`) shows the cap must evict, not reject: 54 write failures at 6075/6000. | 39 + 10 md |

---

## L. Design-process artifacts (from Hermes)

| Verdict | Path | What | Size |
|---|---|---|---|
| COPY method | `HERMES/improve-agent-ideal/seed.md`, `SPEC.md`, `run-10.sh`, `iter-01..10/` | 10-round adversarial panel: three planner lenses answer one seed, each round gets the previous draft with "attack it, kill weak parts, do not average." `SPEC.md` is a table of fights and winners. This is how Loop's own agents should converge on designs. | 54 + 33 + 87 |
| INSPIRE | `HERMES/docs/hel1-manager-plan.md` | A verifier agent that never reads files, logs or history and never runs commands. Zero-model scripts collect and verify; the model gets one bounded digest and answers in a closed grammar a script parses; nothing reaches the room unparsed. Strongest idea for Loop's reviewer role. | 264 md |
| COPY format | `HERMES/HANDOVER.md` | P0..P3 with re-verify commands inline, "do not redo these", closing "recurring pattern". | 261 md |
| INSPIRE | `HERMES/docs/fleet-config-audit-2026-09-07.md` | Audit format: HIGH/MED/LOW per host, every finding a measured number. | 90 md |

---

## Design lessons Loop inherits (cited)

1. **Cheapest legal action.** Agents optimize for legal and cheap, not useful. Every fleet failure was an instance (`HERMES/AGENTS.md:146`).
2. **Prose the model applies to itself is not a control.** A computed brief section is a constraint; a prompt rule is a suggestion (`HERMES/AGENTS.md:156`).
3. **A filter can never generate.** Prohibitions alone produced 9 rows against 52 SKIPs. Every "don't" ships with a computed obligation in the same change (`HERMES/AGENTS.md:157-159`, `artifact-ledger.py:760`).
4. **Separate invent from build.** An agent billed for both invents only what it can also finish this turn (`HERMES/scripts/roadmap_gate.py:14-19`).
5. **Done is a behaviour delta plus a verified artifact**, not a paste. `Done=SHA` means pushed and checked with `git ls-remote` (`HERMES/AGENTS.md:166-168`). Never claim done on green numbers alone; end with an artifact you looked at (`3DVP/docs/AGENT-LOOP.md:38`).
6. **Verify in the harness, not on the agent's word**, and preflight the environment before burning a round (`3DVP/runner/verify.py` header, `agent_loop.py:797-805`).
7. **Silence is legal but carries a receipt**, and receipts are audited. Distinguish silent-and-acted from idle (`HERMES/scripts/silence-audit.py:9-16`).
8. **One open thread at a time** is the whole turn-taking algorithm (`HERMES/scripts/team-forum.py:15-19`).
9. **Budget in tokens, never in task count.** A count cap makes agents pick the task they are surest to close (`HERMES/scripts/artifact-ledger.py:29-33`).
10. **Print verdict words, not ratios.** Two percentages with different denominators stalled a live channel for seven hours (`HERMES/scripts/artifact-ledger.py:707-713`).
11. **Irreversible actions need pasted command output with exit code.** "Superseded" deleted six branches (`HERMES/AGENTS.md:127`).
12. **One room, one explicit owner.** A default-owner fallback silently made the newest agent owner of every untagged room (`HERMES/AGENTS.md:251`, `docs/hel1-manager-plan.md:22-24`).
13. **The sandbox is the security boundary, never the prompt.** A task prompt is remote code execution by design (`3DVP/docs/PLAN-SHARED-RUNNERS.md:36-45`).
14. **Deploy drift is invisible until it bites.** The dispatcher ran a version older than the commit it was meant to enforce; the image digest is the version (`3DVP/docs/HOSTED-DISPATCHER.md:9-17`).
15. **One manifest, never two lists.** `agents.json` drives runner argv, UI selects, and API validation (`3DVP/runner/agents.json` header note).
16. **Preload beats Read.** Paste cited source into the brief; budgets tuned by measured failures (`3DVP/runner/task_context.py:1-12`).
17. **Never leave a claimed task in `running`**, and fail loudly on prepare refusal: a task parked in `accepted` with no runner is invisible and never retried (`3DVP/runner/agent_loop.py:910-930`, `hosted_dispatch.py:657-664`).
18. **Redact by construction.** Error strings pass through `_redact()` before they are stored (`3DVP/runner/hosted_dispatch.py`).
19. **Watch prompt vocabulary.** "Smallest next thing" selects the next member of a family over the row that ends it (`HERMES/AGENTS.md:174`).
20. **Test the effective toolset, not the config.** Per-agent capability toggles interact (`HERMES/config.yaml:186`, audit finding 21).

---

## Suggested lift order

1. `agents.json` + `agents.py` (provider registry)
2. `bus.ts` + `stream/route.ts` + `TasksFeed.tsx` (live events)
3. `db.ts` schema + `claimQueuedTask` + `task-status.ts` + `executions.db` incident schema
4. `agent_loop.py` control flow: `run_agent_round`, `_run_rounds`, `finish_with_commit`
5. `continuation.ts` lineage + `roadmap_gate.py` task record and promotion rules
6. `team-forum.py` conversation protocol (grammar, LOCK/DROP, hold gate, card-leak metric)
7. `artifact-ledger.py` brief sections (mandatory, banned, budget, capability) and `silence-audit.py`
8. `acl.ts` / `runnerAuth.ts`, then sandbox flags + compose + Caddy patterns
9. Design system tokens and the `verify_*.mjs` gate pattern
