/**
 * Route-by-handler queue tokens are `<handler>@<partition>` (see core `tenantGroup`); the operator's
 * default partition carries no suffix. A handler/workflow name never contains `@`, so the last `@`
 * unambiguously separates the partition.
 */

/** The isolation partition a worker-queue token belongs to (`'default'` when it has no suffix). */
export function partitionOf(group: string): string {
  const at = group.lastIndexOf('@');
  return at === -1 ? 'default' : group.slice(at + 1);
}

/** The handler/workflow name with any `@<partition>` suffix stripped. */
export function baseHandlerName(group: string): string {
  const at = group.lastIndexOf('@');
  return at === -1 ? group : group.slice(0, at);
}
