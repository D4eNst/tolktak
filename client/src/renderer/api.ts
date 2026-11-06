export type User = {
  profile_revision?: number;
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
export type FileMeta = { id: string; name: string; mime: string; size: number; width?: number; height?: number; local_id?: string };
export type ReplyPreview = { id: number; author_id: number; text: string; deleted: boolean; attachments: number; revision?: number };
export type Reaction = { emoji: string; users: number[] };
export type Message = {
  id: number;
  revision?: number;
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
  history_version?: number;
  kind: 'dm' | 'group';
  peer_id?: number;
  group_id?: number;
  last_message: Message | null;
  last_read_id: number;
  unread: number;
};
export type ReadState = { channel_id: number; message_id: number; unread: number; history_version: number };
export type HistoryQuery = { before?: number; after?: number; around?: number; limit?: number };
export type HistoryPage = { messages: Message[]; users: User[]; first_id: number | null; last_id: number | null; has_before: boolean; has_after: boolean; history_version: number; read: { message_id: number; unread: number } };
export type MessageChanges = { messages: Message[]; users: User[]; history_version: number; complete: boolean; read: { message_id: number; unread: number } };
export type SearchPage = { messages: Message[]; users: User[]; has_more: boolean; next_before: number | null; history_version: number };
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
export type Relation = { state: 'none' | 'incoming' | 'outgoing' | 'contact'; request_id: string | null; since: number | null };
export type ContactSummary = { contacts_version: number; incoming_count: number };
export type RelationSnapshot = { contacts_version: number; relations?: Record<string, Relation>; incoming_count?: number };
export type UserPage = ProfilesPage & { has_more: boolean; next_after: number | null };
export type ContactState = { user_id: number; contact: boolean; contacts_version: number; relation?: Relation; incoming_count?: number };
export type ProfilesPage = RelationSnapshot & { users: User[]; contact_ids: number[] };
export type ProfilePatch = { display_name?: string; about?: string; status?: string; avatar?: string };
export type VoiceMember = { user_id: number; muted: boolean; deafened: boolean; camera: boolean; screen: boolean; joined_at: number };
export type VoiceRoom = { room: string; members: VoiceMember[] };
export type VoiceSource = 'microphone' | 'camera' | 'screen';
export type ModerationSource = VoiceSource | 'entry';
export type ModerationDuration = { duration: 'time'; seconds: number } | { duration: 'call' | 'permanent' };
export type ModerationRule = { id: number; room_id: number; user_id: number; source: ModerationSource; duration: ModerationDuration['duration']; expires_at: number | null; call_id: number | null; created_by: number };
export type VoicePermissions = { room_id: number | null; user_id: number; rules: ModerationRule[]; allowed: Record<ModerationSource, boolean>; moderation_version: number; call_id: number | null };
export type VoiceModerationEvent = { room_id: number; user_id: number; source: ModerationSource; action: 'off' | 'set' | 'clear' | 'kick'; permissions: VoicePermissions };
export type ModerationPage = { rules: ModerationRule[]; users: User[]; has_more: boolean; next_after: number | null; moderation_version: number; call_id: number | null };
export type ServerInfo = { name: string; version: string; registration: string; livekit_url: string; client_download_url: string; min_client: string; capabilities?: { history?: number; changes?: number; search?: number; users?: number; contacts?: number; profile_watch?: number; group_order?: number; moderation?: number } };
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

  async req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + '/api/v1' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
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
  directory = (q = '', after = 0, signal?: AbortSignal, exclude: number[] = []) => {
    const params = new URLSearchParams({ q, after: String(after), limit: '50' });
    if (exclude.length) params.set('exclude', exclude.join(','));
    return this.req<UserPage>('GET', `/users/directory?${params}`, undefined, signal);
  };
  contacts = (after = 0, signal?: AbortSignal, relation?: 'contact' | 'incoming' | 'outgoing', q = '') => {
    const params = new URLSearchParams({ after: String(after), limit: '50' });
    if (relation) params.set('relation', relation);
    if (q) params.set('q', q);
    return this.req<UserPage>('GET', `/contacts?${params}`, undefined, signal);
  };
  dialogUsers = (q = '', after = 0, signal?: AbortSignal) => this.req<UserPage>('GET', `/users/dialogs?${new URLSearchParams({ q, after: String(after), limit: '50' })}`, undefined, signal);
  contactsSummary = (signal?: AbortSignal) => this.req<ContactSummary>('GET', '/contacts/summary', undefined, signal);
  profiles = (ids: number[], signal?: AbortSignal) => this.req<ProfilesPage>('POST', '/users/profiles', { ids }, signal);
  profile = (id: number, signal?: AbortSignal) => this.req<{ user: User; contact: boolean; contacts_version: number; relation?: Relation; incoming_count?: number }>('GET', `/users/${id}`, undefined, signal);
  setContact = (id: number, contact: boolean) => this.req<ContactState>(contact ? 'PUT' : 'DELETE', `/contacts/${id}`);
  contactAction = (id: number, action: 'request' | 'accept' | 'decline' | 'cancel' | 'remove', request_id?: string | null) =>
    this.req<ContactState>(action === 'request' ? 'PUT' : action === 'remove' ? 'DELETE' : 'POST', `/contacts/${id}${action === 'request' || action === 'remove' ? '' : '/' + action}`, action === 'request' ? undefined : { request_id });
  reorderChannels = (group: number, ids: number[]) => this.req<void>('PUT', `/groups/${group}/channel-order`, { ids });
  reorderRooms = (group: number, ids: number[]) => this.req<void>('PUT', `/groups/${group}/room-order`, { ids });
  channels = () => this.req<{ channels: Channel[] }>('GET', '/channels');
  openDM = (user_id: number) => this.req<{ channel: Channel }>('POST', '/dms', { user_id });
  messages = (channel: number, q: { before?: number; after?: number; limit?: number; q?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
    return this.req<{ messages: Message[] }>('GET', `/channels/${channel}/messages?${p}`);
  };
  history = (channel: number, query: HistoryQuery = {}, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) p.set(key, String(value));
    return this.req<HistoryPage>('GET', `/channels/${channel}/history?${p}`, undefined, signal);
  };
  changes = (channel: number, since: number, signal?: AbortSignal) =>
    this.req<MessageChanges>('GET', `/channels/${channel}/changes?since=${since}&limit=100`, undefined, signal);
  send = (channel: number, body: { text: string; nonce: string; reply_to?: number; attachments?: string[] }) =>
    this.req<{ message: Message }>('POST', `/channels/${channel}/messages`, body);
  react = (id: number, emoji: string) => this.req<{ message: Message }>('POST', `/messages/${id}/reactions`, { emoji });
  pin = (id: number, on: boolean) => this.req<{ message: Message }>(on ? 'POST' : 'DELETE', `/messages/${id}/pin`);
  pins = (channel: number, signal?: AbortSignal) => this.req<{ messages: Message[]; users: User[]; history_version: number }>('GET', `/channels/${channel}/pins`, undefined, signal);
  search = (channel: number, q: string, before?: number, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q, limit: '50' });
    if (before !== undefined) params.set('before', String(before));
    return this.req<SearchPage>('GET', `/channels/${channel}/search?${params}`, undefined, signal);
  };
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
  readState = (channel: number) => this.req<ReadState>('GET', `/channels/${channel}/read`);
  markRead = (channel: number, message_id: number) => this.req<ReadState | undefined>('POST', `/channels/${channel}/read`, { message_id });
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
  joinVoice = (target: { room_id?: number; channel_id?: number }) => this.req<{ url: string; token: string; room: string; permissions?: VoicePermissions }>('POST', '/voice/join', target);
  roomPermissions = (room: number, signal?: AbortSignal) => this.req<VoicePermissions>('GET', `/rooms/${room}/permissions`, undefined, signal);
  moderation = (room: number, after = 0, signal?: AbortSignal) => this.req<ModerationPage>('GET', `/rooms/${room}/moderation?after=${after}&limit=50`, undefined, signal);
  restrictVoice = (room: number, user: number, source: ModerationSource, duration: ModerationDuration) => this.req<VoicePermissions>('PUT', `/rooms/${room}/moderation/${user}/${source}`, duration);
  allowVoice = (room: number, user: number, source: ModerationSource) => this.req<VoicePermissions>('DELETE', `/rooms/${room}/moderation/${user}/${source}`);
  turnOffVoice = (room: number, user: number, source: VoiceSource) => this.req<VoicePermissions>('POST', `/rooms/${room}/participants/${user}/off`, { source });
  kickVoice = (room: number, user: number) => this.req<VoicePermissions>('POST', `/rooms/${room}/participants/${user}/kick`, {});
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
