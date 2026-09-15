/** Ported from 3DVP task-status.ts. One vocabulary drives store and UI.
 *  `label` is the human reading of the same row. The wire value is a protocol
 *  detail: `needs_input` is not English and must never reach a person. */
export const TASK_STATUS = {
  queued: { active: true, running: false, chip: 'queued', label: 'Queued' },
  accepted: { active: true, running: true, chip: 'run', label: 'Starting' },
  running: { active: true, running: true, chip: 'run', label: 'Running' },
  needs_input: { active: true, running: false, chip: 'need', label: 'Needs you' },
  done: { active: false, running: false, chip: 'ok', label: 'Done' },
  failed: { active: false, running: false, chip: 'bad', label: 'Failed' },
  // Active until the runner confirms the process has stopped.
  cancelling: { active: true, running: false, chip: 'need', label: 'Cancelling' },
  cancelled: { active: false, running: false, chip: 'bad', label: 'Cancelled' },
} as const;

export type TaskStatus = keyof typeof TASK_STATUS;
export const TASK_STATUSES = Object.keys(TASK_STATUS) as TaskStatus[];
export const INITIAL_STATUS: TaskStatus = 'queued';
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(
  TASK_STATUSES.filter((status) => TASK_STATUS[status].active),
);
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && Object.hasOwn(TASK_STATUS, value);
}
export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}
export function isRunningStatus(status: string): boolean {
  return isTaskStatus(status) && TASK_STATUS[status].running;
}
/** A terminal status that ended badly. Drives failure copy and colour in the
 *  UI without any caller restating the status list. */
export function isFailureStatus(status: string): boolean {
  return isTaskStatus(status) && TASK_STATUS[status].chip === 'bad';
}
/** The human reading of a status. Falls back to the raw value so an unknown
 *  status from a newer API is still visible rather than blank. */
export function statusLabel(status: string): string {
  return isTaskStatus(status) ? TASK_STATUS[status].label : status;
}
export function chipClass(status: string): string {
  return isTaskStatus(status) ? `tp-chip ${TASK_STATUS[status].chip}` : 'tp-chip';
}
export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 45) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
export function relativeAgo(iso?: string | null): string {
  const short = relativeTime(iso);
  return !short ? '' : short === 'now' ? 'just now' : `${short} ago`;
}
