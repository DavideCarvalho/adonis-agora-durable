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
  { key: 'completed', className: 'bg-good/60', text: 'text-good', label: 'done' },
  { key: 'failed', className: 'bg-bad/70', text: 'text-bad', label: 'failed' },
  { key: 'running', className: 'bg-live/70', text: 'text-live', label: 'running' },
  { key: 'pending', className: 'bg-dim/60', text: 'text-fg-2', label: 'pending' },
  {
    key: 'interrupted',
    className: 'bg-warn/60',
    text: 'text-warn',
    label: 'interrupted',
  },
  { key: 'notStarted', className: 'bg-line-strong/70', text: 'text-fg-2', label: 'not started' },
  { key: 'skipped', className: 'bg-line-strong/40', text: 'text-dim', label: 'never ran' },
];
