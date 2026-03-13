export const MESSAGE_BOX_FOLDERS = ["inbox", "sent", "deleted"] as const;
export type MessageBoxFolder = (typeof MESSAGE_BOX_FOLDERS)[number];

export const MESSAGE_BOX_STATUS = ["unread", "read"] as const;
export type MessageBoxStatus = (typeof MESSAGE_BOX_STATUS)[number];

export const MESSAGE_VISIBILITY = ["direct", "collective"] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITY)[number];

export const MESSAGE_KIND = ["system", "assignment", "task", "manual"] as const;
export type MessageKind = (typeof MESSAGE_KIND)[number];

export const MESSAGE_SOURCE_ENTITY = ["task", "assignment", "experiment", "qualification_step", "doe"] as const;
export type MessageSourceEntity = (typeof MESSAGE_SOURCE_ENTITY)[number];

export type MessagePayload = {
  path?: string;
  experiment_id?: number;
  task_id?: number;
  assignment_id?: number;
  entity_type?: MessageSourceEntity;
  entity_id?: number;
  [key: string]: unknown;
};

// Logical message shared across participants.
export type MessageRow = {
  id: number;
  kind: MessageKind;
  visibility: MessageVisibility;
  chat_room_id?: number | null;
  reply_to_message_id?: number | null;
  sender_user_id: number | null;
  subject: string;
  body: string | null;
  payload_json: string | null;
  created_at: string;
  edited_at?: string | null;
  edit_count?: number;
};

// Per-user mailbox item (inbox/sent/deleted + read state).
export type MessageBoxRow = {
  id: number;
  message_id: number;
  user_id: number;
  folder: MessageBoxFolder;
  status: MessageBoxStatus;
  mention_flag: number;
  deleted_at: string | null;
  read_at: string | null;
  created_at: string;
};

export type SendMessageInput = {
  kind: MessageKind;
  visibility: MessageVisibility;
  sender_user_id: number | null;
  recipient_user_ids: number[];
  subject: string;
  body?: string | null;
  payload?: MessagePayload | null;
};

export function normalizeMessageBoxFolder(value: unknown): MessageBoxFolder {
  const folder = String(value ?? "").trim().toLowerCase();
  return MESSAGE_BOX_FOLDERS.includes(folder as MessageBoxFolder) ? (folder as MessageBoxFolder) : "inbox";
}

export function normalizeMessageBoxStatus(value: unknown): MessageBoxStatus {
  const status = String(value ?? "").trim().toLowerCase();
  return MESSAGE_BOX_STATUS.includes(status as MessageBoxStatus) ? (status as MessageBoxStatus) : "unread";
}

export function normalizeMessageVisibility(value: unknown): MessageVisibility {
  const visibility = String(value ?? "").trim().toLowerCase();
  return MESSAGE_VISIBILITY.includes(visibility as MessageVisibility) ? (visibility as MessageVisibility) : "direct";
}

export function normalizeMessageKind(value: unknown): MessageKind {
  const kind = String(value ?? "").trim().toLowerCase();
  return MESSAGE_KIND.includes(kind as MessageKind) ? (kind as MessageKind) : "manual";
}
