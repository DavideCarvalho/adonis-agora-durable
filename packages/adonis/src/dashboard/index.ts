/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.20.0';

export { defineConfig, defaultAuthorize, resolveConfig } from './define_config.js';
export type {
  AuthorizeHook,
  DurableDashboardConfig,
  ResolvedDurableDashboardConfig,
} from './define_config.js';
export {
  listRuns,
  getRun,
  retryRun,
  redispatchPendingRun,
  cancelRun,
  health,
  ok,
} from './handlers.js';
export type { ApiRequest, ApiResponse, Deps, DashboardEngine } from './handlers.js';
export { renderDashboard } from './html.js';

// Fleet health / protocol-compatibility panel (design §7.6, §10).
export { compat, enumerateLiveFleet, mergeFleets } from './compat.js';
export type { CompatSource, FleetGroup, FleetTransport } from './compat.js';
export { BlockedDiagnosticsRecorder } from './diagnostics-recorder.js';
export type { RecordedBlock, EngineEventSource } from './diagnostics-recorder.js';
export { outcomeClass, outcomeLabel, formatProtocolRange } from './compat-view.js';

// Store-less `tenant` dashboard: adapt the RunGateway to the handlers' read/control port (design §8).
export { gatewayDashboardEngine, dashboardEngineForRole } from './gateway-adapter.js';
export type { DashboardContainer } from './gateway-adapter.js';

// Built-in `dashboardAuth` login screen (optional; opt-in via `config/durable_dashboard.ts`).
export {
  resolveDashboardAuth,
  performLogin,
  readSession,
  sanitizeReturnTo,
  SESSION_COOKIE_NAME,
} from './auth.js';
export type {
  DashboardAuthOptions,
  ResolvedDashboardAuth,
  LoginHook,
  LoginOutcome,
} from './auth.js';
export {
  signSessionCookie,
  verifySessionCookie,
} from './session_cookie.js';
export type {
  DashboardSession,
  DashboardSessionUser,
  SignOptions,
  VerifyOptions,
} from './session_cookie.js';
export { renderLoginPage } from './login_page.js';
