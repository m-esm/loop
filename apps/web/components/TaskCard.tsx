'use client';

import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { chipClass, isActiveStatus, isRunningStatus, type Task } from '@loop/types';
import { actorLabel, api } from '../lib/api';

export default function TaskCard({ task, tasks = [] }: { task: Task; tasks?: Task[] }) {
  const terminal = !isActiveStatus(task.status);
  const proposing = task.status === 'needs_input' && !!task.proposal && !task.proposalChoice;
  const waiting = task.status === 'needs_input' && !!task.question && !proposing;
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState(task.proposal?.pick ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logPre = useRef<HTMLPreElement>(null);
  const followLog = useRef(true);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${task.id}/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Answer could not be sent.');
    } finally { setBusy(false); }
  }
  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const verdict = submitter instanceof HTMLButtonElement ? submitter.name : '';
    if (verdict !== 'accepted' && verdict !== 'rejected') return;
    setBusy(true);
    setError('');
    try {
      const trimmed = note.trim();
      await api(`/tasks/${task.id}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verdict, ...(trimmed ? { note: trimmed } : {}),
        }),
      });
      // A submitted note belongs to that verdict. Leaving it in the box means a
      // send-back note gets resubmitted with the next verdict on the re-run.
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review could not be sent.');
    } finally { setBusy(false); }
  }
  async function submitDecide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const action = submitter instanceof HTMLButtonElement ? submitter.name : '';
    const decided = action === 'discuss' || action === 'reject'
      ? action
      : (choice || task.proposal?.pick || '');
    if (!decided) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${task.id}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: decided }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision could not be sent.');
    } finally { setBusy(false); }
  }
  const selected = choice || task.proposal?.pick || '';
  const proposal = task.proposal;
  const parentTitle = task.parentTaskId
    ? (tasks.find((row) => row.id === task.parentTaskId)?.title ?? task.parentTaskId)
    : null;
  const logCount = task.log.length;
  const logText = task.log.join('\n');
  const logSummary = isActiveStatus(task.status)
    ? `Work in progress · ${logCount} ${logCount === 1 ? 'line' : 'lines'}`
    : `What happened · ${logCount} ${logCount === 1 ? 'line' : 'lines'}`;
  const showLog = logCount > 0 || isRunningStatus(task.status);
  useLayoutEffect(() => {
    const element = logPre.current;
    if (element && followLog.current) element.scrollTop = element.scrollHeight;
  }, [logText]);
  return <div className={waiting || proposing ? 'chat-task question-card' : 'chat-task'} data-task-id={task.id}>
    <h3>{task.title}</h3><span className={chipClass(task.status)}>{task.status}</span>
    {parentTitle && <p data-task-parent className="task-parent">From: {parentTitle}</p>}
    <p>Owner: {actorLabel(task.owner, task.ownerPrincipalId)}</p>
    {task.agentId && <p data-task-agent>Agent: {task.agentId}</p>}
    <p className="done-when" title={task.definitionOfDone}>Done when: {task.definitionOfDone}</p>
    {task.question && <p data-task-question className="task-question">{task.question}</p>}
    {proposal && <div data-task-proposal>
      <p className="task-question">{proposal.question}</p>
      <p className="task-why">{proposal.why}</p>
      {proposing && <form className="answer-form" onSubmit={submitDecide}>
        <div className="proposal-options" role="radiogroup" aria-label="Proposal options">
          {proposal.options.map((option) => <label key={option} data-proposal-option={option} className="proposal-option">
            <input type="radio" name="proposal" value={option} checked={selected === option}
              onChange={() => setChoice(option)} disabled={busy} />
            {option}{option === proposal.pick ? " (agent's pick)" : ''}
          </label>)}
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="review-actions">
          <button type="submit" name="approve" disabled={busy}>Approve</button>
          <button type="submit" name="reject" disabled={busy}>Reject</button>
          <button type="submit" name="discuss" disabled={busy}>Discuss</button>
        </div>
      </form>}
    </div>}
    {task.proposalChoice && <p data-task-choice className="task-choice">
      {task.proposalChoice === 'discuss' ? 'Discuss' : task.proposalChoice === 'reject' ? 'Reject' : task.proposalChoice} by {actorLabel(task.proposalBy, task.proposalByPrincipalId)}
    </p>}
    {waiting && <form className="answer-form" onSubmit={submit}>
      <label>Answer<textarea value={answer} onChange={(event) => setAnswer(event.target.value)}
        rows={2} maxLength={8000} required disabled={busy} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Sending...' : 'Submit answer'}</button>
    </form>}
    {task.answer && <p data-task-answer className="task-answer">
      Answered by {actorLabel(task.answeredBy, task.answeredByPrincipalId)}: {task.answer}
    </p>}
    {showLog && <details onToggle={(event) => {
      if (!event.currentTarget.open) return;
      const element = logPre.current;
      if (!element) return;
      followLog.current = true;
      element.scrollTop = element.scrollHeight;
    }}>
      <summary>{logSummary}</summary>
      <pre data-task-log ref={logPre} onScroll={(event) => {
        const element = event.currentTarget;
        followLog.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>{logText}</pre>
    </details>}
    {terminal && task.result && <p data-task-result className="task-result">{task.result}</p>}
    {terminal && task.error && <p data-task-error className="task-error">{task.error}</p>}
    {task.verdict && <p data-task-verdict className="task-verdict">
      {task.verdict === 'accepted' ? 'Accepted' : 'Rejected'} by {actorLabel(task.verdictBy, task.verdictByPrincipalId)}
      {task.verdictNote ? `: ${task.verdictNote}` : ''}
    </p>}
    {terminal && !task.verdict && <form className="answer-form" onSubmit={submitReview}>
      <label>Note<textarea value={note} onChange={(event) => setNote(event.target.value)}
        rows={2} maxLength={8000} disabled={busy} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="review-actions">
        <button type="submit" name="accepted" disabled={busy}>Accept</button>
        <button type="submit" name="rejected" disabled={busy}>Reject</button>
      </div>
    </form>}
  </div>;
}
