const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(new URL('../assets/js/daily-views.js', `file://${__filename}`), 'utf8');

async function visit({
  href = 'https://hawthornhwb.github.io/?v=posts5#articles',
  path = '/',
  now = '2026-09-26T15:59:59Z',
  request = async () => ({ ok: true, json: async () => ({ busuanzi_page_pv: 42 }) }),
  twice = false
} = {}) {
  const value = { textContent: '—' };
  const date = { textContent: '北京时间' };
  const element = {
    dataset: { pagePath: path },
    querySelector: selector => selector === '[data-view-count]' ? value : date
  };
  const calls = [];
  let timer;
  let cleared = false;
  const context = vm.createContext({
    document: { querySelector: () => element },
    window: {
      location: new URL(href),
      setTimeout: callback => { timer = callback; return 1; },
      clearTimeout: () => { cleared = true; }
    },
    URL, Intl, AbortController,
    Date: class extends Date { constructor() { super(now); } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return request(url, options);
    }
  });
  vm.runInContext(source, context);
  if (twice) vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { value, date, calls, expire: () => timer(), cleared: () => cleared };
}

test('one load reports the canonical homepage once, excluding query/hash and referrer', async () => {
  const result = await visit({ twice: true });
  assert.equal(result.calls.length, 1);
  const { options } = result.calls[0];
  assert.deepEqual(JSON.parse(options.body), {
    url: 'https://hawthornhwb.github.io/__daily_views__/2026-09-26/', referrer: ''
  });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.date.textContent, '2026-09-26 · 北京时间');
  assert.equal(result.cleared(), true);
});

test('midnight in Shanghai starts a new counter regardless of visitor timezone', async () => {
  const before = await visit();
  const after = await visit({ now: '2026-09-26T16:00:00Z' });
  assert.match(JSON.parse(before.calls[0].options.body).url, /2026-09-26/);
  assert.match(JSON.parse(after.calls[0].options.body).url, /2026-09-27/);
});

test('different articles remain independent; reloading one increments its existing counter', async () => {
  const counts = new Map();
  const request = async (_, options) => {
    const key = JSON.parse(options.body).url;
    counts.set(key, (counts.get(key) || 0) + 1);
    return { ok: true, json: async () => ({ busuanzi_page_pv: counts.get(key) }) };
  };
  assert.equal((await visit({ path: '/posts/第一篇.html', request })).value.textContent, '1 次');
  assert.equal((await visit({ path: '/posts/第二篇.html', request })).value.textContent, '1 次');
  assert.equal((await visit({ path: '/posts/第一篇.html', request })).value.textContent, '2 次');
  assert.equal(counts.size, 2);
});

test('local and preview hosts never send production statistics', async () => {
  for (const href of ['http://localhost:4000/', 'http://127.0.0.1:4000/', 'https://preview.example.com/']) {
    const result = await visit({ href });
    assert.equal(result.calls.length, 0);
    assert.equal(result.value.textContent, '本地预览不计数');
  }
});

test('network, HTTP, JSON, and invalid-data failures display unavailable without retry', async () => {
  const cases = [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
    ...[{}, { busuanzi_page_pv: -1 }, { busuanzi_page_pv: '42' }, { busuanzi_page_pv: null }]
      .map(data => async () => ({ ok: true, json: async () => data }))
  ];
  for (const request of cases) {
    const result = await visit({ request });
    assert.equal(result.value.textContent, '暂不可用');
    assert.equal(result.calls.length, 1);
    assert.equal(result.cleared(), true);
  }
});

test('a timed-out request aborts and leaves no misleading loading indicator', async () => {
  const result = await visit({ request: (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  result.expire();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.value.textContent, '暂不可用');
  assert.equal(result.calls.length, 1);
  assert.equal(result.cleared(), true);
});

test('a legitimate zero is shown as zero', async () => {
  const result = await visit({ request: async () => ({ ok: true, json: async () => ({ busuanzi_page_pv: 0 }) }) });
  assert.equal(result.value.textContent, '0 次');
});
