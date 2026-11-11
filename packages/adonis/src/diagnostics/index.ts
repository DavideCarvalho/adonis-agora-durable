/**
 * `@adonis-agora/durable/diagnostics`: the module `transports.durable()` of
 * `@adonis-agora/diagnostics` loads at boot. It runs every diagnostics listener call as a durable
 * run. Durable only imports types from diagnostics, so this module never loads it.
 */
import type { DurableDiagnosticsModule } from '@adonis-agora/diagnostics/delivery';
import { createDeliveryTransport, isConfigured } from './transport.js';

export {
  createDeliveryTransport,
  DIAGNOSTICS_DEFAULT_RETRY,
  DIAGNOSTICS_LISTENER_ORIGIN,
  DIAGNOSTICS_LISTENER_WORKFLOW,
  DIAGNOSTICS_RUN_PREFIX,
  type DiagnosticsListenerInput,
  DurableDeliveryTransport,
  diagnosticsRunId,
  diagnosticsRunTags,
  isConfigured,
} from './transport.js';

/** The module as one object. Typing it checks this module is what `transports.durable()` expects. */
const durableDiagnostics: DurableDiagnosticsModule = { isConfigured, createDeliveryTransport };
export default durableDiagnostics;
