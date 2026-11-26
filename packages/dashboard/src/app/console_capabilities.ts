/**
 * The one matcher for console capabilities (SECURITY-UNIFORM-SPEC §10.16b). Every console-capability
 * check of an `@adonis-agora` lib goes through it: the console's token, the viewer's capabilities,
 * the narrowing of what the console sends, the gating of the console's own app, the UI.
 *
 * This file is copied, not shared through a package, and kept byte-identical across the libs apart
 * from {@link LIB}. The lib passes its own table of console capabilities (which are reads, which are
 * writes) where it calls {@link consoleCapabilityAllows}.
 *
 * `granted` allows `required` when one of its entries is:
 *
 * - exactly `required`;
 * - a literal alias: `*`, `<lib>:*` or `<lib>:console:*` (for any `<lib>:` capability);
 * - `<lib>:console:write`, when `required` is a read or a write console capability (write implies
 *   read), or `<lib>:console:read`, when it is a read;
 * - a hierarchical grant under `<lib>:` whose ONLY `*` is its last segment, and whose other
 *   segments are `required`'s first ones (`<lib>:secrets:*` allows `<lib>:secrets:read`).
 *
 * Any other `*` grants nothing: in the middle (`<lib>:*:read`), inside a segment
 * (`<lib>:console:w*`, `<lib>:c*`), or in another namespace (`*:console:*`, `other:console:*`).
 * A capability neither listed as a read nor as a write (a sensitive one) is only allowed by an
 * exact grant, a literal alias, or a hierarchical grant.
 *
 * Not for data-operation grammars with key patterns (crypto's `crypto:decrypt:<key-pattern>`):
 * those keep their own matcher.
 */

/** The only line that differs between the libs' copies. */
const LIB = 'durable';

/** Whether a console capability reads or writes. */
export type ConsoleCapabilityKind = 'read' | 'write';

/** A lib's console capabilities, each a read or a write (`{ 'config:read': 'read', … }`). */
export type ConsoleCapabilityTable = Readonly<Record<string, ConsoleCapabilityKind>>;

/** The alias that covers every read console capability of this lib. */
export const CONSOLE_READ = `${LIB}:console:read`;
/** The alias that covers every read and write console capability of this lib. */
export const CONSOLE_WRITE = `${LIB}:console:write`;
/** The alias that covers every capability of this lib. */
export const CONSOLE_ALL = `${LIB}:console:*`;

/**
 * Whether `capability` reads or writes, by the lib's `table`. The two aliases classify themselves
 * (`<lib>:console:read` is a read, `<lib>:console:write` a write); anything else unlisted is
 * `undefined` (sensitive: no read/write alias covers it).
 */
export function consoleCapabilityKind(
  capability: string,
  table: ConsoleCapabilityTable = {},
): ConsoleCapabilityKind | undefined {
  if (capability === CONSOLE_READ) return 'read';
  if (capability === CONSOLE_WRITE) return 'write';
  return Object.hasOwn(table, capability) ? table[capability] : undefined;
}

/** A hierarchical grant: under `<lib>:`, its only `*` the last segment, its prefix `required`'s. */
function hierarchical(grant: string, required: string): boolean {
  const have = grant.split(':');
  if (have.length < 3 || have[0] !== LIB || have[have.length - 1] !== '*') return false;
  const prefix = have.slice(0, -1);
  if (prefix.some((segment) => segment === '' || segment.includes('*'))) return false;
  const want = required.split(':');
  if (want.length < prefix.length) return false;
  return prefix.every((segment, index) => segment === want[index]);
}

/** Whether one granted capability allows `required` (see the file's comment for the rules). */
function grants(grant: string, required: string, table: ConsoleCapabilityTable): boolean {
  if (grant === required) return true;
  const ours = required.startsWith(`${LIB}:`);
  if (grant === '*') return true;
  if (grant === `${LIB}:*` || grant === CONSOLE_ALL) return ours;
  const kind = consoleCapabilityKind(required, table);
  if (grant === CONSOLE_WRITE) return kind === 'read' || kind === 'write';
  if (grant === CONSOLE_READ) return kind === 'read';
  return ours && hierarchical(grant, required);
}

/**
 * Whether `granted` (a token's or a viewer's capabilities) allows `required`, by the rules above.
 * Non-string and empty entries grant nothing; a malformed `granted` (not an array) allows nothing.
 */
export function consoleCapabilityAllows(
  granted: readonly unknown[] | undefined,
  required: string,
  table: ConsoleCapabilityTable = {},
): boolean {
  if (!Array.isArray(granted) || typeof required !== 'string' || required === '') return false;
  return granted.some(
    (grant) => typeof grant === 'string' && grant !== '' && grants(grant, required, table),
  );
}
