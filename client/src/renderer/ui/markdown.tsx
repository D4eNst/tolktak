// Never parsed as HTML: every node is built with Preact.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { bridge } from '../bridge';
import { t } from '../i18n';
import { me, users } from '../state';

const INLINE =
  /(`[^`\n]+`)|(\|\|[\s\S]+?\|\|)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(~~[\s\S]+?~~)|(\*[^*\s](?:[^*]*[^*\s])?\*)|(\b_[^_\s](?:[^_]*[^_\s])?_\b)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(@[a-z0-9_.-]{2,32})/gi;

function Spoiler({ children }: { children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <span class={'spoiler' + (open ? ' open' : '')} onClick={(e) => (e.stopPropagation(), setOpen(true))} title={open ? undefined : t().chat.markdown.spoiler}>
      {children}
    </span>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        bridge.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

// Direction overrides can make a link read as a different address.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function inline(text: string, key = 'i'): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE.source, INLINE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}.${n++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<Spoiler key={k}>{inline(tok.slice(2, -2), k)}</Spoiler>);
    else if (m[3]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[4]) out.push(<u key={k}>{inline(tok.slice(2, -2), k)}</u>);
    else if (m[5]) out.push(<s key={k}>{inline(tok.slice(2, -2), k)}</s>);
    else if (m[6] || m[7]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else if (m[8]) {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(tok)!;
      // The label can claim any address, so the real host follows it.
      const host = URL.parse(href)?.hostname ?? href;
      out.push(
        <ExternalLink key={k} href={href}>
          {label.replace(BIDI, '')}
        </ExternalLink>,
        <span key={k + 'h'} class="muted"> ({host.replace(BIDI, '')})</span>,
      );
    } else if (m[9]) {
      const shown = tok.replace(BIDI, '');
      out.push(
        <ExternalLink key={k} href={tok}>
          {shown.length > 80 ? shown.slice(0, 77) + '…' : shown}
        </ExternalLink>,
      );
    } else if (m[10]) {
      const name = tok.slice(1).toLowerCase();
      const u = [...users.value.values()].find((x) => x.username.toLowerCase() === name);
      if (u) out.push(<span key={k} class={'mention' + (u.id === me.value?.id ? ' me' : '')}>@{u.display_name}</span>);
      else out.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(text: string, key: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const ls = text.split('\n');
  let i = 0;
  while (i < ls.length) {
    const l = ls[i];
    if (/^>\s?/.test(l)) {
      const q: string[] = [];
      while (i < ls.length && /^>\s?/.test(ls[i])) q.push(ls[i++].replace(/^(?:>\s?)+/, ''));
      out.push(<blockquote key={key + i}>{lines(q.join('\n'), key + 'q' + i)}</blockquote>);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items: string[] = [];
      while (i < ls.length && /^\s*([-*•]|\d+[.)])\s+/.test(ls[i])) items.push(ls[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const lis = items.map((it, j) => <li key={j}>{inline(it, key + 'l' + i + '.' + j)}</li>);
      out.push(ordered ? <ol key={key + i}>{lis}</ol> : <ul key={key + i}>{lis}</ul>);
      continue;
    }
    out.push(
      <span class="md-line" key={key + i}>
        {inline(l, key + i)}
        {i < ls.length - 1 ? '\n' : null}
      </span>,
    );
    i++;
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```(?:[a-z0-9+#-]*\n)?([\s\S]*?)```/i);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} class="code-block">
            <code>{p.replace(/\n$/, '')}</code>
          </pre>
        ) : p ? (
          lines(p.replace(/^\n|\n$/g, ''), 'b' + i)
        ) : null,
      )}
    </>
  );
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍|\p{Emoji_Modifier}|\p{Extended_Pictographic})*\s*){1,3}$/u;
export function isJumbo(text: string) {
  return text.length <= 40 && EMOJI_ONLY.test(text.trim());
}

export function plain(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, t().chat.markdown.code)
    .replace(/\|\|[\s\S]+?\|\|/g, '▒▒▒')
    .replace(/[*_~`]+/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
