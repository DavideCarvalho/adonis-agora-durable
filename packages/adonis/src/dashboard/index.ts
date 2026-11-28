/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '1.2.1';

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
  ConsoleAccess,
  ConsoleAuthorize,
  ConsoleAuthorizeDecision,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from './console_authorize.js';
// The shared console `authorize` contract (function, class, lazy import).
export {
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console_authorize.js';
export {
  CONSOLE_ALL,
  CONSOLE_READ,
  CONSOLE_WRITE,
  type ConsoleCapabilityKind,
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
  consoleCapabilityKind,
} from './console_capabilities.js';
export type { ConsoleAuthorizeGate, ConsoleDecision } from './console_decision.js';
export { normalizeConsoleDecision, resolveConsoleGate } from './console_decision.js';
// The console shell's data-block fields: who is signed in, and how to sign out.
export type {
  ConsoleSignOut,
  ConsoleViewer,
  SignOutOption,
  ViewerHook,
} from './console_shell.js';
export { resolveSignOut, resolveViewer, viewerFromUser } from './console_shell.js';
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
  FEDERATED_APP_KEY,
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
export type {
  AnswerConsoleCommandsOptions,
  ConsoleCommandVerb,
  FederatedConsoleApp,
} from './federation.js';
// The federated console: other apps' runs, read from their stores, acted on through their engines.
export {
  answerConsoleCommands,
  buildFederatedApp,
  CAPABILITIES_REQUIRED,
  CONSOLE_COMMAND_VERBS,
  CONSOLE_VERB_CAPABILITY,
  consoleVerbAllowed,
  DURABLE_CONSOLE_CAPABILITIES,
  DURABLE_CONSOLE_CAPABILITY_TABLE,
  DURABLE_CONSOLE_FULL_CAPABILITIES,
  durableConsoleAllows,
  FEDERATED_APP_UNREACHABLE,
  FEDERATED_FORBIDDEN,
  FederatedApp,
  FederatedAppError,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
  viewerConsoleCapabilities,
  viewerScopedDashboardEngine,
} from './federation.js';
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
