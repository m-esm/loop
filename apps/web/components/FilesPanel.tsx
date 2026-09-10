'use client';

import { useRef, useState, type FormEvent } from 'react';
import type { RoomFile } from '@loop/types';
import { API_URL, api } from '../lib/api';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesPanel({ room, files, onChange }: {
  room: string; files: RoomFile[]; onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem('file') as HTMLInputElement | null;
    const chosen = input?.files?.[0];
    if (!chosen) { setError('Choose a file first.'); return; }
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.append('file', chosen);
      await api(`/rooms/${room}/files`, { method: 'POST', body });
      form.reset();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File could not be uploaded.');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return <section aria-label="Files">
    <form className="files-upload" aria-label="Upload file" onSubmit={(event) => { void upload(event); }}>
      <label htmlFor="room-file">Upload file</label>
      <input id="room-file" name="file" type="file" disabled={busy} data-file-upload />
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Uploading...' : 'Upload'}</button>
    </form>
    <ul className="files-list">
      {files.map((file) => <li key={file.id} data-file-row={file.id}>
        <span data-file-name>{file.name}</span>
        <span className="muted" data-file-size>{formatSize(file.size)}</span>
        <a href={`${API_URL}/rooms/${file.roomId}/files/${file.id}/content`} download={file.name}>Download</a>
      </li>)}
    </ul>
    {!files.length && <p className="muted">No files yet. Upload a document for this room.</p>}
  </section>;
}
