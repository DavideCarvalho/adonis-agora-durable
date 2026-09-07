import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DurableActionError,
  durableClient,
  type WaitTarget,
  waitingOnTokens,
} from '../client/durable-client';
import { BoltIcon, CheckIcon, XIcon } from './icons';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { InputField } from './ui/input';

/**
 * The human-in-the-loop action strip for a run suspended on an external rendezvous: the run detail
 * already NAMES what the run is parked on (the awaiting badge/detail line) — this panel lets the
 * operator ANSWER it, per wait shape (see `waiting-actions.ts` for how a token classifies):
 *
 *  - a plain signal wait → **Deliver signal** (`POST /runs/:id/signal`), token pre-filled and
 *    editable, JSON payload optional. A 409 ("run is not waiting on that token") surfaces the
 *    server's `waitingOn` list as clickable token chips instead of a dead-end error.
 *  - an update wait (`update:<runId>:<name>`) → **Send update** (`POST /runs/:id/update/:name`);
 *    a 422 shows the workflow validator's reason inline, nothing delivered.
 *  - a task wait (`task:<runId>:<name>`) → **Complete task** / **Fail task**
 *    (`POST /runs/:id/tasks/:name/complete|fail`).
 *
 * All three verbs 404 on a tenant topology (the gateway has no signal surface) — gated exactly like
 * fix-and-replay: buttons disable with the reason rather than offering an action that can only fail.
 *
 * Every JSON field parses BEFORE anything is sent (the draft survives a parse error, same as the
 * fix-and-replay dialog), and an EMPTY field sends `undefined`, not `""` or `null` — delivering
 * nothing is a legal signal payload.
 */

type OpenAction =
  | { verb: 'signal'; token: string }
  | { verb: 'update'; name: string }
  | { verb: 'task-complete'; name: string }
  | { verb: 'task-fail'; name: string };

/** Parse a JSON draft where EMPTY means `undefined` (deliver nothing). Throws on malformed JSON. */
function parseOptionalJson(draft: string): unknown {
  const trimmed = draft.trim();
  if (trimmed === '') return undefined;
  return JSON.parse(trimmed);
}

const TENANT_REASON =
  'Not available on a tenant deployment — delivering signals/updates/tasks needs the control plane.';

function JsonField({
  id,
  label,
  hint,
  draft,
  onDraft,
}: {
  id: string;
  label: string;
  hint: string;
  draft: string;
  onDraft: (next: string) => void;
}) {
  return (
    <>
      <label
        className="mono mb-1.5 mt-3 block text-[10px] uppercase tracking-[0.18em] text-zinc-500"
        htmlFor={id}
      >
        {label}
      </label>
      <textarea
        id={id}
        value={draft}
        spellCheck={false}
        placeholder={hint}
        onChange={(e) => onDraft(e.target.value)}
        className="mono h-40 w-full resize-y rounded-lg border border-line bg-black/40 p-3 text-[11.5px] leading-relaxed text-zinc-300 placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
      />
    </>
  );
}

export function WaitingActions({
  runId,
  targets,
  tenantPod,
  onDelivered,
}: {
  runId: string;
  targets: WaitTarget[];
  tenantPod: boolean;
  /** Called after a successful delivery so the caller refreshes the run (+ list). */
  onDelivered: () => void;
}) {
  const [open, setOpen] = useState<OpenAction | undefined>(undefined);
  // One shared JSON draft + error per dialog session (only one dialog is open at a time).
  const [token, setToken] = useState('');
  const [draft, setDraft] = useState('');
  const [formError, setFormError] = useState<string | undefined>(undefined);
  // The 409's `waitingOn` — the tokens the run IS parked on, offered as choices after a stale/typo'd
  // token instead of a dead-end error.
  const [offeredTokens, setOfferedTokens] = useState<string[] | undefined>(undefined);

  const openDialog = (action: OpenAction) => {
    setToken(action.verb === 'signal' ? action.token : '');
    setDraft('');
    setFormError(undefined);
    setOfferedTokens(undefined);
    setOpen(action);
  };
  const close = () => setOpen(undefined);
  const settle = () => {
    close();
    onDelivered();
  };
  const surface = (error: unknown) => {
    setOfferedTokens(waitingOnTokens(error));
    setFormError(
      error instanceof DurableActionError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'request failed',
    );
  };

  const signal = useMutation({
    mutationFn: (input: { token: string; payload: unknown }) =>
      durableClient.signal(runId, input.token, input.payload),
    onSuccess: settle,
    onError: surface,
  });
  const update = useMutation({
    mutationFn: (input: { name: string; arg: unknown }) =>
      durableClient.update(runId, input.name, input.arg),
    onSuccess: settle,
    // The 422 IS the workflow validator speaking — its reason renders inline, draft kept.
    onError: surface,
  });
  const completeTask = useMutation({
    mutationFn: (input: { name: string; result: unknown }) =>
      durableClient.completeTask(runId, input.name, input.result),
    onSuccess: settle,
    onError: surface,
  });
  const failTask = useMutation({
    mutationFn: (input: { name: string; error: string }) =>
      durableClient.failTask(runId, input.name, input.error),
    onSuccess: settle,
    onError: surface,
  });
  const pending =
    signal.isPending || update.isPending || completeTask.isPending || failTask.isPending;

  if (targets.length === 0) return null;

  const submit = () => {
    if (!open) return;
    if (open.verb === 'task-fail') {
      // A failure reason is a plain string, not JSON.
      failTask.mutate({ name: open.name, error: draft.trim() || 'failed from console' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseOptionalJson(draft);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    if (open.verb === 'signal') {
      const chosen = token.trim();
      if (!chosen) {
        setFormError('token is required');
        return;
      }
      signal.mutate({ token: chosen, payload: parsed });
    } else if (open.verb === 'update') {
      update.mutate({ name: open.name, arg: parsed });
    } else {
      completeTask.mutate({ name: open.name, result: parsed });
    }
  };

  const dialogTitle =
    open?.verb === 'signal'
      ? 'Deliver signal'
      : open?.verb === 'update'
        ? 'Send update'
        : open?.verb === 'task-complete'
          ? 'Complete task'
          : 'Fail task';
  const dialogSubtitle =
    open?.verb === 'signal'
      ? `resumes ${runId} at its ctx.waitForSignal`
      : open?.verb === 'update'
        ? `delivers to ${runId}'s ctx.onUpdate("${open.name}") — the workflow's validator arbitrates`
        : open
          ? `settles ${runId}'s external task "${open.name}"`
          : '';

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-sky-500/30 bg-sky-500/10 px-7 py-3">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-sky-500/40 bg-sky-500/15 text-sm text-sky-300"
          aria-hidden
        >
          ✋
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-sky-200">Waiting on a human</div>
          <div className="mono truncate text-[11px] text-sky-300/70">
            this run is suspended until someone answers the wait{targets.length === 1 ? '' : 's'}{' '}
            below
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {targets.map((target) =>
            target.kind === 'task' ? (
              <span key={target.token} className="flex items-center gap-1.5">
                <span className="mono max-w-[180px] truncate text-[10px] text-sky-300/80">
                  task {target.name}
                </span>
                <Button
                  variant="brand"
                  size="xs"
                  disabled={tenantPod || pending}
                  title={tenantPod ? TENANT_REASON : `Complete task "${target.name}" with a result`}
                  onClick={() => openDialog({ verb: 'task-complete', name: target.name })}
                  className="mono uppercase tracking-wider"
                >
                  <CheckIcon width={10} height={10} />
                  Complete task
                </Button>
                <Button
                  variant="danger"
                  size="xs"
                  disabled={tenantPod || pending}
                  title={tenantPod ? TENANT_REASON : `Fail task "${target.name}" with a reason`}
                  onClick={() => openDialog({ verb: 'task-fail', name: target.name })}
                  className="mono uppercase tracking-wider"
                >
                  <XIcon width={10} height={10} />
                  Fail task
                </Button>
              </span>
            ) : target.kind === 'update' ? (
              <span key={target.token} className="flex items-center gap-1.5">
                <span className="mono max-w-[180px] truncate text-[10px] text-sky-300/80">
                  update {target.name}
                </span>
                <Button
                  variant="info"
                  size="xs"
                  disabled={tenantPod || pending}
                  title={tenantPod ? TENANT_REASON : `Send a validated update to "${target.name}"`}
                  onClick={() => openDialog({ verb: 'update', name: target.name })}
                  className="mono uppercase tracking-wider"
                >
                  <BoltIcon width={10} height={10} />
                  Send update
                </Button>
              </span>
            ) : (
              <span key={target.token} className="flex items-center gap-1.5">
                <span className="mono max-w-[180px] truncate text-[10px] text-sky-300/80">
                  signal {target.token}
                </span>
                <Button
                  variant="info"
                  size="xs"
                  disabled={tenantPod || pending}
                  title={tenantPod ? TENANT_REASON : `Deliver a payload on "${target.token}"`}
                  onClick={() => openDialog({ verb: 'signal', token: target.token })}
                  className="mono uppercase tracking-wider"
                >
                  <BoltIcon width={10} height={10} />
                  Deliver signal
                </Button>
              </span>
            ),
          )}
        </div>
      </div>
      <Dialog
        open={open !== undefined}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={dialogTitle}
        subtitle={dialogSubtitle}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant={open?.verb === 'task-fail' ? 'danger' : 'info'}
              disabled={pending}
              onClick={submit}
            >
              {dialogTitle}
            </Button>
          </>
        }
      >
        {open?.verb === 'signal' && (
          <>
            <label
              className="mono mb-1.5 block text-[10px] uppercase tracking-[0.18em] text-zinc-500"
              htmlFor="deliver-signal-token"
            >
              token
            </label>
            <InputField
              id="deliver-signal-token"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setFormError(undefined);
              }}
              onClear={() => setToken('')}
              clearLabel="clear token"
              placeholder="signal token…"
              aria-label="signal token"
            />
            <JsonField
              id="deliver-signal-payload"
              label="payload (json, optional)"
              hint="empty delivers no payload"
              draft={draft}
              onDraft={(next) => {
                setDraft(next);
                setFormError(undefined);
              }}
            />
          </>
        )}
        {open?.verb === 'update' && (
          <JsonField
            id="send-update-arg"
            label="argument (json, optional)"
            hint="empty sends no argument"
            draft={draft}
            onDraft={(next) => {
              setDraft(next);
              setFormError(undefined);
            }}
          />
        )}
        {open?.verb === 'task-complete' && (
          <JsonField
            id="complete-task-result"
            label="result (json, optional)"
            hint="empty completes with no result"
            draft={draft}
            onDraft={(next) => {
              setDraft(next);
              setFormError(undefined);
            }}
          />
        )}
        {open?.verb === 'task-fail' && (
          <>
            <label
              className="mono mb-1.5 block text-[10px] uppercase tracking-[0.18em] text-zinc-500"
              htmlFor="fail-task-reason"
            >
              reason
            </label>
            <InputField
              id="fail-task-reason"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setFormError(undefined);
              }}
              onClear={() => setDraft('')}
              clearLabel="clear reason"
              placeholder="failed from console"
              aria-label="failure reason"
            />
          </>
        )}
        {formError && (
          <p className="mono mt-2 rounded border border-bad/25 bg-bad/10 px-2 py-1 text-[11px] text-bad">
            {formError}
          </p>
        )}
        {offeredTokens && offeredTokens.length > 0 && (
          <div className="mt-2">
            <div className="mono mb-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
              waiting on — pick one
            </div>
            <div className="flex flex-wrap gap-1">
              {offeredTokens.map((offered) => (
                <Button
                  key={offered}
                  variant="chip"
                  size="xs"
                  className="mono"
                  onClick={() => {
                    setToken(offered);
                    setFormError(undefined);
                    setOfferedTokens(undefined);
                  }}
                >
                  {offered}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
