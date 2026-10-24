export type User = {
  id: number;
  username: string;
  display_name: string;
  color: string;
  is_admin: boolean;
  online?: boolean;
  avatar: string;
  about: string;
  status: string;
  created_at?: number;
};
export type FileMeta = { id: string; name: string; mime: string; size: number; width?: number; height?: number };
export type ReplyPreview = { id: number; author_id: number; text: string; deleted: boolean; attachments: number };
export type Reaction = { emoji: string; users: number[] };
export type Message = {
  id: number;
  channel_id: number;
  author_id: number;
  nonce: string;
  text: string;
  created_at: number;
  edited_at: number | null;
  deleted: boolean;
  reply_to: number | null;
  reply?: ReplyPreview;
  attachments: FileMeta[];
  reactions: Reaction[];
  pinned_at: number | null;
};
export type Channel = {
  id: number;
  kind: 'dm' | 'group';
  peer_id?: number;
  group_id?: number;
  last_message: Message | null;
  last_read_id: number;
  unread: number;
};
export type Room = { id: number; group_id: number; name: string; position: number };
export type TextChannel = { id: number; name: string; position: number };
export type Group = {
  id: number;
  name: string;
  owner_id: number;
  channel_id: number;
  avatar: string;
  description: string;
  members: number[];
  roles: Record<string, string>;
  rooms: Room[];
  text_channels: TextChannel[];
};
export type ProfilePatch = { display_name?: string; about?: string; status?: string; avatar?: string };
export type VoiceMember = { user_id: number; muted: boolean; deafened: boolean; camera: boolean; screen: boolean; joined_at: number };
export type VoiceRoom = { room: string; members: VoiceMember[] };
export type ServerInfo = { name: string; version: string; registration: string; livekit_url: string; client_download_url: string; min_client: string };
export type ServerUpdate = {
  version: string;
  mode: 'auto' | 'manual' | 'off';
  enabled: boolean;
  agent: boolean;
  available: { version: string; urgent: boolean } | null;
  state: 'idle' | 'pulling' | 'waiting' | 'restarting' | 'failed';
  error: string;
  apply_by: number | null;
};

/** `code` is localised by the UI, `message` is the fallback text. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  constructor(
    public base: string,
    public token = '',
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + '/api/v1' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'network', 'Server unavailable');
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data as { error?: { code: string; message: string } }).error;
      throw new ApiError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? res.statusText);
    }
    return data as T;
  }

  serverInfo = () => this.req<ServerInfo>('GET', '/server');
  serverUpdate = () => this.req<ServerUpdate>('GET', '/admin/update');
  updateServerNow = () => this.req<ServerUpdate>('POST', '/admin/update');
  login = (username: string, password: string, device: string) =>
    this.req<{ token: string; user: User }>('POST', '/auth/login', { username, password, device });
  logout = () => this.req<void>('POST', '/auth/logout');
  me = () => this.req<{ user: User }>('GET', '/me');
  updateMe = (patch: ProfilePatch) => this.req<{ user: User }>('PATCH', '/me', patch);
  changePassword = (old_password: string, new_password: string) => this.req<void>('POST', '/me/password', { old_password, new_password });
  users = () => this.req<{ users: User[] }>('GET', '/users');
  channels = () => this.req<{ channels: Channel[] }>('GET', '/channels');
  openDM = (user_id: number) => this.req<{ channel: Channel }>('POST', '/dms', { user_id });
  messages = (channel: number, q: { before?: number; after?: number; limit?: number; q?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
    return this.req<{ messages: Message[] }>('GET', `/channels/${channel}/messages?${p}`);
  };
  send = (channel: number, body: { text: string; nonce: string; reply_to?: number; attachments?: string[] }) =>
    this.req<{ message: Message }>('POST', `/channels/${channel}/messages`, body);
  react = (id: number, emoji: string) => this.req<{ message: Message }>('POST', `/messages/${id}/reactions`, { emoji });
  pin = (id: number, on: boolean) => this.req<{ message: Message }>(on ? 'POST' : 'DELETE', `/messages/${id}/pin`);
  pins = (channel: number) => this.req<{ messages: Message[] }>('GET', `/channels/${channel}/pins`);
  fileUrl = (id: string, name?: string) => `${this.base}/api/v1/files/${id}${name ? '/' + encodeURIComponent(name) : ''}`;

  /** XHR, because fetch reports no upload progress. */
  upload(file: Blob, name: string, dims?: { w: number; h: number }, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<FileMeta> {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ name });
      if (dims) (q.set('w', String(dims.w)), q.set('h', String(dims.h)));
      const x = new XMLHttpRequest();
      x.open('POST', `${this.base}/api/v1/files?${q}`);
      x.setRequestHeader('Authorization', 'Bearer ' + this.token);
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => {
        let data: any = {};
        try {
          data = JSON.parse(x.responseText);
        } catch {
          /* not JSON */
        }
        if (x.status >= 200 && x.status < 300) resolve(data.file);
        else if (x.status === 413) reject(new ApiError(413, 'too_large', data?.error?.message ?? 'File is too large'));
        else reject(new ApiError(x.status, data?.error?.code ?? 'upload_failed', data?.error?.message ?? 'Could not upload the file'));
      };
      x.onerror = () => reject(new ApiError(0, 'network', 'Server unavailable'));
      x.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
      signal?.addEventListener('abort', () => x.abort());
      x.send(file);
    });
  }
  markRead = (channel: number, message_id: number) => this.req<void>('POST', `/channels/${channel}/read`, { message_id });
  editMessage = (id: number, text: string) => this.req<{ message: Message }>('PATCH', `/messages/${id}`, { text });
  deleteMessage = (id: number) => this.req<{ message: Message }>('DELETE', `/messages/${id}`);
  groups = () => this.req<{ groups: Group[] }>('GET', '/groups');
  createGroup = (name: string, members: number[], defaults: { room_name: string; channel_name: string }) =>
    this.req<{ group: Group }>('POST', '/groups', { name, members, ...defaults });
  updateGroup = (id: number, patch: { name?: string; avatar?: string; description?: string }) => this.req<void>('PATCH', `/groups/${id}`, patch);
  setRole = (gid: number, uid: number, role: 'mod' | 'member') => this.req<void>('PUT', `/groups/${gid}/members/${uid}/role`, { role });
  createTextChannel = (gid: number, name: string) => this.req<{ channel: Channel }>('POST', `/groups/${gid}/channels`, { name });
  renameTextChannel = (id: number, name: string) => this.req<void>('PATCH', `/text-channels/${id}`, { name });
  deleteTextChannel = (id: number) => this.req<void>('DELETE', `/text-channels/${id}`);
  deleteGroup = (id: number) => this.req<void>('DELETE', `/groups/${id}`);
  addMembers = (id: number, user_ids: number[]) => this.req<void>('POST', `/groups/${id}/members`, { user_ids });
  removeMember = (id: number, uid: number) => this.req<void>('DELETE', `/groups/${id}/members/${uid}`);
  createRoom = (gid: number, name: string) => this.req<{ room: Room }>('POST', `/groups/${gid}/rooms`, { name });
  renameRoom = (id: number, name: string) => this.req<void>('PATCH', `/rooms/${id}`, { name });
  deleteRoom = (id: number) => this.req<void>('DELETE', `/rooms/${id}`);
  joinVoice = (target: { room_id?: number; channel_id?: number }) => this.req<{ url: string; token: string; room: string }>('POST', '/voice/join', target);
  leaveVoice = (room: string) => this.req<void>('POST', '/voice/leave', { room });
  ring = (channel: number) => this.req<void>('POST', `/calls/${channel}/ring`);
  decline = (channel: number) => this.req<void>('POST', `/calls/${channel}/decline`);
  cancelCall = (channel: number) => this.req<void>('POST', `/calls/${channel}/cancel`);
}

/** "host", "host:port" or a URL, to an origin. */
export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    const host = s.split(/[/:?#]/)[0];
    const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host);
    s = (local ? 'http://' : 'https://') + s;
  }
  try {
    return new URL(s).origin;
  } catch {
    return '';
  }
}
