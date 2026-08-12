import { type VariantProps, cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * A non-interactive label chip: tags, the tenant/partition, `dlq`, search attributes, the workflow
 * version. The `status` variant is colourless on purpose — a run/step badge takes its hue from the
 * `s-<status>` class in `index.css`, which is the single place run status colour is defined.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded border px-1.5 text-[10px] leading-relaxed',
  {
    variants: {
      variant: {
        outline: 'border-line bg-zinc-800/40 text-zinc-400',
        /** Tenant / worker-pool partition. */
        tenant: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
        /** The package that declared the run's workflow (`WorkflowRun.origin`) — a CODE-provenance
         *  axis, so it gets its own hue rather than sharing the tenant's sky. */
        origin: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
        /** An UNKNOWN origin. Deliberately drawn as absence (dim, no hue) instead of borrowing the
         *  `origin` teal — a run nobody could attribute must not look like an attributed one. */
        'origin-unknown': 'border-line bg-zinc-800/40 italic text-zinc-500',
        /** Typed search attribute. */
        attr: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
        /** Dead-letter marker. */
        danger: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
        /** Saga compensation marker. */
        warn: 'border-warn/40 bg-warn/10 text-warn',
        /** Run/step status — colour comes from the caller's `s-<status>` class. */
        status: 'border-transparent px-0 uppercase tracking-wider',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';
