/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '1.0.0-rc.14';

export type {
  AccessDeniedInfo,
  AccessDeniedPageOptions,
  AccessDeniedReason,
} from './access_denied_page.js';
// The built-in "access denied" page (what a browser sees on a refused page navigation).
export {
  CONSOLE as ACCESS_DENIED_CONSOLE,
  escapeHtml,
  renderAccessDeniedPage,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
export type { CompatSource, FleetGroup, FleetTransport } from './compat.js';
// Fleet health / protocol-compatibility panel (design §7.6, §10).
export { compat, enumerateLiveFleet, mergeFleets } from './compat.js';
export { formatProtocolRange, outcomeClass, outcomeLabel } from './compat-view.js';
export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeGate,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
  ConsoleDecision,
} from './console_authorize.js';
// The shared console `authorize` contract (function, class, lazy import).
export {
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleDecision,
  resolveConsoleAuthorize,
} from './console_authorize.js';
export type {
  AgoraConsoleEntry,
  AgoraConsoleIcon,
  AgoraConsoleRegistry,
  AgoraConsoleSearchHit,
  ConsoleSearchResults,
  VisibleConsole,
  VisibleConsoles,
} from './console_switcher.js';
// The cross-console switcher registry (`'agora.consoles'`) and global search.
export {
  AGORA_CONSOLES_BINDING,
  listVisibleConsoles,
  registerAgoraConsole,
  searchConsoles,
} from './console_switcher.js';
export type {
  AccessDeniedOption,
  AccessDeniedRenderer,
  AuthorizeDecision,
  AuthorizeHook,
  AuthorizeResult,
  DurableDashboardConfig,
  ResolveConfigOptions,
  ResolvedDurableDashboardConfig,
} from './define_config.js';
export {
  defineConfig,
  NO_AUTHORIZE_WARNING,
  normalizeAuthorizeResult,
  resolveConfig,
} from './define_config.js';
export type {
  DevTool,
  DevToolAuditEntry,
  DevToolCall,
  DevToolInputProperty,
  DevToolInputSchema,
  DevToolsCaller,
  DevToolsDecision,
  DevToolsHub,
  DevToolsLib,
  DurableDevToolsOptions,
} from './dev_tools.js';
// Developer tools for the app's dev MCP endpoint (`@adonis-agora/agent`), when it has one.
export { DEV_TOOLS_BINDING, durableDevTools, registerDurableDevTools } from './dev_tools.js';
export type { EngineEventSource, RecordedBlock } from './diagnostics-recorder.js';
export { BlockedDiagnosticsRecorder } from './diagnostics-recorder.js';
export type { DashboardContainer } from './gateway-adapter.js';

// Store-less `tenant` dashboard: adapt the RunGateway to the handlers' read/control port (design §8).
export { dashboardEngineForTopology, gatewayDashboardEngine } from './gateway-adapter.js';
export type { ApiRequest, ApiResponse, DashboardEngine, Deps } from './handlers.js';
export {
  bulkAction,
  cancelRun,
  continueRun,
  deliverWebhook,
  getRun,
  getRunEvent,
  health,
  listRuns,
  metricsText,
  ok,
  redispatchPendingRun,
  republishLifecycleRun,
  retryRun,
  retryWithInputRun,
  runValues,
  topology,
  workers,
  workflowLifecycle,
} from './handlers.js';
export { RUN_STATUSES, RunFilter } from './run-filter.js';
export { RunQueryDraft } from './run-query-draft.js';
export { runValueAdapter, valueAxisFor } from './run-values.js';
