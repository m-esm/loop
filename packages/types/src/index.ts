import type { TaskStatus } from './task-status';
import type { TaskProposal } from './proposal';
export * from './task-status';
export * from './composer';
export * from './proposal';
export * from './spawn';

export interface RoomAgent {
  id: string;
  roomId: string;
  catalogId: string;
  name: string;
  createdBy: string;
  createdAt: string;
}
export interface CatalogAgent {
  id: string;
  name: string;
}
export interface RoomAgentsSnapshot {
  agents: RoomAgent[];
  catalog: CatalogAgent[];
  role: 'owner' | 'member';
}
export interface RoomMember {
  principalId: string;
  displayName: string;
  email: string | null;
  role: 'owner' | 'member';
}
export interface RoomMembersSnapshot {
  members: RoomMember[];
  role: 'owner' | 'member';
}
export interface RoomInvite {
  id: string;
  email: string;
  role: 'owner' | 'member';
  createdAt: string;
  expiresAt: string;
}
export interface CreatedRoomInvite {
  id: string;
  email: string;
  role: 'owner' | 'member';
  token: string;
}
export type MessageBody =
  | { kind: 'text'; text: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'file'; fileId: string };
export interface RoomFile {
  id: string;
  roomId: string;
  name: string;
  size: number;
  contentType: string;
  sha256: string;
  uploadedBy: string;
  createdAt: string;
}
export interface RoomFilesSnapshot { files: RoomFile[] }
export interface Message {
  id: string;
  roomId: string;
  author: string;
  authorPrincipalId: string | null;
  body: MessageBody;
  createdAt: string;
}
export interface MessageSnapshot { messages: Message[]; since: number }
export interface CreateMessage { roomId: string; author: string; body: string; authorPrincipalId?: string | null }

export type TaskVerdict = 'accepted' | 'rejected';
export function isTaskVerdict(value: unknown): value is TaskVerdict {
  return value === 'accepted' || value === 'rejected';
}

export interface CreateTask {
  roomId?: string;
  title: string;
  owner: string;
  ownerPrincipalId?: string | null;
  definitionOfDone: string;
  agentId?: string | null;
  parentTaskId?: string | null;
}
export interface Task extends CreateTask {
  roomId: string;
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  ownerPrincipalId: string | null;
  agentId: string | null;
  claimedBy: string | null;
  runId: string | null;
  log: string[];
  result: string | null;
  error: string | null;
  question: string | null;
  answer: string | null;
  answeredBy: string | null;
  answeredByPrincipalId: string | null;
  verdict: TaskVerdict | null;
  verdictNote: string | null;
  verdictBy: string | null;
  verdictByPrincipalId: string | null;
  proposal: TaskProposal | null;
  proposalChoice: string | null;
  proposalBy: string | null;
  proposalByPrincipalId: string | null;
  parentTaskId: string | null;
}
export interface TaskEventPayloads {
  message_created: { message: Message };
  task_created: { task: Task };
  task_status_changed: { task: Task; previousStatus: TaskStatus };
  task_progress: { task: Task };
}
export type EventKind = keyof TaskEventPayloads;
export type TaskEvent = {
  [K in EventKind]: {
    id: number;
    subject_id: string | null;
    room_id: string;
    ts: string;
    kind: K;
    payload: TaskEventPayloads[K];
  }
}[EventKind];
export interface TaskSnapshot { tasks: Task[]; since: number }
