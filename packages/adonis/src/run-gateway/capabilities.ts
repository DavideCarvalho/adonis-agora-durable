/**
 * Whether a token holding `granted` may do `required`. Mirrors the Agora-wide capability rule
 * (`capabilityAllows` in `@adonis-agora/crypto-core`, without its crypto-only key-name prefix glob).
 *
 * Capabilities are compared segment by segment on `:`. A granted `*` segment matches exactly one
 * segment, and a granted capability whose last segment is `*` also matches every remaining segment
 * (zero or more). So `*` matches everything, `tenancy:*` matches `tenancy:acme` (and `tenancy`), and
 * `durable:*:read` matches `durable:runs:read`. Nothing is implied otherwise: `tenancy:acme` does not
 * allow `tenancy:globex`. Empty and non-string grants are ignored.
 */
export function capabilityAllows(granted: readonly string[], required: string): boolean {
  const want = required.split(':');
  for (const capability of granted) {
    if (typeof capability !== 'string' || capability === '') continue;
    const have = capability.split(':');
    let matched = true;
    for (let index = 0; index < have.length; index += 1) {
      const segment = have[index];
      if (segment === '*') continue;
      if (index >= want.length || segment !== want[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // A trailing `*` covers the rest; otherwise the shapes must have the same length.
    if (have.length === want.length || have[have.length - 1] === '*') return true;
  }
  return false;
}
