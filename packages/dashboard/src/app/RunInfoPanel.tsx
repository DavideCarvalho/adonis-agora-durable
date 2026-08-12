import type { WorkflowRun } from '../client/durable-client';
import { Json } from './StepDetailPanel';
import { XIcon } from './icons';

/** Slide-over for the run as a whole — its input, output and (when failed) error. */
export function RunInfoPanel({ run, onClose }: { run: WorkflowRun; onClose: () => void }) {
  const hasNothing = run.input === undefined && run.output === undefined && !run.error;
  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[380px] max-w-[90%] flex-col border-l border-line bg-panel/95 shadow-2xl backdrop-blur-md rise">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-zinc-50">
            {run.workflow}
          </h3>
          <div className={`mono mt-1 text-[11px] uppercase tracking-wider s-${run.status}`}>
            run · {run.status}
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
        {run.error && (
          <section className="rise">
            <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.18em] text-red-400/80">
              error
            </div>
            <div className="mono rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-[11.5px] leading-relaxed text-red-200">
              {run.error.message}
            </div>
          </section>
        )}
        {run.input !== undefined && <Json label="input" value={run.input} />}
        {run.output !== undefined && <Json label="output" value={run.output} />}
        {hasNothing && <div className="text-sm text-zinc-600">No input/output recorded.</div>}
      </div>
    </aside>
  );
}
