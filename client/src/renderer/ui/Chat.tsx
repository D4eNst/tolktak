import { signal } from '@preact/signals';
import { Component, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FileMeta, Message } from '../api';
import { bridge } from '../bridge';
import { intlLocale, t } from '../i18n';
import {
  api,
  channels,
  discardPending,
  drafts,
  errorText,
  fileUrl,
  groups,
  loadOlder,
  markRead,
  me,
  messagePreview,
  messages,
  openChannel,
  replyTo,
  sendMessage,
  sendTyping,
  setDraft,
  setReply,
  toast,
  typing,
  upsertMessage,
  userName,
  users,
} from '../state';
import { Avatar, confirmDialog, dayLabel, Icon, type MenuItem, openMenu, Popover, sizeLabel, timeLabel } from './common';
import { EMOJI_GROUPS, emojiGroupName, findSticker, QUICK_REACTIONS, recentEmoji, rememberEmoji, STICKER_PACKS, STICKER_RE, stickerPackName } from './emoji';
import { isJumbo, Markdown } from './markdown';
import { openProfile } from './Profile';

const MAX_FILES = 10;
const MAX_LENGTH = 4000;

const lightbox = signal<{ images: FileMeta[]; index: number } | null>(null);

export function LightboxHost() {
  const lb = lightbox.value;
  useEffect(() => {
    if (!lb) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') lightbox.value = null;
      if (e.key === 'ArrowRight') lightbox.value = { ...lb, index: (lb.index + 1) % lb.images.length };
      if (e.key === 'ArrowLeft') lightbox.value = { ...lb, index: (lb.index - 1 + lb.images.length) % lb.images.length };
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [lb]);
  if (!lb) return null;
  const f = lb.images[lb.index];
  return (
    <div class="lightbox" onClick={() => (lightbox.value = null)}>
      <img src={fileUrl(f.id)} alt={f.name} onClick={(e) => e.stopPropagation()} />
      <div class="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span class="ellipsis">{f.name}</span>
        {lb.images.length > 1 && (
          <span class="muted">
            {lb.index + 1} / {lb.images.length}
          </span>
        )}
        <button class="icon-btn" onClick={() => download(f)} title={t().chat.download} aria-label={t().chat.download}>
          <Icon name="download" />
        </button>
        <button class="icon-btn" onClick={() => (lightbox.value = null)} aria-label={t().chat.close}>
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}

function download(f: FileMeta) {
  bridge.download(fileUrl(f.id, f.name));
}

function AudioPlayer({ f }: { f: FileMeta }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const voice = f.name.startsWith('voice-');
  const bars = useMemo(() => {
    // Real peaks would mean decoding the whole file.
    let h = 0;
    return Array.from({ length: 36 }, (_, i) => {
      h = (h * 31 + f.id.charCodeAt(i % f.id.length)) % 997;
      return 0.25 + ((h % 75) / 100) * (0.6 + 0.4 * Math.sin(i / 3));
    });
  }, [f.id]);
  const fmt = (s: number) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
  const toggle = () => {
    const a = ref.current!;
    if (a.paused) {
      document.querySelectorAll('audio').forEach((x) => x !== a && x.pause());
      a.play();
    } else a.pause();
  };
  return (
    <div class={'audio-att' + (voice ? ' voice' : '')}>
      <button class="audio-play" onClick={toggle} aria-label={playing ? t().chat.audio.pause : t().chat.audio.play}>
        <Icon name={playing ? 'pause' : 'play'} size={18} />
      </button>
      <div class="audio-main">
        {!voice && <div class="audio-name ellipsis">{f.name}</div>}
        <div
          class="wave"
          onClick={(e) => {
            const a = ref.current!;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            if (isFinite(a.duration)) a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
          }}
        >
          {bars.map((b, i) => (
            <span key={i} class={dur && i / bars.length < pos / dur ? 'on' : ''} style={{ height: `${b * 100}%` }} />
          ))}
        </div>
        <div class="audio-time small muted">
          {fmt(playing || pos ? pos : dur)} {!voice && '· ' + sizeLabel(f.size)}
        </div>
      </div>
      <audio
        ref={ref}
        src={fileUrl(f.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (setPlaying(false), setPos(0))}
        onTimeUpdate={(e) => setPos((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={(e) => {
          const a = e.target as HTMLAudioElement;
          // MediaRecorder WebM has no duration until it is seeked once.
          if (a.duration === Infinity) {
            a.currentTime = 1e9;
            a.ondurationchange = () => {
              if (isFinite(a.duration)) {
                setDur(a.duration);
                a.currentTime = 0;
                a.ondurationchange = null;
              }
            };
          } else setDur(a.duration);
        }}
      />
    </div>
  );
}

function Attachments({ files }: { files: FileMeta[] }) {
  const images = files.filter((f) => f.mime.startsWith('image/'));
  const others = files.filter((f) => !f.mime.startsWith('image/'));
  return (
    <div class="atts">
      {images.length > 0 && (
        <div class={'img-grid n' + Math.min(images.length, 4)}>
          {images.map((f, i) => {
            const single = images.length === 1;
            const w = f.width || 400;
            const h = f.height || 300;
            const scale = single ? Math.min(1, 420 / w, 320 / h) : 1;
            return (
              <button
                key={f.id}
                class="img-att"
                style={single ? { width: Math.max(80, Math.round(w * scale)), aspectRatio: `${w} / ${h}` } : undefined}
                onClick={() => (lightbox.value = { images, index: i })}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: t().chat.open, icon: 'maximize', run: () => (lightbox.value = { images, index: i }) },
                    { label: t().chat.download, icon: 'download', run: () => download(f) },
                    { label: t().chat.copyLink, icon: 'link', run: () => copy(fileUrl(f.id, f.name), t().chat.linkCopied) },
                  ])
                }
              >
                <img src={fileUrl(f.id)} alt={f.name} loading="lazy" draggable={false} />
              </button>
            );
          })}
        </div>
      )}
      {others.map((f) =>
        f.mime.startsWith('audio/') ? (
          <AudioPlayer key={f.id} f={f} />
        ) : f.mime.startsWith('video/') ? (
          <video key={f.id} class="video-att" src={fileUrl(f.id)} controls preload="metadata" />
        ) : (
          <button key={f.id} class="file-att" onClick={() => download(f)} title={t().chat.download}>
            <span class="file-icon">
              <Icon name="file" size={22} />
              <span>{(f.name.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</span>
            </span>
            <span class="file-meta">
              <span class="ellipsis">{f.name}</span>
              <span class="small muted">{sizeLabel(f.size)}</span>
            </span>
            <Icon name="download" size={18} />
          </button>
        ),
      )}
    </div>
  );
}

export function EmojiPicker({ onPick, onSticker, onClose, x, y }: { onPick: (e: string) => void; onSticker?: (id: string) => void; onClose: () => void; x: number; y: number }) {
  const [tab, setTab] = useState<number>(recentEmoji().length ? -1 : 0);
  const recent = recentEmoji();
  const pick = (e: string) => {
    rememberEmoji(e);
    onPick(e);
  };
  return (
    <Popover x={x} y={y} onClose={onClose} class="emoji-pop">
      <div class="emoji-tabs">
        {recent.length > 0 && (
          <button class={tab === -1 ? 'active' : ''} onClick={() => setTab(-1)} title={t().chat.emoji.recent}>
            🕘
          </button>
        )}
        {EMOJI_GROUPS.map((g, i) => (
          <button key={g.id} class={tab === i ? 'active' : ''} onClick={() => setTab(i)} title={emojiGroupName(g.id)}>
            {g.icon}
          </button>
        ))}
        {onSticker && (
          <button class={'sticker-tab' + (tab === 100 ? ' active' : '')} onClick={() => setTab(100)} title={t().chat.emoji.stickers}>
            <Icon name="sticker" size={18} />
          </button>
        )}
      </div>
      {tab === 100 && onSticker ? (
        <div class="sticker-grid">
          {STICKER_PACKS.map((p) => (
            <>
              <div class="emoji-title" key={p.id}>
                {stickerPackName(p)}
              </div>
              {p.stickers.map((s) => (
                <button key={s.id} class={'sticker-btn anim-' + s.anim} onClick={() => onSticker(s.id)}>
                  {s.src ? <img src={s.src} alt="" /> : s.emoji}
                </button>
              ))}
            </>
          ))}
        </div>
      ) : (
        <>
          <div class="emoji-title">{tab === -1 ? t().chat.emoji.recent : emojiGroupName(EMOJI_GROUPS[tab].id)}</div>
          <div class="emoji-grid">
            {(tab === -1 ? recent : EMOJI_GROUPS[tab].list.split(' ')).map((e) => (
              <button key={e} onClick={() => pick(e)}>
                {e}
              </button>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}

function copy(text: string, done = t().chat.copied) {
  bridge
    .copy(text)
    .then(() => toast(done))
    .catch(() => toast(t().chat.copyFailed, 'error'));
}

async function react(m: Message, emoji: string) {
  try {
    const { message } = await api().react(m.id, emoji);
    upsertMessage(message);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

function Reactions({ m }: { m: Message }) {
  const myId = me.value?.id ?? 0;
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  if (!m.reactions?.length) return null;
  return (
    <div class="reactions">
      {m.reactions.map((r) => (
        <button
          key={r.emoji}
          class={'reaction' + (r.users.includes(myId) ? ' mine' : '')}
          onClick={() => react(m, r.emoji)}
          title={r.users.map(userName).join(', ')}
        >
          <span class="reaction-emoji">{r.emoji}</span>
          <span class="reaction-n">{r.users.length}</span>
        </button>
      ))}
      <button class="reaction add" onClick={(e) => setPicker({ x: e.clientX, y: e.clientY - 330 })} aria-label={t().chat.message.addReaction}>
        <Icon name="smilePlus" size={16} />
      </button>
      {picker && <EmojiPicker x={picker.x} y={picker.y} onClose={() => setPicker(null)} onPick={(e) => (setPicker(null), react(m, e))} />}
    </div>
  );
}

const highlight = signal(0);

function jumpTo(id: number) {
  const el = document.querySelector(`.msg[data-id="${id}"]`);
  if (!el) {
    toast(t().chat.message.notLoaded);
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  highlight.value = id;
  setTimeout(() => highlight.value === id && (highlight.value = 0), 1600);
}

type RowProps = {
  m: Message;
  grouped: boolean;
  canPin: boolean;
  canDelete: boolean;
  onReply: (m: Message) => void;
  onQuote: (m: Message) => void;
  editing: boolean;
  setEditing: (id: number) => void;
};

function MessageRow({ m, grouped, canPin, canDelete, onReply, onQuote, editing, setEditing }: RowProps) {
  const mine = m.author_id === me.value?.id;
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const author = users.value.get(m.author_id);
  const sticker = STICKER_RE.exec(m.text);
  const st = sticker ? findSticker(sticker[1]) : undefined;

  const del = async () => {
    if (!(await confirmDialog(t().chat.message.deleteConfirm, { text: t().chat.message.deleteConfirmText, ok: t().chat.message.delete, danger: true }))) return;
    try {
      upsertMessage((await api().deleteMessage(m.id)).message);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const pin = async () => {
    try {
      upsertMessage((await api().pin(m.id, !m.pinned_at)).message);
      toast(m.pinned_at ? t().chat.message.unpinned : t().chat.message.pinned);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const menu = (e: MouseEvent) => {
    if (m.deleted) return;
    const sel = window.getSelection()?.toString();
    const tm = t().chat.message;
    const items: MenuItem[] = [
      { label: tm.reply, icon: 'reply', run: () => onReply(m) },
      { label: tm.quote, icon: 'quote', run: () => onQuote(m) },
      { label: tm.reaction, icon: 'smilePlus', run: () => setPicker({ x: e.clientX, y: e.clientY }) },
      'sep',
      ...(m.text && !sticker ? [{ label: sel ? tm.copySelection : tm.copyText, icon: 'copy', run: () => copy(sel || m.text) } as MenuItem] : []),
      ...(canPin ? [{ label: m.pinned_at ? tm.unpin : tm.pin, icon: 'pin', run: pin } as MenuItem] : []),
      ...(mine && !sticker ? [{ label: tm.edit, icon: 'edit', run: () => setEditing(m.id) } as MenuItem] : []),
      ...(mine || canDelete ? ['sep' as const, { label: tm.delete, icon: 'trash', danger: true, run: del } as MenuItem] : []),
    ];
    openMenu(e, items);
  };
  const profile = (e: MouseEvent) => openProfile(m.author_id, e.clientX + 12, e.clientY - 40);

  return (
    <div
      class={'msg' + (grouped ? ' grouped' : '') + (mine ? ' mine' : '') + (editing ? ' editing' : '') + (highlight.value === m.id ? ' flash' : '') + (m.pinned_at ? ' pinned' : '')}
      data-id={m.id}
      onContextMenu={menu}
      onDblClick={(e) => !m.deleted && !(e.target as HTMLElement).closest('a,button,.spoiler,img,audio,video') && onReply(m)}
    >
      {m.reply && (
        <button class="msg-reply" onClick={() => jumpTo(m.reply!.id)}>
          <Icon name="reply" size={14} />
          <Avatar id={m.reply.author_id} size={16} />
          <b>{userName(m.reply.author_id)}</b>
          <span class="ellipsis">{m.reply.deleted ? t().chat.message.replyDeleted : messagePreview(m.reply) || t().chat.message.attachment}</span>
        </button>
      )}
      <div class="msg-gutter">
        {grouped ? (
          <span class="msg-time-hover">{new Date(m.created_at).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })}</span>
        ) : (
          <button class="avatar-btn" onClick={profile} aria-label={t().chat.message.profileOf(userName(m.author_id))}>
            <Avatar id={m.author_id} size={38} />
          </button>
        )}
      </div>
      <div class="msg-main">
        {!grouped && (
          <div class="msg-head">
            <button class="msg-author" style={{ color: author?.color }} onClick={profile}>
              {userName(m.author_id)}
            </button>
            <span class="msg-time">{timeLabel(m.created_at)}</span>
            {m.pinned_at && (
              <span class="msg-pin" title={t().chat.message.pinned}>
                <Icon name="pin" size={12} />
              </span>
            )}
          </div>
        )}
        {m.deleted ? (
          <div class="msg-text deleted">{t().chat.message.deleted}</div>
        ) : st ? (
          <div class={'sticker anim-' + st.anim}>{st.src ? <img src={st.src} alt="" /> : st.emoji}</div>
        ) : (
          m.text && (
            <div class={'msg-text' + (isJumbo(m.text) ? ' jumbo' : '')}>
              <Markdown text={m.text} />
              {m.edited_at && <span class="edited">{t().chat.message.edited}</span>}
            </div>
          )
        )}
        {!m.deleted && m.attachments?.length > 0 && <Attachments files={m.attachments} />}
        {!m.deleted && <Reactions m={m} />}
      </div>
      {!m.deleted && !editing && (
        <div class="msg-actions">
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} class="qr" onClick={() => react(m, e)} title={t().chat.message.reactWith(e)}>
              {e}
            </button>
          ))}
          <button onClick={(e) => setPicker({ x: e.clientX - 300, y: e.clientY + 16 })} title={t().chat.message.reaction} aria-label={t().chat.message.reaction}>
            <Icon name="smilePlus" size={18} />
          </button>
          <button onClick={() => onReply(m)} title={t().chat.message.reply} aria-label={t().chat.message.reply}>
            <Icon name="reply" size={18} />
          </button>
          {mine && !sticker && (
            <button onClick={() => setEditing(m.id)} title={t().chat.message.edit} aria-label={t().chat.message.edit}>
              <Icon name="edit" size={18} />
            </button>
          )}
          <button onClick={menu} title={t().chat.message.more} aria-label={t().chat.message.more}>
            <Icon name="more" size={18} />
          </button>
        </div>
      )}
      {picker && <EmojiPicker x={picker.x} y={picker.y} onClose={() => setPicker(null)} onPick={(e) => (setPicker(null), react(m, e))} />}
    </div>
  );
}

class RowBoundary extends Component<{ children: ComponentChildren }, { failed?: boolean }> {
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div class="msg">
        <div />
        <div class="msg-text deleted">{t().chat.message.unreadable}</div>
      </div>
    );
  }
}

type Upload = { key: number; name: string; size: number; preview?: string; progress: number; file?: FileMeta; error?: string; abort: AbortController };
let uploadSeq = 0;

function imageSize(blob: Blob): Promise<{ w: number; h: number } | undefined> {
  if (!blob.type.startsWith('image/')) return Promise.resolve(undefined);
  return createImageBitmap(blob)
    .then((b) => {
      const d = { w: b.width, h: b.height };
      b.close();
      return d;
    })
    .catch(() => undefined);
}

function useRecorder(onDone: (blob: Blob) => void) {
  const [rec, setRec] = useState<{ started: number; level: number } | null>(null);
  const ref = useRef<{ mr: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number; cancel: boolean } | null>(null);
  const starting = useRef(false);
  const alive = useRef(true);
  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!alive.current) return stream.getTracks().forEach((track) => track.stop());
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48000 });
      const chunks: Blob[] = [];
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const started = Date.now();
      const st = { mr, stream, ctx, raf: 0, cancel: false };
      ref.current = st;
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const x of buf) s += x * x;
        setRec({ started, level: Math.min(1, Math.sqrt(s / buf.length) * 5) });
        st.raf = requestAnimationFrame(tick);
      };
      tick();
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        cancelAnimationFrame(st.raf);
        stream.getTracks().forEach((track) => track.stop());
        ctx.close();
        setRec(null);
        ref.current = null;
        const ms = Date.now() - started;
        if (!st.cancel && ms > 500) onDone(new Blob(chunks, { type: 'audio/webm' }));
      };
      mr.start(250);
    } catch (e) {
      toast(t().chat.composer.micUnavailable(errorText(e)), 'error');
    } finally {
      starting.current = false;
    }
  };
  const stop = (cancel = false) => {
    if (!ref.current) return;
    ref.current.cancel = cancel;
    ref.current.mr.stop();
  };
  useEffect(
    () => () => {
      alive.current = false;
      stop(true);
    },
    [],
  );
  return { rec, start, stop };
}

function wrapSelection(el: HTMLTextAreaElement, mark: string, set: (v: string) => void) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const sel = value.slice(a, b);
  const next = value.slice(0, a) + mark + sel + mark + value.slice(b);
  set(next);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(a + mark.length, b + mark.length);
  });
}

type ComposerProps = { channelId: number; title: string; onEditLast: () => void; edit: Message | null; onEditEnd: () => void };

function Composer({ channelId, title, onEditLast, edit, onEditEnd }: ComposerProps) {
  // While editing, the draft, reply and attachments wait untouched.
  const [editText, setEditText] = useState('');
  const draft = drafts.value.get(channelId) ?? '';
  const text = edit ? editText : draft;
  const setText = (v: string) => (edit ? setEditText(v) : setDraft(channelId, v));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [emoji, setEmoji] = useState<{ x: number; y: number } | null>(null);
  const [mention, setMention] = useState<{ q: string; at: number; idx: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const reply = replyTo.value.get(channelId);
  const recorder = useRecorder((blob) => {
    const name = `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
    addFiles([new File([blob], name, { type: 'audio/webm' })], (f) => sendMessage(channelId, '', { attachments: [f] }));
  });

  useEffect(() => {
    setUploads([]);
    ta.current?.focus();
  }, [channelId]);
  useEffect(() => {
    if (reply) ta.current?.focus();
  }, [reply?.id]);
  useEffect(() => {
    if (!edit) {
      ta.current?.focus();
      return;
    }
    setEditText(edit.text);
    requestAnimationFrame(() => {
      const el = ta.current;
      el?.focus();
      el?.setSelectionRange(edit.text.length, edit.text.length);
    });
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .menu, .popover')) onEditEnd();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [edit?.id]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = el.scrollHeight + 1; // fractional line heights round down
    el.style.height = Math.min(h, 240) + 'px';
    el.style.overflowY = h > 240 ? 'auto' : 'hidden';
  }, [text, channelId]);

  useEffect(() => {
    const h = (e: Event) => addFiles((e as CustomEvent<File[]>).detail);
    window.addEventListener('tolktak:files', h);
    return () => window.removeEventListener('tolktak:files', h);
  });

  const addFiles = (files: File[], sendWhenDone?: (f: FileMeta) => void) => {
    const room = MAX_FILES - uploads.length;
    if (files.length > room && !sendWhenDone) toast(t().chat.composer.tooManyFiles(MAX_FILES), 'error');
    for (const file of sendWhenDone ? files : files.slice(0, room)) {
      const u: Upload = {
        key: ++uploadSeq,
        name: file.name || 'file',
        size: file.size,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        progress: 0,
        abort: new AbortController(),
      };
      const patch = (p: Partial<Upload>) => setUploads((list) => list.map((x) => (x.key === u.key ? { ...x, ...p } : x)));
      if (!sendWhenDone) setUploads((list) => [...list, u]);
      imageSize(file)
        .then((dims) => api().upload(file, u.name, dims, (p) => patch({ progress: p }), u.abort.signal))
        .then((meta) => {
          if (sendWhenDone) sendWhenDone(meta);
          else patch({ file: meta, progress: 1 });
        })
        .catch((e) => {
          if (sendWhenDone) toast(errorText(e), 'error');
          else patch({ error: errorText(e) });
        });
    }
  };
  const removeUpload = (u: Upload) => {
    u.abort.abort();
    if (u.preview) URL.revokeObjectURL(u.preview);
    setUploads((list) => list.filter((x) => x.key !== u.key));
  };

  const busy = uploads.some((u) => !u.file && !u.error);
  const ready = uploads.filter((u) => u.file).map((u) => u.file!);
  const saveEdit = async () => {
    const m = edit!;
    const body = text.trim();
    onEditEnd();
    if (body === m.text || (!body && !m.attachments.length)) return;
    try {
      upsertMessage((await api().editMessage(m.id, body)).message);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const submit = () => {
    if (edit) return saveEdit();
    const body = text.trim();
    if (busy) {
      toast(t().chat.composer.waitForUploads);
      return;
    }
    if (!body && !ready.length) return;
    if (body.length > MAX_LENGTH) {
      toast(t().chat.composer.tooLong(MAX_LENGTH), 'error');
      return;
    }
    sendMessage(channelId, body, { replyTo: reply?.id, attachments: ready });
    uploads.forEach((u) => u.preview && URL.revokeObjectURL(u.preview));
    setUploads([]);
    setText('');
    setReply(channelId, null);
    window.dispatchEvent(new CustomEvent('tolktak:sent'));
  };

  const insert = (s: string) => {
    const el = ta.current;
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? text.length;
    setText(text.slice(0, a) + s + text.slice(b));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + s.length, a + s.length);
    });
  };

  const mentionList = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return [...users.value.values()].filter((u) => u.id !== me.value?.id && (u.username.toLowerCase().startsWith(q) || u.display_name.toLowerCase().startsWith(q))).slice(0, 6);
  }, [mention?.q, users.value]);
  const completeMention = (username: string) => {
    if (!mention) return;
    const el = ta.current!;
    const caret = el.selectionStart;
    const next = text.slice(0, mention.at) + '@' + username + ' ' + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => el.setSelectionRange(mention.at + username.length + 2, mention.at + username.length + 2));
  };

  if (recorder.rec) {
    const secs = Math.floor((Date.now() - recorder.rec.started) / 1000);
    return (
      <div class="composer recording">
        <button class="icon-btn" onClick={() => recorder.stop(true)} title={t().chat.composer.cancelRecordingHint} aria-label={t().chat.composer.cancelRecording}>
          <Icon name="trash" />
        </button>
        <span class="rec-dot" />
        <span class="rec-time">
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </span>
        <div class="rec-level">
          <div style={{ transform: `scaleX(${0.05 + recorder.rec.level})` }} />
        </div>
        <span class="muted small">{t().chat.composer.recording}</span>
        <button class="send-btn" onClick={() => recorder.stop(false)} title={t().chat.composer.send} aria-label={t().chat.composer.sendVoice}>
          <Icon name="send" size={18} />
        </button>
      </div>
    );
  }

  return (
    <div class="composer-wrap">
      {edit && (
        <div class="reply-bar edit-bar">
          <Icon name="edit" size={16} />
          <span>
            {t().chat.composer.editing} <span class="muted">· {t().chat.composer.editHint}</span>
          </span>
          <button class="icon-btn tiny" onClick={onEditEnd} aria-label={t().chat.composer.cancelEdit}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {!edit && uploads.length > 0 && (
        <div class="upload-tray">
          {uploads.map((u) => (
            <div key={u.key} class={'upload' + (u.error ? ' failed' : '')} title={u.error ?? u.name}>
              {u.preview ? <img src={u.preview} alt="" /> : <Icon name="file" size={26} />}
              <span class="upload-name ellipsis">{u.name}</span>
              <span class="small muted">{u.error ? t().chat.composer.uploadFailed : u.file ? sizeLabel(u.size) : Math.round(u.progress * 100) + '%'}</span>
              {!u.file && !u.error && <span class="upload-progress" style={{ width: `${u.progress * 100}%` }} />}
              <button class="upload-x" onClick={() => removeUpload(u)} aria-label={t().chat.composer.removeFile}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {!edit && reply && (
        <div class="reply-bar">
          <Icon name="reply" size={16} />
          <span>
            {t().chat.composer.replyingTo} <b>{userName(reply.author_id)}</b>: <span class="muted">{messagePreview(reply).slice(0, 120)}</span>
          </span>
          <button class="icon-btn tiny" onClick={() => setReply(channelId, null)} aria-label={t().chat.composer.cancelReply}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {mention && mentionList.length > 0 && (
        <div class="mention-pop pop-in">
          {mentionList.map((u, i) => (
            <button key={u.id} class={i === mention.idx ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), completeMention(u.username))}>
              <Avatar id={u.id} size={22} />
              <span>{u.display_name}</span>
              <span class="muted small">@{u.username}</span>
            </button>
          ))}
        </div>
      )}
      <div class={'composer' + (edit ? ' editing' : '')}>
        <label class="icon-btn attach" title={t().chat.composer.attach} aria-label={t().chat.composer.attach}>
          <Icon name="plus" />
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              addFiles([...(input.files ?? [])]);
              input.value = '';
            }}
          />
        </label>
        <textarea
          ref={ta}
          rows={1}
          placeholder={t().chat.composer.placeholder(title)}
          value={text}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            setText(el.value);
            sendTyping(channelId);
            const before = el.value.slice(0, el.selectionStart);
            const mm = /(^|\s)@([\p{L}0-9_.-]{0,32})$/u.exec(before);
            setMention(mm ? { q: mm[2], at: before.length - mm[2].length - 1, idx: 0 } : null);
          }}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.length) {
              e.preventDefault();
              addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${Date.now()}${i ? '-' + i : ''}.png`, { type: f.type }))));
            }
          }}
          onKeyDown={(e) => {
            if (mention && mentionList.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const d = e.key === 'ArrowDown' ? 1 : -1;
                setMention({ ...mention, idx: (mention.idx + d + mentionList.length) % mentionList.length });
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                completeMention(mentionList[mention.idx].username);
                return;
              }
              if (e.key === 'Escape') {
                setMention(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape' && edit) {
              e.preventDefault();
            } else if (e.key === 'Escape' && reply) {
              e.stopPropagation();
              setReply(channelId, null);
            } else if (e.key === 'ArrowUp' && !text && !edit) {
              e.preventDefault();
              onEditLast();
            } else if (e.ctrlKey && !e.shiftKey && e.code === 'KeyB') {
              e.preventDefault();
              wrapSelection(e.currentTarget, '**', setText);
            } else if (e.ctrlKey && !e.shiftKey && e.code === 'KeyI') {
              e.preventDefault();
              wrapSelection(e.currentTarget, '*', setText);
            } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyX') {
              e.preventDefault();
              wrapSelection(e.currentTarget, '~~', setText);
            }
          }}
          aria-label={t().chat.composer.label}
        />
        <button class="icon-btn" onClick={(e) => setEmoji({ x: e.clientX - 320, y: e.clientY - 380 })} title={t().chat.composer.emoji} aria-label={t().chat.composer.emojiLabel}>
          <Icon name="smile" />
        </button>
        {edit ? (
          <button class="send-btn" onClick={submit} title={t().chat.composer.saveHint} aria-label={t().chat.composer.save}>
            <Icon name="check" size={18} />
          </button>
        ) : text.trim() || ready.length || busy ? (
          <button class="send-btn" onClick={submit} disabled={busy} title={t().chat.composer.sendHint} aria-label={t().chat.composer.send}>
            <Icon name="send" size={18} />
          </button>
        ) : (
          <button class="icon-btn mic-rec" onClick={recorder.start} title={t().chat.composer.recordVoice} aria-label={t().chat.composer.recordVoice}>
            <Icon name="mic" />
          </button>
        )}
      </div>
      {emoji && (
        <EmojiPicker
          x={emoji.x}
          y={emoji.y}
          onClose={() => setEmoji(null)}
          onPick={(e) => insert(e)}
          onSticker={(id) => {
            setEmoji(null);
            sendMessage(channelId, `[[sticker:${id}]]`, { replyTo: reply?.id });
            setReply(channelId, null);
          }}
        />
      )}
    </div>
  );
}

function MiniMessage({ m, onJump }: { m: Message; onJump: () => void }) {
  return (
    <button class="mini-msg" onClick={onJump}>
      <Avatar id={m.author_id} size={28} />
      <span class="mini-msg-main">
        <span class="mini-msg-head">
          <b>{userName(m.author_id)}</b> <span class="muted small">{timeLabel(m.created_at)}</span>
        </span>
        <span class="mini-msg-text">{messagePreview(m)}</span>
      </span>
    </button>
  );
}

function PinsPanel({ channelId, onClose }: { channelId: number; onClose: () => void }) {
  const [list, setList] = useState<Message[] | null>(null);
  const cm = messages.value.get(channelId);
  const pinnedIds = (cm?.items ?? []).filter((m) => m.pinned_at).map((m) => m.id).join();
  useEffect(() => {
    api()
      .pins(channelId)
      .then((r) => setList(r.messages))
      .catch((e) => toast(errorText(e), 'error'));
  }, [channelId, pinnedIds]);
  return (
    <aside class="chat-panel slide-in">
      <header>
        <Icon name="pin" size={18} />
        <h3>{t().chat.pins.title}</h3>
        <button class="icon-btn" onClick={onClose} aria-label={t().chat.close}>
          <Icon name="x" />
        </button>
      </header>
      <div class="chat-panel-list">
        {list === null && <div class="muted small pad">{t().chat.pins.loading}</div>}
        {list?.length === 0 && <div class="panel-empty">{t().chat.pins.empty}</div>}
        {list?.map((m) => <MiniMessage key={m.id} m={m} onJump={() => jumpTo(m.id)} />)}
      </div>
    </aside>
  );
}

function SearchPanel({ channelId, onClose }: { channelId: number; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Message[] | null>(null);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) {
      setRes(null);
      return;
    }
    const timer = setTimeout(() => {
      api()
        .messages(channelId, { q: s, limit: 50 })
        .then((r) => setRes(r.messages))
        .catch((e) => toast(errorText(e), 'error'));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, channelId]);
  return (
    <aside class="chat-panel slide-in">
      <header>
        <div class="search-field">
          <Icon name="search" size={16} />
          <input autoFocus placeholder={t().chat.search.placeholder} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <button class="icon-btn" onClick={onClose} aria-label={t().chat.close}>
          <Icon name="x" />
        </button>
      </header>
      <div class="chat-panel-list">
        {res === null && <div class="panel-empty">{t().chat.search.tooShort}</div>}
        {res?.length === 0 && <div class="panel-empty">{t().chat.search.empty}</div>}
        {res?.map((m) => <MiniMessage key={m.id} m={m} onJump={() => jumpTo(m.id)} />)}
      </div>
    </aside>
  );
}

export function ChatView({
  channelId,
  title,
  subtitle,
  icon,
  actions,
  canModerate = false,
}: {
  channelId: number;
  title: string;
  subtitle?: ComponentChildren;
  icon?: ComponentChildren;
  actions?: ComponentChildren;
  canModerate?: boolean;
}) {
  const cm = messages.value.get(channelId);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const [panel, setPanel] = useState<null | 'pins' | 'search'>(null);
  const [editing, setEditing] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    stickToBottom.current = true;
    setEditing(0);
    openChannel(channelId);
  }, [channelId]);
  useEffect(() => {
    const sent = () => {
      stickToBottom.current = true;
      const el = listRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    };
    window.addEventListener('tolktak:sent', sent);
    return () => window.removeEventListener('tolktak:sent', sent);
  }, []);

  const items = cm?.items ?? [];
  const pending = cm?.pending ?? [];
  const last = items[items.length - 1];

  useEffect(() => {
    if (last && document.hasFocus() && stickToBottom.current) markRead(channelId, last.id);
    const onFocus = () => last && stickToBottom.current && markRead(channelId, last.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channelId, last?.id]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else if (prevHeight.current && el.scrollHeight > prevHeight.current && el.scrollTop < 50) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    }
    prevHeight.current = el.scrollHeight;
  }, [items.length, pending.length, items[0]?.id]);

  // Images load after layout: stay pinned to the bottom meanwhile.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, [items.length, channelId]);

  const onScroll = () => {
    const el = listRef.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (bottom && last) markRead(channelId, last.id);
    if (el.scrollTop < 300 && cm?.hasOlder && !cm.loading) {
      prevHeight.current = el.scrollHeight;
      loadOlder(channelId);
    }
  };

  const onReply = (m: Message) => setReply(channelId, m);
  const onQuote = (m: Message) => {
    const quoted = m.text
      .split('\n')
      .map((l) => '> ' + l)
      .join('\n');
    const cur = drafts.value.get(channelId) ?? '';
    setDraft(channelId, (cur ? cur + '\n' : '') + quoted + '\n');
    setReply(channelId, m);
  };
  const editLast = () => {
    const mine = [...items].reverse().find((m) => m.author_id === me.value?.id && !m.deleted && !STICKER_RE.test(m.text));
    if (mine) setEditing(mine.id);
  };

  const typers = [...(typing.value.get(channelId)?.entries() ?? [])].filter(([, until]) => until > Date.now()).map(([id]) => userName(id));
  const channel = channels.value.get(channelId);
  const unreadMarker = channel?.last_read_id ?? 0;
  const unreadBelow = !atBottom ? (channel?.unread ?? 0) : 0;
  const g = channel?.group_id ? groups.value.get(channel.group_id) : undefined;

  return (
    <section
      class="chat"
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        dragDepth.current++;
        setDrag(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDrag(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDrag(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) window.dispatchEvent(new CustomEvent('tolktak:files', { detail: files }));
      }}
    >
      <header class="main-head">
        <div class="head-title">
          {icon}
          <div>
            <h1>{title}</h1>
            {subtitle && <div class="muted small head-sub">{subtitle}</div>}
          </div>
        </div>
        <div class="head-actions">
          {actions}
          <button class={'icon-btn' + (panel === 'pins' ? ' active' : '')} onClick={() => setPanel(panel === 'pins' ? null : 'pins')} title={t().chat.pins.title} aria-label={t().chat.pins.title}>
            <Icon name="pin" />
          </button>
          <button class={'icon-btn' + (panel === 'search' ? ' active' : '')} onClick={() => setPanel(panel === 'search' ? null : 'search')} title={t().chat.search.title} aria-label={t().chat.search.label}>
            <Icon name="search" />
          </button>
        </div>
      </header>
      <div class="chat-body">
        <div class="chat-col">
          <div class="msg-list" ref={listRef} onScroll={onScroll}>
            {cm?.loading && (
              <div class="loading-dots">
                <span />
                <span />
                <span />
              </div>
            )}
            {cm?.loaded && !cm.hasOlder && (
              <div class="chat-start">
                <div class="chat-start-icon">{icon ?? <Icon name="chat" size={28} />}</div>
                <h2>{title}</h2>
                <p class="muted">{g ? t().chat.view.channelStart : t().chat.view.dmStart}</p>
              </div>
            )}
            {items.map((m, i) => {
              const prev = items[i - 1];
              const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
              const grouped = !!prev && !newDay && prev.author_id === m.author_id && m.created_at - prev.created_at < 5 * 60_000 && !prev.deleted && !m.reply;
              return (
                <div key={m.id} class="msg-wrap">
                  {newDay && (
                    <div class="day-divider">
                      <span>{dayLabel(m.created_at)}</span>
                    </div>
                  )}
                  {prev && prev.id <= unreadMarker && m.id > unreadMarker && m.author_id !== me.value?.id && <div class="new-divider">{t().chat.view.newMessages}</div>}
                  <RowBoundary>
                    <MessageRow m={m} grouped={grouped} canPin={canModerate || !g} canDelete={canModerate && !!g} onReply={onReply} onQuote={onQuote} editing={editing === m.id} setEditing={setEditing} />
                  </RowBoundary>
                </div>
              );
            })}
            {pending.map((p) => (
              <div class={'msg pending ' + p.status} key={p.nonce}>
                <div class="msg-gutter">
                  <Avatar id={me.value!.id} size={38} />
                </div>
                <div class="msg-main">
                  {p.text && (
                    <div class="msg-text">
                      <Markdown text={p.text} />
                    </div>
                  )}
                  {p.attachments.length > 0 && <div class="small muted">{t().chat.view.attachments(p.attachments.length)}</div>}
                  {p.status === 'failed' ? (
                    <div class="small error">
                      {t().chat.view.notSent}{' '}
                      <button class="link" onClick={() => sendMessage(channelId, p.text, { retryNonce: p.nonce, replyTo: p.reply_to, attachments: p.attachments })}>
                        {t().chat.view.retry}
                      </button>{' '}
                      <button class="link" onClick={() => discardPending(channelId, p.nonce)}>
                        {t().chat.view.discard}
                      </button>
                    </div>
                  ) : (
                    <div class="small muted">{t().chat.view.sending}</div>
                  )}
                </div>
              </div>
            ))}
            {!atBottom && (
              <button
                class="to-bottom pop-in"
                onClick={() => {
                  stickToBottom.current = true;
                  listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
                }}
                aria-label={t().chat.view.toLatest}
              >
                <Icon name="arrowDown" size={18} />
                {unreadBelow > 0 && <span class="badge">{unreadBelow}</span>}
              </button>
            )}
          </div>
          <div class="typing small">
            {typers.length > 0 && (
              <>
                <span class="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
                {t().chat.view.typing(typers)}
              </>
            )}
          </div>
          <Composer channelId={channelId} title={title} onEditLast={editLast} edit={items.find((m) => m.id === editing) ?? null} onEditEnd={() => setEditing(0)} />
        </div>
        {panel === 'pins' && <PinsPanel channelId={channelId} onClose={() => setPanel(null)} />}
        {panel === 'search' && <SearchPanel channelId={channelId} onClose={() => setPanel(null)} />}
      </div>
      {drag && (
        <div class="drop-overlay">
          <div>
            <Icon name="clip" size={36} />
            <b>{t().chat.view.dropTitle}</b>
            <span class="muted">{t().chat.view.dropHint(MAX_FILES)}</span>
          </div>
        </div>
      )}
    </section>
  );
}
