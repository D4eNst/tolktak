import type { FileMeta, Message } from './api';

export type Pending = { nonce: string; channel_id: number; text: string; created_at: number; status: 'sending' | 'failed'; reply_to?: number; attachments: FileMeta[] };
export type LocalMessages = { drafts: [number, string][]; replies: [number, Message][]; pending: Pending[] };

const storageKey = (server: string, uid: number) => `tolktak.messages.v1:${encodeURIComponent(server)}:${uid}`;
const isPositiveId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
function isFileMeta(value: any): value is FileMeta {
  return value && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.mime === 'string' && Number.isFinite(value.size) && value.size >= 0;
}
function isPending(value: any): value is Pending {
  return value && typeof value.nonce === 'string' && isPositiveId(value.channel_id) && typeof value.text === 'string' && Number.isFinite(value.created_at)
    && (value.reply_to === undefined || isPositiveId(value.reply_to)) && Array.isArray(value.attachments) && value.attachments.every(isFileMeta);
}
function isReplyMessage(value: any): value is Message {
  return value && isPositiveId(value.id) && isPositiveId(value.author_id) && isPositiveId(value.channel_id) && typeof value.text === 'string'
    && Array.isArray(value.attachments) && value.attachments.every(isFileMeta);
}

export function loadLocalMessages(server: string, uid: number): LocalMessages {
  const data = JSON.parse(localStorage.getItem(storageKey(server, uid)) || '{}') ?? {};
  return {
    drafts: Array.isArray(data.drafts) ? data.drafts.filter((v: any) => Array.isArray(v) && isPositiveId(v[0]) && typeof v[1] === 'string') : [],
    replies: Array.isArray(data.replies) ? data.replies.filter((v: any) => Array.isArray(v) && isPositiveId(v[0]) && isReplyMessage(v[1]) && v[0] === v[1].channel_id) : [],
    pending: Array.isArray(data.pending) ? data.pending.filter(isPending).map((p: Pending) => ({ ...p, status: 'failed' })) : [],
  };
}

export function saveLocalMessages(server: string, uid: number, data: LocalMessages) {
  if (!data.drafts.length && !data.replies.length && !data.pending.length) localStorage.removeItem(storageKey(server, uid));
  else localStorage.setItem(storageKey(server, uid), JSON.stringify(data));
}
