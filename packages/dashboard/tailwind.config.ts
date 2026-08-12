import type { Config } from 'tailwindcss';

/**
 * Aviary token → Tailwind colour. Copied verbatim from `AVIARY-UI.md` ("The Tailwind 3 opacity
 * trap") — do not re-derive it.
 *
 * The tokens in `src/app/index.css` are hex custom properties, which is the shape the spec publishes
 * and the other three consoles copy. Tailwind 3 cannot apply an opacity modifier to an arbitrary
 * `var()` colour: `bg-[var(--accent)]/10` emits NO RULE AT ALL, which looks exactly like a
 * background nobody intended. Declaring the token as a colour *function* makes Tailwind hand the
 * modifier over, and `color-mix` applies it — so `bg-brand/10` behaves exactly like `bg-zinc-900/10`.
 */
function token(name: string) {
  return ({ opacityValue }: { opacityValue?: string | undefined }): string =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}

export default {
  content: ['./index.html', './preview.html', './src/app/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // ── shadcn's semantic names → Aviary tokens (the mapping table in AVIARY-UI.md), rather
        // than shadcn's default palette. This is what makes a vendored `bg-background` /
        // `text-muted-foreground` primitive land on this console's own neutrals with no edit.
        // Three of these are traps, because the two systems use the same word for different things:
        //   · shadcn `accent` is a subtle HOVER SURFACE, not a brand hue → `--panel-2`
        //   · shadcn `muted` is a SURFACE → `--panel-2`
        //   · Aviary `--muted` is dim TEXT → `muted-foreground`
        // The Aviary brand hue gets its own name (`brand`, below) so the two can never be confused.
        background: token('--bg'),
        foreground: token('--text'),
        card: { DEFAULT: token('--panel'), foreground: token('--text') },
        popover: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        primary: { DEFAULT: token('--accent'), foreground: token('--bg') },
        secondary: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        muted: { DEFAULT: token('--panel-2'), foreground: token('--muted') },
        accent: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        destructive: { DEFAULT: token('--bad'), foreground: token('--bg') },
        border: token('--line'),
        input: token('--line'),
        ring: token('--accent'),

        // ── Aviary's own names, for this console's hand-written classes.
        brand: token('--accent'),
        panel: token('--panel'),
        'panel-2': token('--panel-2'),
        line: token('--line'),
        'line-soft': token('--line-soft'),
        good: token('--good'),
        warn: token('--warn'),
        bad: token('--bad'),
        live: token('--live'),
      },
    },
  },
  plugins: [],
} satisfies Config;
