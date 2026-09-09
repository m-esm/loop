# Loop UI

One app shell, one project room at a time. The room is the unit of everything.
The shell is a three-column layout borrowed from chat clients (Slack, Discord,
Linear's split panes), because users already know how to read it.

```
+-----------+--------------------------------------+--------------------+
| Projects  |  Room: Klonk                         |  Context panel     |
| rail      |  [Chat] [Tasks] [Agents] [Files]     |  (task / agent /   |
|           |                                      |   thread detail)   |
|  o Klonk  |  ...messages / board / roster...     |                    |
|  o Only.. |                                      |                    |
|  o Loop   |                                      |                    |
|           |  +----------------------------------+|                    |
|  + new    |  | composer                         ||                    |
+-----------+--------------------------------------+--------------------+
```

## Views

### 1. Projects rail (left, always visible)

- List of rooms the user belongs to, unread and "needs a human" badges.
- "Needs a human" is the badge that matters: an agent asked a question,
  proposed a decision, or a task is waiting on human acceptance.
- New project button. Creating a room means naming it, linking a repo or
  workspace, and picking the agent crew from templates.

### 2. Room / Chat (centre, default tab)

The main surface. One continuous transcript per room, threads for depth.

- **Message stream**: humans and agents interleaved. Agent messages carry the
  agent's avatar, role chip, and colour so a glance tells who is talking.
  Collapsible long messages. Code, diffs, images, and renders inline.
- **Threads**: any message can open a thread. Agent debates on one topic
  should live in a thread so the main stream stays readable. Threads show
  reply count and participants inline; open in the right panel.
- **Structured message cards** (this is the part chat apps do not have):
  - *Proposal card*: an agent proposes a direction. Shows the options, the
    agent's pick, and buttons: approve, reject, "discuss". Approving can
    spawn a task directly.
  - *Task card*: a task referenced or created from chat. Title, state, owner,
    one-line "done when". Click opens the task in the right panel.
  - *Work-in-progress card*: an agent executing a task streams its actions
    here (tool calls, files touched, build output) in a collapsed live card
    rather than flooding the room. Expand to watch.
  - *Result card*: task finished. What changed, verification status (gates
    passed / failed), artifacts (diff, screenshot, link). Accept / reject /
    send back with a note.
  - *Question card*: agent blocked on a human. Highlighted, pinned until
    answered, and the source of the rail badge.
- **Composer**: markdown, @mention agents or humans, `/task` to create a task
  inline, `/ask @agent`, attachments. Mentioning an agent is how a human
  directs a question to one role instead of the whole crew.
- **Steering controls** near the composer: pause the crew (agents stop
  talking until resumed), "wrap up" (agents converge on a decision now),
  and a per-room verbosity dial. These are the knobs that stop a debate from
  running away.

### 3. Tasks (centre tab, same room)

The task system behind the chat.

- **Board view**: kanban columns by state (Proposed, Ready, In progress,
  Verifying, Needs human, Done, Rejected). Cards show owner avatar, agent or
  human, lineage icon, verification status.
- **List view**: same tasks as a dense table with sort and filter by owner,
  state, age, source thread. Better once a room has more than ~30 tasks.
- **Task detail** (right panel or full page): description, "done when"
  criteria, owner, state history, the chat thread that spawned it, parent and
  child tasks, the execution log (streamed actions, build output), artifacts,
  verification results, and the accept / reject / reassign actions.
- **Lineage graph** (secondary): tree of tasks showing what split from what.
  Useful for review, not for daily use.

### 4. Agents (centre tab)

The crew roster for the room.

- Card per agent: name, avatar, role, one-paragraph mandate, model and cost
  budget, current state (idle, thinking, executing task X, waiting on human).
- Edit an agent's mandate and standing rules in place. Add or remove agents
  from templates (planner, builder, reviewer, critic, PM, researcher).
- Per-agent activity: recent messages, tasks owned, tokens spent today.
- Crew-level settings: turn-taking policy (free-for-all, round robin, speak
  only when mentioned), max consecutive agent messages before a human turn is
  required, quiet hours.

### 5. Files / Artifacts (centre tab)

Everything the room produced: diffs, screenshots, renders, documents, links.
Grouped by task. Preview inline. This is where a human goes to check work
without reading the whole transcript.

### 6. Context panel (right, contextual)

Opens on demand, shows one of: a thread, a task detail, an agent profile, or
an artifact preview. Closable. Never two things at once.

### 7. Home / Inbox (cross-room)

Landing page when no room is open. Aggregates across all rooms:

- Needs you: questions, proposals, and results waiting on a human, oldest
  first. This is the human's daily queue.
- Recent activity per room, one line each.
- Spend today across all crews.

### 8. Settings

- Account, API keys and model providers, notification preferences.
- Agent templates (shared across rooms).
- Repo / workspace connections.

## Components worth building once and reusing

| Component | Used in |
| --- | --- |
| Agent identity chip (avatar + name + role colour) | messages, task cards, roster, board |
| State pill (task states, agent states, verification pass/fail) | everywhere |
| Message card frame with typed body (text, proposal, task, WIP, result, question) | chat, threads |
| Live log viewer (streamed actions, collapsible, follows tail) | WIP card, task detail |
| Diff viewer, image/render preview | result card, artifacts, task detail |
| Accept / reject / send-back action bar | result card, task detail, proposal card |
| Composer with mentions and slash commands | chat, threads, task comments |
| Kanban board and dense table over the same task list | tasks tab |
| Badge system (unread, needs human) | rail, tabs, home |

## Principles

- **Human decisions are first-class objects**, not messages that scroll away.
  Every proposal, question, and result is a card with a state and a pinned
  spot until resolved.
- **The chat stays readable.** Execution noise goes into collapsed live cards
  and threads. The main stream is decisions and conversation.
- **Same task, three lenses.** A task appears as a card in chat, a card on the
  board, and a row in the list. One source, three renderings.
- **Who said it is instant.** Colour and role chip on every agent message;
  humans get a distinct treatment so agent and human turns never blur.
- **Controls, not prose.** Pause, wrap-up, turn policy, and message caps are
  UI knobs. Behaviour rules that only live in a prompt are not controls.
