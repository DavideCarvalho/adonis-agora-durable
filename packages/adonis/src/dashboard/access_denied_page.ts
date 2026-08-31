/**
 * The built-in "access denied" page a BROWSER sees when the dashboard guard refuses a page
 * navigation — the SPA shell, its assets, or (Mode A only) a session-less visit. Before this page
 * existed the guard answered every denial with the JSON it answers the API with
 * (`{ "error": "forbidden" }`), which is the right thing for the SPA's `fetch` calls and the wrong
 * thing for a human staring at a browser tab.
 *
 * Deliberately a small, dependency-free, hand-authored HTML page (like `login_page.ts`) — NOT part
 * of the bundled SPA, so a denial never needs the SPA to load first. It carries NO `<script>` at all,
 * so a host running a nonce'd `script-src` CSP (the `@adonisjs/shield` default) cannot break it; the
 * one inline `<style>` takes the request's CSP nonce when the provider hands one over.
 *
 * Every string the host can supply ({@link AccessDeniedPageOptions}) is HTML-escaped on the way in.
 * They are developer-controlled config values, not user input — but escaping them costs nothing and
 * removes the one class of bug a "just interpolate it" template would invite.
 *
 * The visual language (Aviary neutrals, the console's own accent, mono eyebrow over a sans body)
 * mirrors the durable SPA so the refusal reads as part of the same product, not a server default.
 *
 * Ported from `@adonis-agora/payments` (also in `@adonis-agora/media`, `@adonis-agora/agent` and
 * `@adonis-agora/telescope` with only {@link CONSOLE} changed, so the Agora consoles share ONE
 * refusal story rather than each inventing its own.
 */

/** Why the guard refused. Drives the default title/message and which buttons make sense. */
export type AccessDeniedReason =
  /** Nobody is signed in (a `401`): offer the login page when one exists. */
  | 'unauthenticated'
  /** Somebody is signed in but `authorize` said no (a `403`). */
  | 'forbidden'
  /** `dashboardAuth` runs in Mode A only and there is no session — the host app must mint one. */
  | 'session-required';

/** What the provider knows about the refusal — handed to a custom renderer and to the default page. */
export interface AccessDeniedInfo {
  /** The HTTP status the page is served with. */
  status: 401 | 403;
  reason: AccessDeniedReason;
  /** The console's mount path (`/durable`; `''` when mounted at the root). */
  basePath: string;
  /** The built-in login page, present only when `dashboardAuth.login` is configured. */
  loginHref?: string;
  /** A developer-facing detail (e.g. a thrown hook's message). Providers set it OUTSIDE production only. */
  detail?: string;
  /** The request's CSP nonce, applied to the inline `<style>` so a nonce'd `style-src` keeps the page styled. */
  nonce?: string;
}

/**
 * Knobs for the built-in page — the `accessDenied` config option in its OBJECT form. Every field is
 * optional; omit the option entirely for the defaults.
 */
export interface AccessDeniedPageOptions {
  /** Console name in the eyebrow and `<title>`. Default: the console's own name (`Durable`). */
  brand?: string;
  /** Heading. Default depends on {@link AccessDeniedInfo.reason}. */
  title?: string;
  /** The sentence under the heading. Default depends on the reason. */
  message?: string;
  /** Where "Back to app" points. Default `/`; `false` hides the button. */
  homeHref?: string | false;
  /** Label of the "Back to app" button. */
  homeLabel?: string;
  /** Where "Sign in" points. Default: the built-in login page when one exists; `false` hides it. */
  loginHref?: string | false;
  /** Label of the "Sign in" button. */
  loginLabel?: string;
  /** Accent colour (any CSS colour). Default: the console's own accent. */
  accent?: string;
}

/**
 * The `accessDenied` config option in its FUNCTION form: render the page yourself. Return an HTML
 * string and the provider serves it (with the refusal's status, `text/html`, `no-store`). Return
 * nothing after answering the request yourself — a redirect to your own login page, most commonly —
 * and the provider stands down. Return nothing WITHOUT answering and the default page is served, so
 * the hook is safe to use for side effects (logging) alone.
 *
 * `Ctx` is the host framework's HTTP context — the provider passes AdonisJS's `HttpContext` through
 * untouched; it is generic here so this module stays framework-light and unit-testable.
 */
export type AccessDeniedRenderer<Ctx = unknown> = (
  info: AccessDeniedInfo,
  ctx: Ctx,
  // biome-ignore lint/suspicious/noConfusingVoidType: a renderer that answers the request itself returns nothing
) => string | undefined | null | void | Promise<string | undefined | null | void>;

/** The `accessDenied` config option: tweak the built-in page, or replace it. */
export type AccessDeniedOption<Ctx = unknown> = AccessDeniedPageOptions | AccessDeniedRenderer<Ctx>;

/** This console's identity — the ONLY thing that differs between the Agora ports of this file. */
export const CONSOLE = {
  brand: 'Durable',
  accent: '#a3e635',
  packageName: '@adonis-agora/durable',
} as const;

const DEFAULT_COPY: Record<AccessDeniedReason, { title: string; message: string }> = {
  unauthenticated: {
    title: 'Sign in required',
    message: 'You need to be signed in to open this console.',
  },
  forbidden: {
    title: 'Access denied',
    message:
      'Your account is not allowed to open this console. If that looks wrong, ask an administrator to grant you access.',
  },
  'session-required': {
    title: 'Open this console from your app',
    message:
      'This console only accepts a session minted by your application. Go back to the app and open the console from there.',
  },
};

/** Escape the five characters that matter inside HTML text and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Accept only a same-origin, root-relative path for a button `href` — the same open-redirect rule
 * `sanitizeReturnTo` applies to `returnTo`. A host-supplied absolute URL is still a developer's
 * choice, so it is allowed; what is refused is anything that could smuggle a `javascript:` scheme.
 */
function safeHref(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed === '') return null;
  if (/^(https?:)?\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return trimmed;
  return null;
}

/** Only a plausible CSS colour token reaches the stylesheet; anything else falls back to the accent. */
function safeColor(candidate: string): string {
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(candidate) ? candidate : CONSOLE.accent;
}

const LOCK_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const KEY_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>';

/**
 * Render the built-in page. Pure: same `info` + `options` in, same HTML out — so it is trivially
 * snapshot/regex testable and safe to call from anywhere (the provider, a test, a host that wants
 * to embed the default page inside its own layout).
 */
export function renderAccessDeniedPage(
  info: AccessDeniedInfo,
  options: AccessDeniedPageOptions = {},
): string {
  const copy = DEFAULT_COPY[info.reason];
  const brand = escapeHtml(options.brand ?? CONSOLE.brand);
  const title = escapeHtml(options.title ?? copy.title);
  const message = escapeHtml(options.message ?? copy.message);
  const accent = safeColor(options.accent ?? CONSOLE.accent);
  const nonceAttr = info.nonce !== undefined ? ` nonce="${escapeHtml(info.nonce)}"` : '';

  const loginHref =
    options.loginHref === false
      ? null
      : (safeHref(options.loginHref ?? info.loginHref ?? '') ?? null);
  const homeHref = options.homeHref === false ? null : safeHref(options.homeHref ?? '/');

  const buttons: string[] = [];
  if (loginHref !== null && info.reason !== 'forbidden') {
    buttons.push(
      `<a class="btn primary" href="${escapeHtml(loginHref)}">${KEY_ICON}${escapeHtml(options.loginLabel ?? 'Sign in')}</a>`,
    );
  }
  if (homeHref !== null) {
    buttons.push(
      `<a class="btn${buttons.length === 0 ? ' primary' : ''}" href="${escapeHtml(homeHref)}">${escapeHtml(options.homeLabel ?? 'Back to app')}</a>`,
    );
  }
  if (loginHref !== null && info.reason === 'forbidden') {
    // A forbidden user might simply be the wrong user: offer a way to switch accounts, second.
    buttons.push(
      `<a class="btn" href="${escapeHtml(loginHref)}">${escapeHtml(options.loginLabel ?? 'Sign in as someone else')}</a>`,
    );
  }

  const detail =
    info.detail !== undefined && info.detail !== ''
      ? `\n    <p class="detail">${escapeHtml(info.detail)}</p>`
      : '';
  const actions = buttons.length > 0 ? `\n    <div class="actions">${buttons.join('')}</div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title} — ${brand}</title>
<style${nonceAttr}>
  :root {
    color-scheme: dark;
    --bg: #09090b;
    --panel: #0c0c0f;
    --panel-2: #101017;
    --line: #1c1c22;
    --text: #e7e7ea;
    --muted: #76767f;
    --bad: #f87171;
    --accent: ${accent};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background:
      radial-gradient(900px 480px at 50% -10%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 70%),
      var(--bg);
    color: var(--text);
    font: 15px/1.6 "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    position: relative;
    overflow: hidden;
    width: 100%;
    max-width: 440px;
    padding: 36px 32px 28px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 30px 60px -24px rgb(0 0 0 / 0.7);
  }
  .card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: linear-gradient(90deg, var(--accent), transparent 80%);
  }
  .eyebrow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 22px;
    font: 11px/1 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .eyebrow .brand { color: var(--accent); }
  .eyebrow .status {
    margin-left: auto;
    padding: 4px 7px;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--bad);
    letter-spacing: 0.08em;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin-bottom: 18px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
  }
  h1 {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  p { margin: 0; color: var(--muted); }
  .detail {
    margin-top: 14px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel-2);
    font: 12px/1.5 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 26px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel-2);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
  }
  .btn:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .btn.primary {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--accent);
  }
  .btn.primary:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .foot {
    margin-top: 26px;
    font: 11px/1 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.04em;
    color: var(--muted);
    opacity: 0.7;
  }
</style>
</head>
<body>
  <main class="card">
    <p class="eyebrow"><span class="brand">${brand}</span><span>console</span><span class="status">${info.status}</span></p>
    <div class="icon" aria-hidden="true">${info.reason === 'forbidden' ? LOCK_ICON : KEY_ICON}</div>
    <h1>${title}</h1>
    <p>${message}</p>${detail}${actions}
    <p class="foot">${escapeHtml(CONSOLE.packageName)}</p>
  </main>
</body>
</html>`;
}

/**
 * Resolve WHAT to serve for a refusal, honouring the host's `accessDenied` option in either form.
 * Returns the HTML to send, or `null` when a custom renderer already answered the request itself
 * (`answered()` reports whether it did — the provider wires that to "a `location` header or a body
 * is already set"). Framework-light: knows nothing about the HTTP context beyond passing it through.
 */
export async function resolveAccessDeniedPage<Ctx>(
  info: AccessDeniedInfo,
  option: AccessDeniedOption<Ctx> | null | undefined,
  ctx: Ctx,
  answered: () => boolean,
): Promise<string | null> {
  if (typeof option === 'function') {
    const rendered = await option(info, ctx);
    if (typeof rendered === 'string') return rendered;
    if (answered()) return null;
    return renderAccessDeniedPage(info);
  }
  return renderAccessDeniedPage(info, option ?? {});
}
