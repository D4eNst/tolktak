import type { JSX } from 'preact';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { Icon } from './common';

const SEARCH_DELAY = 350;

export function useSearch(initial = '') {
  const [text, updateText] = useState(initial);
  const [query, updateQuery] = useState(initial);
  const [composing, updateComposing] = useState(false);
  const current = useRef(initial);
  const settled = useRef(initial);
  const composition = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; }, []);
  const commit = useCallback((value: string) => {
    cancel();
    settled.current = value;
    updateQuery(value);
  }, [cancel]);
  const setText = useCallback((value: string) => {
    current.current = value;
    updateText(value);
    cancel();
    if (!value.trim()) commit(value);
    else if (!composition.current && value !== settled.current) timer.current = setTimeout(() => commit(value), SEARCH_DELAY);
  }, [cancel, commit]);
  const flush = useCallback(() => { if (!composition.current) commit(current.current); }, [commit]);
  const onCompositionStart = useCallback(() => {
    cancel();
    composition.current = true;
    updateComposing(true);
  }, [cancel]);
  const onCompositionEnd = useCallback((value: string) => {
    composition.current = false;
    updateComposing(false);
    setText(value);
  }, [setText]);
  useLayoutEffect(() => cancel, [cancel]);
  return { text, setText, query, pending: composing || text !== query, flush, onCompositionStart, onCompositionEnd };
}

export type SearchState = ReturnType<typeof useSearch>;

export function SearchField({ search, placeholder, label = placeholder, autoFocus, maxLength, busy = false, class: cls = '', inputClass, onKeyDown }: {
  search: SearchState; placeholder: string; label?: string; autoFocus?: boolean; maxLength?: number; busy?: boolean;
  class?: string; inputClass?: string; onKeyDown?: JSX.IntrinsicElements['input']['onKeyDown'];
}) {
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  return <div class={`search-control ${cls}${search.pending || busy ? ' search-active' : ''}`} aria-busy={search.pending || busy}>
    <Icon name="search" size={16} />
    <input ref={input} type="search" class={inputClass} value={search.text} placeholder={placeholder} aria-label={label} autoFocus={autoFocus} maxLength={maxLength}
      onInput={(event) => search.setText(event.currentTarget.value)}
      onCompositionStart={() => { composing.current = true; search.onCompositionStart(); }}
      onCompositionEnd={(event) => { composing.current = false; search.onCompositionEnd(event.currentTarget.value); }}
      onKeyDown={(event) => {
        if (composing.current || event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          search.flush();
        }
        onKeyDown?.(event);
      }} />
    {search.text && <button type="button" class="icon-btn tiny search-clear" aria-label={t().common.cancel}
      onMouseDown={(event) => event.preventDefault()} onClick={() => { search.setText(''); input.current?.focus(); }}><Icon name="x" size={14} /></button>}
    <span class="search-activity" aria-hidden="true" />
  </div>;
}
