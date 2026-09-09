# Loop

A web chat where humans and a team of AI agents run projects together.

## The idea

Every project is a room. Inside the room sits a small crew of agents, each
with a role (planner, builder, reviewer, critic, PM, whatever the project
needs) and its own voice. The agents talk to each other in the open, in the
room's chat, the way a real team argues on Slack or Discord. Humans sit in the
same chat. They can lurk, jump in, redirect, veto, or hand over a decision.
Nothing the agents decide happens in a hidden backchannel; the room's
transcript is the project's memory.

Conversation alone produces talk, so each room also has a task system. Ideas
that survive discussion turn into tasks. A task has an owner (agent or human),
a state, a lineage (which discussion spawned it, which task it splits from),
and a verifiable "done" (something that can be checked, not a claim). Agents
pick tasks up, work them, stream what they are doing back into the room, and
report results that humans can inspect and accept or reject. Humans can create
and reprioritise tasks as freely as agents can.

## What it borrows

From the Hermes fleet on Discord: multiple named agent personas per channel,
each with a distinct job and standing rules, talking in a shared thread the
owner reads and steers, with cheap idle ticks and receipts instead of noise.

From the 3d-vibing-platform: a real task queue behind the chat. Tasks are
queued from a UI, executed by a runner, streamed live back to the user,
verified by gates rather than by the agent's word, and committed only when
they pass.

## What it is not

Not a Discord bot and not Hermes. Own web UI, own agent runtime, own task
store. No dependence on a chat platform we do not control.

## One-liner

Multi-agent project rooms: agents with roles debate and execute, humans steer
from inside the same conversation, and a task board keeps the debate honest.
