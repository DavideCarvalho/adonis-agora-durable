import { describe, expect, it } from 'vitest';
import {
  type AccessDeniedInfo,
  CONSOLE,
  escapeHtml,
  renderAccessDeniedPage,
  resolveAccessDeniedPage,
} from '../../src/dashboard/access_denied_page.js';

const forbidden: AccessDeniedInfo = { status: 403, reason: 'forbidden', basePath: '/durable' };
const unauthenticated: AccessDeniedInfo = {
  status: 401,
  reason: 'unauthenticated',
  basePath: '/durable',
  loginHref: '/durable/login',
};
const sessionRequired: AccessDeniedInfo = {
  status: 401,
  reason: 'session-required',
  basePath: '/durable',
};

describe('renderAccessDeniedPage', () => {
  it('is a full HTML document with the status, the console brand and NO inline script', () => {
    const html = renderAccessDeniedPage(forbidden);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<title>Access denied — ${CONSOLE.brand}</title>`);
    expect(html).toContain('<span class="status">403</span>');
    expect(html).toContain(`<span class="brand">${CONSOLE.brand}</span>`);
    expect(html).toContain(CONSOLE.packageName);
    expect(html).not.toContain('<script');
  });

  it('speaks the console visual language: Aviary neutrals + this console accent', () => {
    const html = renderAccessDeniedPage(forbidden);
    expect(html).toContain('--bg: #09090b');
    expect(html).toContain('--panel: #0c0c0f');
    expect(html).toContain(`--accent: ${CONSOLE.accent}`);
    expect(html).toContain('JetBrains Mono');
  });

  it('picks copy and buttons from the reason', () => {
    const denied = renderAccessDeniedPage(forbidden);
    expect(denied).toContain('<h1>Access denied</h1>');
    expect(denied).toContain('href="/"');
    expect(denied).not.toContain('Sign in');

    const signIn = renderAccessDeniedPage(unauthenticated);
    expect(signIn).toContain('<h1>Sign in required</h1>');
    expect(signIn).toContain('<span class="status">401</span>');
    expect(signIn).toContain('class="btn primary" href="/durable/login"');
    expect(signIn).toContain('Sign in</a>');

    const fromApp = renderAccessDeniedPage(sessionRequired);
    expect(fromApp).toContain('<h1>Open this console from your app</h1>');
    expect(fromApp).not.toContain('/login');
  });

  it('offers "sign in as someone else" on a 403 when a login page exists', () => {
    const html = renderAccessDeniedPage({ ...forbidden, loginHref: '/durable/login' });
    expect(html).toContain('Sign in as someone else');
    // …but the primary action stays "back to app": the user IS signed in, just not allowed.
    expect(html).toContain('class="btn primary" href="/"');
  });

  it('honours every option and escapes each one', () => {
    const html = renderAccessDeniedPage(forbidden, {
      brand: 'Entre <Textos>',
      title: 'Sem "acesso"',
      message: 'Fale com o admin & tente de novo',
      homeHref: '/admin',
      homeLabel: 'Voltar',
      loginHref: '/entrar',
      loginLabel: 'Trocar de conta',
      accent: '#f59e0b',
    });
    expect(html).toContain('<title>Sem &quot;acesso&quot; — Entre &lt;Textos&gt;</title>');
    expect(html).toContain('<h1>Sem &quot;acesso&quot;</h1>');
    expect(html).toContain('Fale com o admin &amp; tente de novo');
    expect(html).toContain('href="/admin">Voltar</a>');
    expect(html).toContain('href="/entrar">Trocar de conta</a>');
    expect(html).toContain('--accent: #f59e0b');
    expect(html).not.toContain('<Textos>');
  });

  it('hides a button when its href is `false`, and drops unsafe hrefs/colours', () => {
    const bare = renderAccessDeniedPage(unauthenticated, { homeHref: false, loginHref: false });
    expect(bare).not.toContain('class="actions"');

    const unsafe = renderAccessDeniedPage(forbidden, {
      homeHref: 'javascript:alert(1)',
      accent: 'red; } body { display: none',
    });
    expect(unsafe).not.toContain('javascript:');
    expect(unsafe).toContain(`--accent: ${CONSOLE.accent}`);
  });

  it('carries the CSP nonce onto the inline <style> and shows a dev detail when given', () => {
    const html = renderAccessDeniedPage({
      ...unauthenticated,
      nonce: 'abc"123',
      detail: 'no authenticated user on <ctx.auth.user>',
    });
    expect(html).toContain('<style nonce="abc&quot;123">');
    expect(html).toContain('<p class="detail">no authenticated user on &lt;ctx.auth.user&gt;</p>');
    expect(renderAccessDeniedPage(forbidden)).toContain('<style>');
  });
});

describe('resolveAccessDeniedPage', () => {
  it('serves the built-in page (with options) when the host passes an object or nothing', async () => {
    const plain = await resolveAccessDeniedPage(forbidden, null, {}, () => false);
    expect(plain).toContain('<h1>Access denied</h1>');
    const tweaked = await resolveAccessDeniedPage(forbidden, { title: 'Nope' }, {}, () => false);
    expect(tweaked).toContain('<h1>Nope</h1>');
  });

  it('serves whatever HTML a renderer returns, passing the info and ctx through', async () => {
    const ctx = { marker: true };
    let seen: unknown[] = [];
    const html = await resolveAccessDeniedPage(
      forbidden,
      (info, c) => {
        seen = [info, c];
        return '<p>custom</p>';
      },
      ctx,
      () => false,
    );
    expect(html).toBe('<p>custom</p>');
    expect(seen).toEqual([forbidden, ctx]);
  });

  it('stands down (null) when the renderer answered the request itself', async () => {
    let redirected = false;
    const html = await resolveAccessDeniedPage(
      forbidden,
      async () => {
        redirected = true;
      },
      {},
      () => redirected,
    );
    expect(html).toBeNull();
  });

  it('falls back to the built-in page when the renderer neither returned HTML nor answered', async () => {
    const html = await resolveAccessDeniedPage(
      forbidden,
      () => {
        /* logging only */
      },
      {},
      () => false,
    );
    expect(html).toContain('<h1>Access denied</h1>');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
