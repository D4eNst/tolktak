import { t } from '../i18n';
import { ACCENTS, type Custom, CUSTOM_DEFAULT, customVars, setTheme, theme, type ThemeId, THEMES } from '../theme';
import { Icon } from './common';

function ThemeCard({ id, style }: { id: ThemeId; style?: Record<string, string> }) {
  const tx = t().settings.look;
  const on = theme.value.id === id;
  return (
    <button class={'theme-card' + (on ? ' on' : '')} data-theme={id} style={style} role="radio" aria-checked={on} onClick={() => setTheme({ id })}>
      <span class="tc-desk" aria-hidden="true">
        <i class="tc-nav">
          <i />
          <i class="sel" />
          <i />
        </i>
        <span class="tc-win">
          <i class="tc-title" />
          <span class="tc-msg">
            <i style={{ background: 'var(--user-3)' }} />
            <b style={{ width: '70%' }} />
          </span>
          <span class="tc-msg">
            <i style={{ background: 'var(--user-1)' }} />
            <b style={{ width: '48%' }} />
          </span>
          <i class="tc-btn" />
        </span>
      </span>
      <span class="tc-name">
        {tx.names[id]}
        {on && <Icon name="check" size={14} />}
      </span>
      <span class="tc-note">{id === 'petrol' ? tx.byDefault : tx.notes[id]}</span>
    </button>
  );
}

function Dial({ label, value, track, onInput }: { label: string; value: number; track: string; onInput: (v: number) => void }) {
  return (
    <label class="dial">
      <span>{label}</span>
      <input type="range" min={0} max={100} value={value} style={{ '--track': track }} onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))} />
    </label>
  );
}

function CustomEditor() {
  const tx = t().settings.look;
  const c = theme.value.custom;
  const set = (patch: Partial<Custom>) => setTheme({ id: 'custom', custom: { ...c, ...patch } });
  const v = customVars(c);
  const h = c.hue;
  return (
    <div class={'custom-editor' + (theme.value.id === 'custom' ? '' : ' idle')}>
      <div class="seg" role="radiogroup" aria-label={tx.mode}>
        {[false, true].map((light) => (
          <button key={String(light)} role="radio" aria-checked={c.light === light} class={c.light === light ? 'on' : ''} onClick={() => set({ light })}>
            {light ? tx.light : tx.dark}
          </button>
        ))}
      </div>
      <Dial
        label={tx.hue}
        value={(h / 360) * 100}
        track="linear-gradient(90deg, hsl(0 60% 45%), hsl(60 60% 45%), hsl(120 60% 45%), hsl(180 60% 45%), hsl(240 60% 45%), hsl(300 60% 45%), hsl(360 60% 45%))"
        onInput={(x) => set({ hue: Math.round((x / 100) * 360) })}
      />
      <Dial label={tx.tint} value={c.tint} track={`linear-gradient(90deg, hsl(${h} 0% 40%), hsl(${h} 55% 40%))`} onInput={(tint) => set({ tint })} />
      <Dial label={tx.depth} value={c.depth} track={c.light ? `linear-gradient(90deg, hsl(${h} 20% 80%), hsl(${h} 20% 94%))` : `linear-gradient(90deg, hsl(${h} 20% 3%), hsl(${h} 20% 16%))`} onInput={(depth) => set({ depth })} />
      <Dial label={tx.contrast} value={c.contrast} track={`linear-gradient(90deg, ${v['--bg-app']}, ${v['--bg-island']} 40%, ${v['--bg-hover']})`} onInput={(contrast) => set({ contrast })} />
      <div class="dial">
        <span>{tx.accent}</span>
        <div class="swatches" role="radiogroup" aria-label={tx.accent}>
          {ACCENTS.map((a) => (
            <button key={a} class={'swatch' + (c.accent === a ? ' on' : '')} style={{ background: a }} role="radio" aria-checked={c.accent === a} aria-label={a} onClick={() => set({ accent: a })} />
          ))}
          <label class={'swatch pick' + (ACCENTS.includes(c.accent) ? '' : ' on')} title={tx.pick} style={ACCENTS.includes(c.accent) ? undefined : { background: c.accent }}>
            <input type="color" value={c.accent} aria-label={tx.pick} onInput={(e) => set({ accent: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
      </div>
      <button class="link custom-reset" onClick={() => set(CUSTOM_DEFAULT)}>
        {tx.reset}
      </button>
    </div>
  );
}

export function AppearanceSettings() {
  const tx = t().settings.look;
  return (
    <div class="look">
      {([false, true] as const).map((light) => (
        <section key={String(light)}>
          <div class="field-label">{light ? tx.lightGroup : tx.darkGroup}</div>
          <div class="theme-grid" role="radiogroup" aria-label={light ? tx.lightGroup : tx.darkGroup}>
            {THEMES.filter((x) => x.light === light).map((x) => (
              <ThemeCard key={x.id} id={x.id} />
            ))}
          </div>
        </section>
      ))}
      <section>
        <div class="field-label">{tx.ownGroup}</div>
        <div class="own">
          <ThemeCard id="custom" style={customVars(theme.value.custom)} />
          <CustomEditor />
        </div>
      </section>
    </div>
  );
}
