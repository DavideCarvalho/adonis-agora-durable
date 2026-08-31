/**
 * The built-in `dashboardAuth` login page (`GET <basePath>/login`). Deliberately a small,
 * dependency-free, hand-authored HTML page — NOT part of the bundled dashboard SPA — so gating the
 * dashboard shell doesn't require rebuilding the SPA bundle.
 *
 * `returnTo` and any error state are read CLIENT-SIDE from `location.search` (never server-echoed
 * into the HTML), so this function's only per-request-ish input is `basePath` — a developer-
 * controlled config value, not user input — and the page body is otherwise a static template.
 * This sidesteps HTML-escaping entirely: there is no reflected query-param interpolation surface
 * to get wrong.
 *
 * The visual language (dark zinc card, mono type, emerald accent) mirrors the Agora consoles so
 * they feel like one family. The submit flow POSTs JSON via `fetch` and follows the JSON
 * `redirectTo` it gets back (rather than a classic form POST + server redirect), which is why the
 * markup keeps its own `<script>`.
 *
 * The password input has NO `required` attribute and the value is forwarded AS-IS (empty string
 * when blank): the host's `login` hook — not this page — decides whether a password matters, so an
 * email-only host (gate on username, ignore password) works with the same page as a host with real
 * passwords.
 */
export function renderLoginPage(basePath: string): string {
  const loginAction = `${basePath}/login`;
  const defaultReturnTo = basePath === '' ? '/' : basePath;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Sign in — Durable</title>
<style>
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
    <form id="login-form" autocomplete="on">
      <label>
        <span class="field-label">Username</span>
        <input id="username" name="username" type="text" autocomplete="username" required autofocus />
      </label>
      <label>
        <span class="field-label">Password</span>
        <input id="password" name="password" type="password" autocomplete="current-password" />
      </label>
      <p id="error" role="alert">Invalid username or password.</p>
      <button id="submit" type="submit">Sign in</button>
    </form>
  </div>
<script>
(function () {
  var LOGIN_ACTION = ${JSON.stringify(loginAction)};
  var DEFAULT_RETURN_TO = ${JSON.stringify(defaultReturnTo)};
  var params = new URLSearchParams(window.location.search);
  var errorBox = document.getElementById('error');
  if (params.get('error')) errorBox.style.display = 'block';

  function sameOriginReturnTo(value) {
    if (typeof value !== 'string' || value === '') return DEFAULT_RETURN_TO;
    if (value.charAt(0) !== '/' || value.charAt(1) === '/' || value.indexOf('://') !== -1) {
      return DEFAULT_RETURN_TO;
    }
    return value;
  }

  var form = document.getElementById('login-form');
  var submitButton = document.getElementById('submit');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    submitButton.disabled = true;
    errorBox.style.display = 'none';
    var returnTo = sameOriginReturnTo(params.get('returnTo'));
    fetch(LOGIN_ACTION, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
        returnTo: returnTo,
      }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('unauthorized');
        return response.json();
      })
      .then(function (data) {
        window.location.href = data.redirectTo || DEFAULT_RETURN_TO;
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
