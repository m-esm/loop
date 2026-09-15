import Room from '../components/Room';

export default function Page() {
  return <div className="shell">
    <aside className="projects" aria-label="Projects">
      <p className="brand">Loop</p><p className="muted">Projects</p>
      <div id="projects-rail" data-needs-human="0" />
    </aside>
    <main>
      <header><p className="muted" id="room-context">Home</p><h1 id="room-heading">Inbox</h1>
        <div id="account-chrome" />
      </header>
      <Room />
    </main>
    <div id="inspector" />
  </div>;
}
