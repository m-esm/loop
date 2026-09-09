# Loop

Multi-agent project rooms: agents with roles debate and execute, humans steer
from inside the same conversation, and a task board keeps the debate honest.

## What this is

Every project is a room. A crew of AI agents with roles (planner, builder,
reviewer, critic, PM) works the project in the open, in the room's chat. Humans
sit in the same room and can lurk, redirect, veto, or take a decision. Behind
the chat is a task system: tasks with an owner, a state, a lineage back to the
discussion that spawned them, and a checkable definition of done, executed by a
runner, streamed live into the room, verified by gates, committed atomically.

Not a Discord bot and not Hermes. Own UI, own runtime, own task store.

## Docs

- [`IDEA.md`](IDEA.md) the product in one page
- [`UI.md`](UI.md) every view and component
- [`REUSE.md`](REUSE.md) what to copy or port, with paths and verdicts

## Stack

TypeScript throughout. NestJS API, Next.js frontend, SQLite to start, SSE for
live events.

## Status

Bootstrapping. The monorepo skeleton (`apps/api`, `apps/web`,
`packages/types`) lands next, then the task store, event bus, and live feed.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). Noncommercial use only.
