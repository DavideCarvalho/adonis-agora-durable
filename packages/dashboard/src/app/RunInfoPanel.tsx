import type { WorkflowRun } from '../client/durable-client';
import { XIcon } from './icons';
import { FieldMarks, type FieldProtection } from './ProtectionBadges';
import { ErrorBlock, Json } from './StepDetailPanel';

/** Slide-over for the run as a whole — its input, output and (when failed) error. `encrypted`
 *  names the run fields the store encrypts at rest (the run detail's `encryptedAtRest.run`). */
export function RunInfoPanel({
  run,
  onClose,
  encrypted,
}: {
  run: WorkflowRun;
  onClose: () => void;
  encrypted?: readonly string[] | undefined;
}) {
  const marks: FieldProtection = { encrypted, redacted: run.redactedFields };
  const hasNothing = run.input === undefined && run.output === undefined && !run.error;
  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[380px] max-w-[90%] flex-col border-l border-line bg-panel/95 shadow-2xl backdrop-blur-md rise">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-fg">
            {run.workflow}
          </h3>
          <div className={`mono mt-1 text-[11px] uppercase tracking-wider s-${run.status}`}>
            run · {run.status}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line text-dim transition-colors hover:text-fg"
          aria-label="Close"
        >
          <XIcon />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
        {run.error && (
          <ErrorBlock error={run.error} marks={<FieldMarks field="error" marks={marks} />} />
        )}
        {run.input !== undefined && (
          <Json
            label="input"
            value={run.input}
            marks={<FieldMarks field="input" marks={marks} />}
          />
        )}
        {run.output !== undefined && (
          <Json
            label="output"
            value={run.output}
            marks={<FieldMarks field="output" marks={marks} />}
          />
        )}
        {hasNothing && <div className="text-sm text-faint">No input/output recorded.</div>}
      </div>
    </aside>
  );
}
