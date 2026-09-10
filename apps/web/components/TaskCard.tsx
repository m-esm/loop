'use client';

import { useState, type FormEvent } from 'react';
import { chipClass, isActiveStatus, type Task } from '@loop/types';
import { api } from '../lib/api';

export default function TaskCard({ task, author }: { task: Task; author: string }) {
  const terminal = !isActiveStatus(task.status);
  const waiting = task.status === 'needs_input' && !!task.question;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${task.id}/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer, answeredBy: author }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Answer could not be sent.');
    } finally { setBusy(false); }
  }
  return <div className={waiting ? 'chat-task question-card' : 'chat-task'} data-task-id={task.id}>
    <h3>{task.title}</h3><span className={chipClass(task.status)}>{task.status}</span>
    <p>Owner: {task.owner}</p>
    {task.agentId && <p data-task-agent>Agent: {task.agentId}</p>}
    <p className="done-when" title={task.definitionOfDone}>Done when: {task.definitionOfDone}</p>
    {task.question && <p data-task-question className="task-question">{task.question}</p>}
    {waiting && <form className="answer-form" onSubmit={submit}>
      <label>Answer<textarea value={answer} onChange={(event) => setAnswer(event.target.value)}
        rows={2} maxLength={8000} required disabled={busy} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Sending...' : 'Submit answer'}</button>
    </form>}
    {task.answer && <p data-task-answer className="task-answer">
      Answered by {task.answeredBy ?? 'unknown'}: {task.answer}
    </p>}
    {task.log.length > 0 && <details>
      <summary>Log</summary>
      <pre data-task-log>{task.log.join('\n')}</pre>
    </details>}
    {terminal && task.result && <p data-task-result className="task-result">{task.result}</p>}
    {terminal && task.error && <p data-task-error className="task-error">{task.error}</p>}
  </div>;
}
