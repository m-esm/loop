import TasksPanel from '../components/TasksPanel';

export default function Page() {
  return <div className="shell">
    <aside className="projects" aria-label="Projects">
      <h1>Loop</h1><p className="muted">Projects</p>
      <a href="/" aria-current="page">Loop</a>
    </aside>
    <main>
      <header><p className="muted">Project room</p><h2>Loop</h2>
        <nav aria-label="Room views"><span>Chat</span><strong>Tasks</strong><span>Agents</span><span>Files</span></nav>
      </header>
      <TasksPanel />
    </main>
    <aside className="context" aria-label="Context panel">
      <h2>Task context</h2><div id="task-context"><p>Select a task to see its owner and definition of done.</p></div>
      <p className="muted">Task changes appear live across open tabs.</p>
    </aside>
  </div>;
}
