'use client';

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { RoomFile } from '@loop/types';
import { API_URL, api } from '../lib/api';

const PREVIEW_BYTES = 4096;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextPreview(contentType: string): boolean {
  return contentType.startsWith('text/');
}

export function ArtifactPreview({ file }: { file: RoomFile }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const texty = isTextPreview(file.contentType);
  useEffect(() => {
    if (!texty) {
      setPreview(null);
      setError('');
      return;
    }
    const controller = new AbortController();
    fetch(`${API_URL}/rooms/${file.roomId}/files/${file.id}/content`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Preview failed (${response.status})`);
      const buf = await response.arrayBuffer();
      const slice = buf.byteLength > PREVIEW_BYTES ? buf.slice(0, PREVIEW_BYTES) : buf;
      setPreview(new TextDecoder('utf-8').decode(slice));
      setError('');
    }).catch((err: Error) => {
      if (!controller.signal.aborted) {
        setPreview(null);
        setError(err.message);
      }
    });
    return () => controller.abort();
  }, [file.id, file.roomId, texty]);
  return (
    <section className="task-detail" aria-label="Artifact preview">
      <p data-file-name>{file.name}</p>
      <p className="muted" data-file-size>{formatSize(file.size)}</p>
      <p className="muted">{file.contentType}</p>
      <a href={`${API_URL}/rooms/${file.roomId}/files/${file.id}/content`} download={file.name}>Download</a>
      {error && <p role="alert">{error}</p>}
      {preview != null && <pre>{preview}</pre>}
    </section>
  );
}

export default function FilesPanel({ room, files, onChange, onSelectFile }: {
  room: string; files: RoomFile[]; onChange: () => void; onSelectFile: (file: RoomFile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<string>('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const sending = useRef(false);

  async function send(file: File | undefined) {
    if (!file) { setError('Choose a file first.'); return; }
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.append('file', file);
      await api(`/rooms/${room}/files`, { method: 'POST', body });
      if (input.current) input.current.value = '';
      setChosen('');
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File could not be uploaded.');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(input.current?.files?.[0]);
  }

  // Dropping a file is the gesture people already expect here; the input stays
  // as the keyboard and screen-reader path rather than being replaced by it.
  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file || !input.current) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.current.files = transfer.files;
    setChosen(file.name);
  }

  return <section aria-label="Files" data-empty={files.length ? undefined : "1"}>
    <form
      className={`files-upload${dragging ? ' dragging' : ''}`}
      aria-label="Upload file"
      onSubmit={upload}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <label htmlFor="room-file" className="files-upload-label">Upload file</label>
      <p className="files-upload-hint">Drop a file here, or
        {' '}<button type="button" className="files-upload-browse" disabled={busy}
          onClick={() => input.current?.click()}>browse</button>.
        {' '}Up to 10 MB.</p>
      <input id="room-file" name="file" type="file" disabled={busy} data-file-upload
        ref={input} className="files-upload-input"
        onChange={(event) => { setChosen(event.target.files?.[0]?.name ?? ''); setError(''); }} />
      <p className="files-upload-chosen" data-file-chosen>{chosen || 'No file chosen'}</p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy || !chosen}>{busy ? 'Uploading...' : 'Upload'}</button>
    </form>
    <ul className="files-list">
      {files.map((file) => <li key={file.id} data-file-row={file.id}>
        <button type="button" className="task-title" data-file-name onClick={() => onSelectFile(file)}>{file.name}</button>
        <span className="muted" data-file-size>{formatSize(file.size)}</span>
        <a href={`${API_URL}/rooms/${file.roomId}/files/${file.id}/content`} download={file.name}>Download</a>
      </li>)}
    </ul>
    {!files.length && <div className="files-empty">
      <p className="inbox-empty-title">No files yet</p>
      <p className="inbox-empty-body">Drop a file on the zone above to share it with this room and its agents.</p>
    </div>}
  </section>;
}
