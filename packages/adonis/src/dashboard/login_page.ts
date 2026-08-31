import { escapeHtml } from './access_denied_page.js';
import { sanitizeReturnTo } from './auth.js';

/**
 * The built-in `dashboardAuth` login page (`GET <basePath>/login`). Deliberately a small,
 * dependency-free, hand-authored HTML page — NOT part of the bundled dashboard SPA — so gating the
 * dashboard shell doesn't require rebuilding or extending the bundled SPA.
 *
 * It works WITHOUT JavaScript: the markup is a classic `<form method="post">` carrying `returnTo`
 * in a hidden field, and the provider answers a form-encoded `POST` with a redirect (to `returnTo`
 * on success, back here with `?error` on failure). The inline `<script>` is progressive
 * enhancement only — it swaps the full-page round trip for a JSON `fetch` and shows the error in
 * place — and it carries the request's CSP nonce when the provider hands one over, so a host
 * running `@adonisjs/shield`'s `script-src 'self' @nonce` keeps the enhancement instead of a
 * dead form. The `<style>` takes the same nonce.
 *
 * The only per-request values interpolated are `returnTo` (already passed through
 * {@link sanitizeReturnTo}, so it is a root-relative path) and the `error` flag; both go through
 * {@link escapeHtml} (and `JSON.stringify` inside the script) so nothing in the query string can
 * break out of an attribute or the script. `basePath` is developer-controlled config.
 *
 * The visual language (dark zinc card, mono type, emerald accent) mirrors the Agora consoles so
 * they feel like one family.
 *
 * The password input has NO `required` attribute and the value is forwarded AS-IS (empty string
 * when blank): the host's `login` hook — not this page — decides whether a password matters, so an
 * email-only host (gate on username, ignore password) works with the same page as a host with real
 * passwords.
 */
export interface LoginPageOptions {
  /** The request's CSP nonce, applied to the inline `<style>` and `<script>`. */
  nonce?: string;
  /** Render the "Invalid username or password." notice (the no-JS failure round trip). */
  error?: boolean;
  /** Where to send the operator after a successful sign-in. Sanitized here; default `basePath`. */
  returnTo?: unknown;
}

/**
 * JSON for embedding INSIDE an inline `<script>`: `JSON.stringify` alone leaves `</script>` (and
 * `<!--`) untouched, and the HTML parser ends the script element on the first `</script>` it sees
 * regardless of JavaScript string boundaries — so a `returnTo` of `/x</script><script>…` would run.
 * Escaping the angle brackets (and `&`, plus the two line terminators JSON allows but JS doesn't)
 * as `\uXXXX` keeps the value byte-identical once parsed and inert to the HTML parser.
 */
function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function renderLoginPage(basePath: string, options: LoginPageOptions = {}): string {
  const loginAction = `${basePath}/login`;
  const defaultReturnTo = basePath === '' ? '/' : basePath;
  const returnTo = sanitizeReturnTo(options.returnTo, defaultReturnTo);
  const nonceAttr = options.nonce !== undefined ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const errorStyle = options.error ? ' style="display:block"' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Sign in — Durable</title>
<style${nonceAttr}>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #09090b;
    color: #e4e4e7;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 16px;
  }
  .card {
    width: 100%;
    max-width: 384px;
    border: 1px solid #27272a;
    background: #18181b;
    border-radius: 8px;
    padding: 32px;
    box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5);
  }
  .brand {
    margin: 0 0 24px;
    text-align: center;
    font-size: 18px;
    font-weight: 600;
    color: #34d399;
  }
  form { display: flex; flex-direction: column; gap: 16px; }
  label { display: flex; flex-direction: column; gap: 6px; }
  .field-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #71717a;
  }
  input {
    border-radius: 4px;
    border: 1px solid #3f3f46;
    background: #09090b;
    color: #f4f4f5;
    padding: 8px 12px;
    font: inherit;
    outline: none;
  }
  input:focus { border-color: rgb(52 211 153 / 0.6); }
  #error {
    display: none;
    margin: 0;
    font-size: 12px;
    color: #fb7185;
  }
  button {
    margin-top: 8px;
    border-radius: 4px;
    border: 1px solid rgb(52 211 153 / 0.4);
    background: rgb(52 211 153 / 0.1);
    color: #6ee7b7;
    padding: 8px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: rgb(52 211 153 / 0.2); }
  button:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
  <div class="card">
    <p class="brand">Durable</p>
    <form id="login-form" method="post" action="${escapeHtml(loginAction)}" autocomplete="on">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
      <label>
        <span class="field-label">Username</span>
        <input id="username" name="username" type="text" autocomplete="username" required autofocus />
      </label>
      <label>
        <span class="field-label">Password</span>
        <input id="password" name="password" type="password" autocomplete="current-password" />
      </label>
      <p id="error" role="alert"${errorStyle}>Invalid username or password.</p>
      <button id="submit" type="submit">Sign in</button>
    </form>
  </div>
<script${nonceAttr}>
(function () {
  var LOGIN_ACTION = ${jsonForScript(loginAction)};
  var RETURN_TO = ${jsonForScript(returnTo)};
  var errorBox = document.getElementById('error');
  var form = document.getElementById('login-form');
  var submitButton = document.getElementById('submit');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    submitButton.disabled = true;
    errorBox.style.display = 'none';
    fetch(LOGIN_ACTION, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
        returnTo: RETURN_TO,
      }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('unauthorized');
        return response.json();
      })
      .then(function (data) {
        window.location.href = data.redirectTo || RETURN_TO;
      })
      .catch(function () {
        errorBox.style.display = 'block';
        submitButton.disabled = false;
      });
  });
})();
</script>
</body>
</html>`;
}
