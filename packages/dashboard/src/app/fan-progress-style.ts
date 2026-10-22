import type { FanProgress } from '../client/group-parallel-spans';

/**
 * A summarized fan's progress bar segments and legend, in bar order. The class names live under
 * `app/` because Tailwind only scans this folder for the classes it generates.
 */
export const FAN_PROGRESS_SEGMENTS: readonly {
  key: keyof Omit<FanProgress, 'started' | 'total'>;
  className: string;
  text: string;
  label: string;
}[] = [
  { key: 'completed', className: 'bg-emerald-500/60', text: 'text-emerald-300', label: 'done' },
  { key: 'failed', className: 'bg-red-500/70', text: 'text-red-300', label: 'failed' },
  { key: 'running', className: 'bg-live/70', text: 'text-live', label: 'running' },
  { key: 'pending', className: 'bg-zinc-500/60', text: 'text-zinc-300', label: 'pending' },
  {
    key: 'interrupted',
    className: 'bg-amber-500/60',
    text: 'text-amber-300',
    label: 'interrupted',
  },
  { key: 'notStarted', className: 'bg-zinc-700/70', text: 'text-zinc-400', label: 'not started' },
  { key: 'skipped', className: 'bg-zinc-700/40', text: 'text-zinc-500', label: 'never ran' },
];
