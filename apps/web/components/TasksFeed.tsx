'use client';

import { useEffect, useRef, useState } from 'react';
import type { TaskEvent } from '@loop/types';
import { API_URL, api, ApiError, type Me } from '../lib/api';
import { sseBackoffDelay } from '../lib/feed';

/** Port of the silent 3DVP TasksFeed: one connection mounted per room. */
export default function TasksFeed({ since, onEvent, onUnauthorized }: {
  since: number; onEvent: (event: TaskEvent) => void; onUnauthorized?: () => void;
}) {
  const [live, setLive] = useState(false);
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastId = since;
    let seen = new Set<number>();
    let attempt = 0;
    let waitingVisible = false;

    const scheduleReconnect = () => {
      if (closed || retryTimer) return;
      if (document.hidden) { waitingVisible = true; return; }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, sseBackoffDelay(attempt++));
    };
    const onVis = () => {
      if (document.hidden || !waitingVisible || closed) return;
      waitingVisible = false;
      connect();
    };
    const connect = () => {
      if (closed || es) return;
      // Also defer if visibility changed after a retry timer was scheduled.
      if (document.hidden) { waitingVisible = true; return; }
      const source = new EventSource(`${API_URL}/stream?since=${lastId}`, { withCredentials: true });
      es = source;
      source.onopen = () => { attempt = 0; setLive(true); };
      source.onerror = () => {
        setLive(false);
        source.close();
        es = null;
        void api<Me>('/auth/me').then(() => scheduleReconnect()).catch((error) => {
          if (error instanceof ApiError && error.status === 401) {
            closed = true;
            onUnauthorized?.();
            return;
          }
          scheduleReconnect();
        });
      };
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as TaskEvent;
          if (!Number.isSafeInteger(event.id) || event.id <= lastId || seen.has(event.id)) return;
          if (event.kind === 'message_created') {
            if (!event.payload?.message?.id) return;
          } else if (event.kind === 'task_created' || event.kind === 'task_status_changed' || event.kind === 'task_progress') {
            if (!event.payload?.task?.id) return;
          } else return;
          onEventRef.current(event);
          if (seen.size > 4000) seen = new Set();
          seen.add(event.id);
          lastId = event.id;
        } catch { /* Ignore non-JSON frames without advancing the cursor. */ }
      };
    };
    document.addEventListener('visibilitychange', onVis);
    connect();
    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVis);
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [since]);

  return <span role="status" data-live={live ? '1' : '0'}>{live ? 'Live' : 'Reconnecting...'}</span>;
}
