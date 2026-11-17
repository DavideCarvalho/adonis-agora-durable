import { afterEach } from 'vitest';

// The runs board keeps its filters in the URL hash (`#/run/<id>?status=failed&tag=vip`). The test
// environment keeps one `location` per file, so reset it after each test: a filter left by one test
// must not open the next one filtered. (Node-environment specs have no `window`.)
afterEach(() => {
  if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
});
