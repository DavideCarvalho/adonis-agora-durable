/**
 * The default pool's namespace. A run with no namespace, `null` or `''` belongs to it: the stores
 * write it as `'default'`, read every one of those back as `'default'`, and a `'default'` filter
 * matches all of them — the same rule the transports apply when they treat `''` as bare.
 */
export const DEFAULT_NAMESPACE = 'default';

/** `undefined`, `null` and `''` → `'default'`; any other namespace unchanged. */
export function normalizeNamespace(namespace: string | null | undefined): string {
  return namespace == null || namespace === '' ? DEFAULT_NAMESPACE : namespace;
}

/**
 * The stored values a filter on `namespace` must match: the default pool also matches the legacy
 * `''` rows an older build could write (a store column default covers `NULL`). Any other namespace
 * matches only itself.
 */
export function namespaceFilterValues(namespace: string): string[] {
  const normalized = normalizeNamespace(namespace);
  return normalized === DEFAULT_NAMESPACE ? [DEFAULT_NAMESPACE, ''] : [normalized];
}

/** Whether a stored run namespace belongs to the (normalized) `namespace` filter. */
export function namespaceMatches(stored: string | null | undefined, namespace: string): boolean {
  return normalizeNamespace(stored) === normalizeNamespace(namespace);
}
