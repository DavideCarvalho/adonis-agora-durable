import type { SVGProps } from 'react';

/** Crisp 1.6px-stroke line icons — no icon-font dependency, tuned for the control-plane aesthetic. */
const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function CpuIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2" />
    </svg>
  );
}
export function GlobeIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
export function TimerIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <circle cx="12" cy="13" r="8" />
      <path d="M12 13V9M9 2h6" />
    </svg>
  );
}
export function RadioIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M5 5a10 10 0 0 0 0 14M19 19a10 10 0 0 0 0-14" />
    </svg>
  );
}
export function CheckIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}
export function XIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
export function CopyIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}
export function RetryIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" />
    </svg>
  );
}
export function BoltIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
export function PlayIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M6 4l14 8-14 8z" />
    </svg>
  );
}

/** A child-workflow glyph (a branch forking off to a sub-run). */
export function ChildIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <path d="M6 7v6a4 4 0 004 4h4" />
      <circle cx="18" cy="17" r="2" />
    </svg>
  );
}

const KIND_ICON: Record<string, (p: SVGProps<SVGSVGElement>) => JSX.Element> = {
  local: CpuIcon,
  remote: GlobeIcon,
  sleep: TimerIcon,
  signal: RadioIcon,
  child: ChildIcon,
};

/** The icon for a step kind, always defined (unknown kinds fall back to the local/cpu glyph). */
export function iconFor(kind: string): (p: SVGProps<SVGSVGElement>) => JSX.Element {
  return KIND_ICON[kind] ?? CpuIcon;
}

export const KIND_LABEL: Record<string, string> = {
  local: 'In-process step',
  remote: 'Remote worker step',
  sleep: 'Durable timer',
  signal: 'External signal',
  child: 'Child workflow — click to open its run',
};
