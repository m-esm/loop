'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function ProjectsRailEntry({ count }: { count: number }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const baseTitle = useRef<string | null>(null);
  useEffect(() => { setHost(document.getElementById('projects-rail')); }, []);
  useEffect(() => {
    if (baseTitle.current == null) {
      baseTitle.current = document.title.replace(/^\(\d+\) /, '') || 'Loop | Tasks';
    }
    const base = baseTitle.current;
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [count]);
  useEffect(() => () => {
    if (baseTitle.current) document.title = baseTitle.current;
  }, []);
  if (!host) return null;
  const label = count === 1 ? '1 task needs a human' : `${count} tasks need a human`;
  return createPortal(
    <a href="/" aria-current="page" data-needs-human={String(count)}>
      Loop
      {count > 0 ? <span className="needs-human-pill" aria-label={label}>{count}</span> : null}
    </a>,
    host,
  );
}
