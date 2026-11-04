import { useQuery } from '@tanstack/react-query';
import {
  durableClient,
  type LifecycleSubscriptionLink,
  type WorkflowLifecycleLinks,
  type WorkflowLifecyclePage,
} from '../client/durable-client';
import { Badge as Chip } from './ui/badge';

/** The console URL hash of a workflow's page (`#/workflow/<name>`). */
export function workflowHash(workflow: string): string {
  return `#/workflow/${encodeURIComponent(workflow)}`;
}

/** The workflow whose page the URL hash names, or undefined on any other hash. */
export function workflowFromHash(hash: string): string | undefined {
  const match = hash.match(/^#\/workflow\/(.+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** What one subscription does beyond starting the run: the chips drawn after its workflow. */
export function subscriptionTraits(link: LifecycleSubscriptionLink): string[] {
  const traits: string[] = [];
  if (link.where) traits.push('where');
  if (link.input) traits.push('input');
  if (link.coalesce) {
    traits.push(link.coalesce.keyed ? `${link.coalesce.mode} by key` : link.coalesce.mode);
  }
  if (!link.local) traits.push('announced');
  return traits;
}

/** Per-subscriber trigger counts, as `GET /workflows/:name/lifecycle` reports them. */
type TriggerCounts = NonNullable<WorkflowLifecyclePage['triggerCounts']>;

/** A subscriber's counts as one line: `12 started · 1 failed`, or undefined without counts. */
export function triggerCountLabel(
  counts: TriggerCounts | undefined,
  subscriber: string,
): string | undefined {
  const c = counts?.[subscriber];
  if (!c) return undefined;
  return c.failed > 0 ? `${c.triggered} started · ${c.failed} failed` : `${c.triggered} started`;
}

function LinkList({
  title,
  empty,
  links,
  counts,
}: {
  title: string;
  empty: string;
  links: LifecycleSubscriptionLink[];
  counts?: TriggerCounts | undefined;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500">{title}</h3>
      {links.length === 0 ? (
        <p className="mt-1 text-[11px] text-zinc-600">{empty}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {links.map((link) => (
            <li
              key={`${link.workflow}:${link.kind}`}
              className="flex flex-wrap items-center gap-1.5"
            >
              <a
                href={workflowHash(link.workflow)}
                className="mono text-[12px] text-zinc-200 underline-offset-2 hover:underline"
              >
                {link.workflow}
              </a>
              <Chip className={link.kind === 'failed' ? 's-failed' : 's-completed'}>
                on {link.kind}
              </Chip>
              {subscriptionTraits(link).map((trait) => (
                <Chip key={trait}>{trait}</Chip>
              ))}
              {triggerCountLabel(counts, link.workflow) && (
                <span
                  className={`mono text-[10px] ${counts?.[link.workflow]?.failed ? 'text-bad' : 'text-zinc-500'}`}
                  title="Counted by this dashboard's server process since it started"
                >
                  {triggerCountLabel(counts, link.workflow)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The two lists of a workflow's lifecycle links: who starts when it settles, and who starts it. */
export function WorkflowLifecycleLists({
  links,
  counts,
}: {
  links: WorkflowLifecycleLinks;
  /** Per-subscriber trigger counts shown on the "Starts when it settles" entries. */
  counts?: TriggerCounts | undefined;
}) {
  return (
    <div className="grid grid-cols-2 gap-6">
      <LinkList
        title="Starts when it settles"
        empty="No workflow starts when it settles."
        links={links.startsOnSettle}
        counts={counts}
      />
      <LinkList
        title="Started by"
        empty="No workflow's settling starts it."
        links={links.startedBy}
      />
    </div>
  );
}

/** A workflow's page: the workflows its settling starts and the workflows whose settling starts it. */
export function WorkflowPage({ workflow }: { workflow: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: ['workflow-lifecycle', workflow],
    queryFn: () => durableClient.workflowLifecycle(workflow),
    refetchInterval: 10_000,
  });
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-7 py-5">
        <h2 className="text-lg font-semibold tracking-tight">{workflow}</h2>
        <p className="mt-1 text-[11px] text-zinc-500">
          Lifecycle events: registered here and announced by live workers.
        </p>
      </div>
      <div className="px-7 py-5">
        {error ? (
          <p className="text-[11px] text-bad">
            {error instanceof Error ? error.message : String(error)}
          </p>
        ) : isPending || !data ? (
          <p className="text-[11px] text-zinc-600">Loading…</p>
        ) : (
          <WorkflowLifecycleLists links={data} counts={data.triggerCounts} />
        )}
      </div>
    </div>
  );
}
