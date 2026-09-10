import Room from '../components/Room';

export default function Page() {
  return <div className="shell">
    <aside className="projects" aria-label="Projects">
      <p className="brand">Loop</p><p className="muted">Projects</p>
      <div id="projects-rail" />
    </aside>
    <main>
      <header><p className="muted">Project room</p><h1>Loop</h1>
      </header>
      <Room />
    </main>
    <aside className="context" aria-label="Context panel">
      <div id="room-agents" />
      <h2>Task context</h2><div id="task-context"><p>Select a task to see its owner and definition of done.</p></div>
      <p className="muted">Task changes appear live across open tabs.</p>
    </aside>
  </div>;
}
