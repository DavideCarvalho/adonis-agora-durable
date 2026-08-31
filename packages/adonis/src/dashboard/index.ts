/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.27.0';

export type {
  AuthMode,
  DashboardAuthOptions,
  LoginHook,
  LoginOutcome,
  ResolvedDashboardAuth,
  SessionHook,
  SessionOutcome,
} from './auth.js';
// Built-in `dashboardAuth` login screen (optional; opt-in via `config/durable_dashboard.ts`).
export {
  performLogin,
  performSession,
  readSession,
  resolveDashboardAuth,
  SESSION_COOKIE_NAME,
  sanitizeReturnTo,
} from './auth.js';
export type { CompatSource, FleetGroup, FleetTransport } from './compat.js';
// Fleet health / protocol-compatibility panel (design §7.6, §10).
export { compat, enumerateLiveFleet, mergeFleets } from './compat.js';
export { formatProtocolRange, outcomeClass, outcomeLabel } from './compat-view.js';
export type {
  AuthorizeHook,
  DurableDashboardConfig,
  ResolvedDurableDashboardConfig,
} from './define_config.js';
export { defaultAuthorize, defineConfig, resolveConfig } from './define_config.js';
export type { EngineEventSource, RecordedBlock } from './diagnostics-recorder.js';
export { BlockedDiagnosticsRecorder } from './diagnostics-recorder.js';
export type { DashboardContainer } from './gateway-adapter.js';

// Store-less `tenant` dashboard: adapt the RunGateway to the handlers' read/control port (design §8).
export { dashboardEngineForRole, gatewayDashboardEngine } from './gateway-adapter.js';
export type { ApiRequest, ApiResponse, DashboardEngine, Deps } from './handlers.js';
export {
  bulkAction,
  cancelRun,
  continueRun,
  getRun,
  health,
  listRuns,
  ok,
  redispatchPendingRun,
  retryRun,
  retryWithInputRun,
  topology,
  workers,
} from './handlers.js';
export { renderLoginPage } from './login_page.js';
export type {
  DashboardSession,
  DashboardSessionUser,
  SignOptions,
  VerifyOptions,
} from './session_cookie.js';
export {
  signSessionCookie,
  verifySessionCookie,
} from './session_cookie.js';
