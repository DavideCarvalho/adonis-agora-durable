import { type VariantProps, cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * The console's button, as one variant table instead of ~15 hand-tuned class strings.
 *
 * The tinted-outline idiom (a translucent fill, a translucent border, a bright label) was already
 * the house style for every action here — this just names each tint after what it MEANS, so a new
 * button picks a meaning rather than re-deriving a colour. `brand` is the only one wired to the
 * Aviary `--accent` token; the rest are the console's own semantic hues.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
  {
    variants: {
      variant: {
        /** Neutral bordered action — the default (Cancel, run I/O). */
        outline: 'border-line text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100',
        /** Borderless, for close/clear affordances. */
        ghost: 'border-transparent text-zinc-500 hover:text-zinc-200',
        /** Bordered icon well (panel close buttons). */
        quiet: 'border-line text-zinc-500 hover:text-zinc-200',
        /** The console accent — the primary recovery action (Retry). */
        brand: 'border-brand/30 bg-brand/10 text-brand hover:bg-brand/20',
        /** Needs-attention amber — `--warn` (Continue at a breakpoint, Cancel + Undo). */
        warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
        /** Operational, non-destructive (Re-dispatch). */
        info: 'border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20',
        /** Branches off into a new run (Fix & replay, parent/original links). */
        alt: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20',
        /** Destructive bulk action (cancel all). */
        danger: 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20',
        /** A selectable chip in a row of chips (status filter, pod chips). */
        chip: 'border-line bg-zinc-800/40 text-zinc-400 hover:border-zinc-500',
      },
      size: {
        /** Header actions. */
        sm: 'px-3 py-1.5 text-xs uppercase tracking-wide',
        /** Dense inline chips and mono micro-actions. */
        xs: 'px-1.5 py-0.5 text-[10px]',
        /** Filter chips / list-level actions. */
        chip: 'px-2.5 py-1 text-xs',
        /** Square icon well. */
        icon: 'h-7 w-7 shrink-0 p-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/**
 * A plain `<button>`. Composition goes the other way round with Base UI: a part renders THIS
 * (`<Dialog.Close render={<Button …/>} />`), merging its props in, so there is no `asChild` here.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      // Never submit a form by accident — every button in this console is an action.
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
