# Loop: build it, publish it, keep iterating

**What we are building.** Loop is a web app where a small crew of AI agents with roles (planner, builder, reviewer, critic, PM) run a project together inside a chat room, and humans sit in the same room to steer, veto, and decide. Behind the chat is a task system: tasks with an owner, a state, a lineage back to the discussion that spawned them, and a checkable definition of done, executed by a runner, streamed live into the room, verified by gates, committed atomically. Not a Discord bot. Not Hermes. Own UI, own runtime, own task store.

**Source of truth.** `/Users/moshe/Desktop/myprojects/loop`:
- `IDEA.md` — the product in one page. Read first.
- `UI.md` — every view and component: three-column shell, chat with typed cards (proposal, task, work-in-progress, result, question), tasks board and list, agents roster, files, inbox, settings.
- `REUSE.md` — what to copy, port, or borrow from 3d-vibing-platform and ~/.hermes, with paths and verdicts, plus 20 cited design lessons. Follow the lift order at the bottom.

**Stack.** TypeScript throughout. NestJS API, Next.js frontend, SQLite to start (Prisma or Drizzle), SSE for live events. No Python in the product. The 3dvp Python runner is a reference to port, not a dependency.

**Goal.** A fully iterated Loop interface published on a public GitHub repo at `m-esm/loop` under the **PolyForm Noncommercial License 1.0.0** (strict: no commercial use of any kind). Then keep iterating on it, forever, in this channel.

**Order of work.**
1. `git init`, `LICENSE` (PolyForm Noncommercial 1.0.0 verbatim), `README.md` with the one-liner from `IDEA.md`, `.gitignore`, then `gh repo create m-esm/loop --public`. Do this in the first tick. An unpublished repo is not a result.
2. Skeleton: monorepo with `apps/api` (NestJS) and `apps/web` (Next.js), shared `packages/types` for the task and event vocabulary. Port `task-status.ts` and the `agents.json` registry first, they are the shared contract.
3. Task store + event bus + SSE stream + `TasksFeed` client. A task can be created from the UI and its state changes appear live in another tab. That is milestone one.
4. Room chat with agent identity chips and the five typed cards, backed by real message rows. Humans can post, mention, and `/task`.
5. Runner: port `run_agent_round` / `_run_rounds` / `finish_with_commit` from 3dvp to a Node worker that spawns the provider CLIs from the registry, streams `tool_use` / `agent_progress` events, and commits atomically with verification.
6. Agent crew: role records over one prompt template, computed brief per turn, turn policy (free / round-robin / when-mentioned), max consecutive agent messages, pause and wrap-up controls. Port the LOCK/DROP grammar and the hold-the-tick rule from `team-forum.py`.
7. Tasks board and list, lineage, accept / reject / send-back, needs-human inbox.
8. Then iterate: UI polish against `UI.md`, the anti-make-work brief sections from `artifact-ledger.py`, silence receipts, memory files, sandboxing. Every tick after the first release picks the highest-value gap between `UI.md` and what is live.

**Rules for this channel.**
- Feature branches and PRs only, never push to `main` directly. A PR is done when merged and `git ls-remote` shows the SHA on `main`.
- Done is a behaviour delta: "Loop now does X, which it did not do before", plus a screenshot or a passing gate you actually looked at. Green numbers alone are not done.
- Every UI change ships with a headless screenshot in the PR. Every API change ships with a test. Lint, tests, build, and a local boot must pass before a PR opens.
- Nothing hand-maintained: no parallel lists, mirrored constants, or doc tables that restate code. Derive it or gate it.
- No em dashes anywhere. No AI attribution in commits.
- Silence follows the receipt protocol: `[SILENT]`, then `checked:` and `negative:` or `action:`.
- Do not ask Moshe to pick between you. Escalate only for money, a deploy, a license or naming decision, or a change to his workflow. Post `Q:` cards for those and continue with everything that does not depend on the answer.
- Read `REUSE.md` before writing anything that exists there. Re-inventing a listed COPY item is a defect.

**First message from each of you.** Which lane you take from the order above, the branch name, and the first PR you will open. Builders build. Reviewers review PRs against `UI.md` and `REUSE.md` and post `LOCK` / `DROP`. PM keeps the gap list between `UI.md` and the live app and posts it at the start of each day.
