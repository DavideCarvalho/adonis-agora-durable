import { type ConsoleCapabilityTable, consoleCapabilityAllows } from './console_capabilities';

/**
 * What the signed-in viewer may do, as the server's `/apps` says when the console's `authorize`
 * narrows it (`capabilities`). Checked with the same canonical matcher the server uses
 * (`console_capabilities.ts`, identical across the Agora libs apart from its `LIB`).
 */

/** Durable's console capabilities, each a read or a write (as the server's table). */
const DURABLE_CONSOLE_CAPABILITY_TABLE: ConsoleCapabilityTable = {
  'durable:read': 'read',
  'durable:runs:write': 'write',
  'durable:tasks:write': 'write',
  'durable:schedules:write': 'write',
};

/** Whether `capabilities` allow `required` (`durable:runs:write`, …), aliases included. */
export function viewerAllows(capabilities: readonly string[], required: string): boolean {
  return consoleCapabilityAllows(capabilities, required, DURABLE_CONSOLE_CAPABILITY_TABLE);
}

/** Why the viewer cannot do `required`, or undefined when it can (or the server did not narrow). */
export function viewerLacksReason(
  capabilities: readonly string[] | undefined,
  required: string,
): string | undefined {
  if (!Array.isArray(capabilities) || viewerAllows(capabilities, required)) return undefined;
  return `Your access does not include this action (it needs ${required}).`;
}
