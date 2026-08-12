import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { durableClient } from '../client/durable-client';
import type { StepCheckpoint, StepEvent, WorkflowRun } from '../client/durable-client';
import { type SubProcess, groupSubProcesses } from '../client/group-subprocesses';
import { RunSpans } from './SpansTimeline';
import { childRunIdOf } from './child-link';
import { BoltIcon, CheckIcon, CopyIcon, KIND_LABEL, XIcon, iconFor } from './icons';

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

function fmtDur(a: string, b: string): string {
  return fmtMs(new Date(b).getTime() - new Date(a).getTime());
}

function clock(iso: string): string {
  return clockMs(new Date(iso).getTime());
}

function clockMs(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

const SUB_TONE: Record<NonNullable<StepEvent['status']>, string> = {
  ok: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/25 bg-red-500/10 text-red-300',
  skipped: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
};

const LEVEL_TONE: Record<StepEvent['level'], string> = {
  debug: 'text-zinc-500',
  info: 'text-zinc-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

const SUB_ORDER: Array<NonNullable<StepEvent['status']>> = ['ok', 'failed', 'skipped'];

function LogLine({ e }: { e: StepEvent }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="shrink-0 text-zinc-600 tnum">{clockMs(e.at)}</span>
      <span className={`shrink-0 uppercase ${LEVEL_TONE[e.level]}`}>{e.level}</span>
      <span className="min-w-0 break-words text-zinc-300">{e.message}</span>
    </div>
  );
}

/** One sub-process: a clickable row (name · duration · status) that expands to its phase timeline,
 *  error, and owned log lines. Mirrors flip's per-process expand in `pipeline-runs`. */
function SubProcessRow({ sub, showGroup = true }: { sub: SubProcess; showGroup?: boolean }) {
  const hasMessage = sub.terminal?.message !== undefined && sub.terminal.message !== sub.name;
  const expandable = sub.phases.length > 0 || sub.logs.length > 0 || hasMessage;
  const [open, setOpen] = useState(sub.status === 'failed'); // surface failures without a click
  const tone = sub.status
    ? SUB_TONE[sub.status]
    : 'border-amber-500/25 bg-amber-500/10 text-amber-300';

  return (
    <li className={`rounded-md border ${tone}`}>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11.5px] disabled:cursor-default"
        aria-expanded={expandable ? open : undefined}
      >
        <span className="flex min-w-0 items-center gap-2">
          {expandable && (
            <span
              className={`text-[9px] text-zinc-500 transition-transform duration-150 ${open ? '' : '-rotate-90'}`}
            >
              ▼
            </span>
          )}
          <span className="mono truncate text-zinc-200">{sub.name}</span>
          {showGroup && sub.group && (
            <span className="mono shrink-0 text-[10px] uppercase tracking-wider text-zinc-500">
              {sub.group}
            </span>
          )}
        </span>
        <span className="mono flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wider">
          {sub.durationMs !== undefined && (
            <span className="tnum text-zinc-400">{fmtMs(sub.durationMs)}</span>
          )}
          <span>{sub.status ?? 'running'}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-line/60 px-2.5 py-2">
          {sub.phases.length > 0 && (
            <ul className="mono mb-2 flex flex-col gap-0.5 text-[10.5px]">
              {sub.phases.map((p, i) => (
                <li key={`${p.at}-${p.phase}-${i}`} className="flex gap-2">
                  <span className="shrink-0 text-zinc-600 tnum">{clockMs(p.at)}</span>
                  <span className="text-zinc-400">{p.phase}</span>
                  {sub.startedAt !== undefined && (
                    <span className="text-zinc-600 tnum">+{fmtMs(p.at - sub.startedAt)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {sub.terminal?.message && sub.terminal.message !== sub.name && (
            <div
              className={`mono mb-2 rounded border p-2 text-[11px] ${
                sub.status === 'failed'
                  ? 'border-red-500/25 bg-red-500/10 text-red-200'
                  : 'border-line bg-black/20 text-zinc-300'
              }`}
            >
              {sub.terminal.message}
            </div>
          )}
          {sub.logs.length > 0 && (
            <div className="mono flex flex-col gap-0.5 text-[11px]">
              {sub.logs.map((e, i) => (
                <LogLine key={`${e.at}-${i}`} e={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Sub-process outcomes + the step's log lines. Each sub-process is an expandable row showing its
 *  lifecycle (phases), duration, terminal status, error, and owned logs. */
function StepEvents({ events }: { events: StepEvent[] }) {
  const { subs, stepLogs } = groupSubProcesses(events);
  const counts = SUB_ORDER.map(
    (s) => [s, subs.filter((sub) => sub.status === s).length] as const,
  ).filter(([, n]) => n > 0);
  const grouped = subs.some((s) => s.group);

  return (
    <>
      {subs.length > 0 && (
        <section className="rise">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
              sub-processes · {subs.length}
            </span>
            <span className="mono flex gap-2 text-[10px] uppercase tracking-wider">
              {counts.map(([s, n]) => (
                <span key={s} className={SUB_TONE[s].split(' ').pop()}>
                  {n} {s}
                </span>
              ))}
            </span>
          </div>
          {grouped ? (
            Object.entries(
              subs.reduce<Record<string, SubProcess[]>>((acc, sub) => {
                const key = sub.group ?? '—';
                if (acc[key] === undefined) acc[key] = [];
                acc[key].push(sub);
                return acc;
              }, {}),
            )
              .sort(([a], [b]) => (a === '—' ? 1 : b === '—' ? -1 : a.localeCompare(b)))
              .map(([group, groupSubs]) => (
                <div key={group} className="mb-2">
                  <div className="mono mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    {group}
                  </div>
                  <ul className="flex flex-col gap-1">
                    {groupSubs.map((sub) => (
                      <SubProcessRow key={sub.id} sub={sub} showGroup={false} />
                    ))}
                  </ul>
                </div>
              ))
          ) : (
            <ul className="flex flex-col gap-1">
              {subs.map((sub) => (
                <SubProcessRow key={sub.id} sub={sub} />
              ))}
            </ul>
          )}
        </section>
      )}

      {stepLogs.length > 0 && (
        <section className="rise">
          <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
            logs · {stepLogs.length}
          </div>
          <div className="mono max-h-64 overflow-auto rounded-lg border border-line bg-black/40 p-2.5 text-[11px] leading-relaxed">
            {stepLogs.map((e, i) => (
              <LogLine key={`${e.at}-${i}`} e={e} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard may be blocked in insecure contexts — ignore */
        }
      }}
    >
      {done ? <CheckIcon width={11} height={11} /> : <CopyIcon width={11} height={11} />}
      {done ? 'copied' : 'copy'}
    </button>
  );
}

export function Json({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <section className="rise">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</span>
        <CopyButton value={text} />
      </div>
      <pre className="mono max-h-64 overflow-auto rounded-lg border border-line bg-black/40 p-3 text-[11.5px] leading-relaxed text-zinc-300">
        {text}
      </pre>
    </section>
  );
}

function Field({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="mono shrink-0 text-[10px] uppercase tracking-[0.16em] text-zinc-600">
        {k}
      </span>
      <span className={`truncate text-right text-[12px] text-zinc-200 ${mono ? 'mono tnum' : ''}`}>
        {v}
      </span>
    </div>
  );
}

/** The child run's span waterfall, fetched and rendered inline inside the step-detail panel — so a
 *  child-workflow step (click its node → this panel) drills into the child without leaving the run.
 *  A running child with no recorded step yet shows a placeholder rather than an empty box. */
function ChildRunInline({
  id,
  onOpenRun,
}: {
  id: string;
  onOpenRun?: ((id: string) => void) | undefined;
}) {
  const { data } = useQuery({ queryKey: ['run', id], queryFn: () => durableClient.run(id) });
  // Local expand state for grandchildren expanded within this nested waterfall.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (childId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(childId)) next.delete(childId);
      else next.add(childId);
      return next;
    });
  if (!data) {
    return <div className="mono px-2 py-2 text-[10px] text-zinc-600">loading child run…</div>;
  }
  if (data.timeline.length === 0) {
    return (
      <div className="mono px-2 py-2 text-[10px] text-zinc-600">
        no steps recorded yet — child {data.run.status}
      </div>
    );
  }
  return (
    <div className="mt-2 max-h-80 space-y-1 overflow-auto rounded-md border border-line bg-black/20 p-1.5">
      <RunSpans
        run={data.run}
        timeline={data.timeline}
        depth={0}
        onSelect={() => {}}
        onOpenRun={onOpenRun ?? (() => {})}
        expanded={expanded}
        onToggleChild={toggle}
      />
    </div>
  );
}

export function StepDetailPanel({
  step,
  run,
  onClose,
  onOpenRun,
}: {
  step: StepCheckpoint;
  run: WorkflowRun;
  onClose: () => void;
  /** Navigate to another run — enables the child-run "open ↗" link in the detail. */
  onOpenRun?: ((id: string) => void) | undefined;
}) {
  const childRunId = childRunIdOf(step);
  const [childOpen, setChildOpen] = useState(false);
  const failed = step.status === 'failed';
  // in-flight: a remote step awaiting its worker (`pending`) or a local step body executing (`running`)
  const pending = step.status === 'pending' || step.status === 'running';
  const Icon = iconFor(step.kind);
  const sinceStart = fmtDur(run.createdAt, step.startedAt);
  // Queue-wait: how long the step sat dispatched before a worker picked it up. Only meaningful for
  // a remote step (a local step has enqueuedAt === startedAt, so this is zero and stays hidden).
  const queueMs = step.enqueuedAt
    ? new Date(step.startedAt).getTime() - new Date(step.enqueuedAt).getTime()
    : 0;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-[90%] flex-col border-l border-line bg-panel/95 shadow-2xl backdrop-blur-md rise">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${
                failed
                  ? 'bg-red-500/15 text-red-300'
                  : pending
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-emerald-500/15 text-emerald-300'
              }`}
            >
              <Icon width={13} height={13} />
            </span>
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-zinc-50">
              {step.name}
            </h3>
          </div>
          <div className={`mono mt-1 text-[11px] uppercase tracking-wider s-${step.status}`}>
            {step.status} · {KIND_LABEL[step.kind] ?? step.kind}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line text-zinc-500 transition-colors hover:text-zinc-200"
          aria-label="Close"
        >
          <XIcon />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
        <div className="rounded-lg border border-line bg-black/20 px-3.5 py-1">
          <Field k="seq" v={`#${step.seq}`} />
          {queueMs >= 1 && (
            <Field k="queued" v={<span className="text-sky-300">{fmtMs(queueMs)}</span>} />
          )}
          <Field
            k="duration"
            v={
              pending ? (
                <span className="text-amber-300">running…</span>
              ) : (
                fmtDur(step.startedAt, step.finishedAt)
              )
            }
          />
          <Field
            k="attempts"
            v={
              <span className={step.attempts > 1 ? 'text-amber-300' : ''}>
                {step.attempts > 1 && <BoltIcon width={11} height={11} className="mr-1 inline" />}
                {step.attempts}
              </span>
            }
          />
          {step.workerGroup && <Field k="worker" v={`@${step.workerGroup}`} />}
          <Field k="started" v={clock(step.startedAt)} />
          {/* A pending step's finishedAt is just its last write — showing it as "finished" reads
              like the step ended while the duration says running. */}
          {!pending && <Field k="finished" v={clock(step.finishedAt)} />}
          <Field k="offset" v={`+${sinceStart}`} />
        </div>

        {failed && step.error && (
          <section className="rise">
            <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.18em] text-red-400/80">
              error
            </div>
            <div className="mono rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-[11.5px] leading-relaxed text-red-200">
              {step.error.message}
            </div>
          </section>
        )}

        {step.events && step.events.length > 0 && <StepEvents events={step.events} />}

        {childRunId && (
          <section className="rise">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                child run
              </span>
              {onOpenRun && (
                <button
                  type="button"
                  onClick={() => onOpenRun(childRunId)}
                  className="mono rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200"
                >
                  open ↗
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setChildOpen((v) => !v)}
              className="flex w-full items-center gap-2 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1.5 text-left transition-colors hover:bg-indigo-500/20"
              title={childOpen ? 'Collapse child run' : 'Expand child run inline'}
            >
              <span
                className="inline-block text-[9px] text-indigo-300 transition-transform"
                style={{ transform: childOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▸
              </span>
              <span className="mono truncate text-[11px] text-indigo-300">{childRunId}</span>
            </button>
            {childOpen && <ChildRunInline id={childRunId} onOpenRun={onOpenRun} />}
          </section>
        )}

        {step.input !== undefined && <Json label="input" value={step.input} />}
        {step.output !== undefined && <Json label="output" value={step.output} />}
      </div>
    </aside>
  );
}
