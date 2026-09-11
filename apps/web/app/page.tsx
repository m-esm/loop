import Room from '../components/Room';

export default function Page() {
  return <div className="shell">
    <aside className="projects" aria-label="Projects">
      <p className="brand">Loop</p><p className="muted">Projects</p>
      <div id="projects-rail" />
    </aside>
    <main>
      <header><p className="muted">Project room</p><h1 id="room-heading">Loop</h1>
      </header>
      <Room />
    </main>
    <aside className="context" aria-label="Context panel">
      <div id="inspector" />
    </aside>
  </div>;
}
