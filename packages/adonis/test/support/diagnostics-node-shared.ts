/** Shared by the two-process diagnostics spec and its child (`diagnostics-node.ts`). */

/** The table the child's listener records each call in. */
export const CALLS_TABLE = 'diag_listener_calls';

/** How the spec configures one child process (the `DIAG_NODE` env var, as JSON). */
export interface NodeConfig {
  role: 'web' | 'worker';
  name: string;
  pgUrl: string;
  schema: string;
  redisUrl: string;
  prefix: string;
}
