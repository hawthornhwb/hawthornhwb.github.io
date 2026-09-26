const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(new URL('../_includes/daily-views.js', `file://${__filename}`), 'utf8');

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
}

async function visit({
  href = 'https://hawthornhwb.github.io/?v=posts5#articles',
  path = '/',
  now = '2026-09-26T15:59:59Z',
  request = async () => ({ ok: true, json: async () => ({ busuanzi_page_pv: 42 }) }),
  twice = false,
  storage = memoryStorage(),
  deferDOMReady = false
} = {}) {
  const value = { textContent: '—' };
  const date = { textContent: '北京时间' };
  const status = { textContent: '' };
  const element = {
    dataset: { pagePath: path },
    querySelector: selector => ({ '[data-view-count]': value, '[data-view-date]': date, '[data-view-status]': status })[selector]
  };
  const calls = [];
  let timer;
  let cleared = false;
  let domReady = !deferDOMReady;
  let onReady;
  const context = vm.createContext({
    document: {
      currentScript: { dataset: { pagePath: path } },
      readyState: domReady ? 'complete' : 'loading',
      querySelector: () => domReady ? element : null,
      addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') onReady = callback; }
    },
    window: {
      location: new URL(href),
      localStorage: storage,
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
  return {
    value, date, status, calls, expire: () => timer(), cleared: () => cleared,
    finishDOM: () => { domReady = true; onReady(); }
  };
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

test('revisits render cached data immediately, still count once, then show the live response', async () => {
  const storage = memoryStorage();
  await visit({ storage });
  let finish;
  const result = await visit({ storage, request: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.status.textContent, '上次记录，更新中');
  assert.equal(result.calls.length, 1);
  finish({ ok: true, json: async () => ({ busuanzi_page_pv: 43 }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.value.textContent, '43 次');
  assert.equal(result.status.textContent, '');
  assert.equal(JSON.parse(storage.getItem('blog-daily-views-v1:/')).count, 43);
});

test('cached values are never reused for another day or another article', async () => {
  const storage = memoryStorage();
  await visit({ storage });
  const pending = () => new Promise(() => {});
  const tomorrow = await visit({ storage, now: '2026-09-26T16:00:00Z', request: pending });
  const article = await visit({ storage, path: '/posts/article.html', request: pending });
  for (const result of [tomorrow, article]) {
    assert.equal(result.value.textContent, '加载中…');
    assert.equal(result.status.textContent, '');
    assert.equal(result.calls.length, 1);
  }
});

test('failure retains a clearly labelled cached record without pretending it is current', async () => {
  const storage = memoryStorage();
  await visit({ storage });
  const result = await visit({ storage, request: async () => { throw new Error('offline'); } });
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.status.textContent, '上次记录，更新暂不可用');
  assert.equal(result.calls.length, 1);
});

test('disabled storage and malformed cache do not break live counting', async () => {
  for (const data of ['not json', '{"day":"2026-09-26","count":-1}', '{"day":"2026-09-26","count":"42"}', null]) {
    const storage = {
      getItem: () => { if (data === null) throw new Error('blocked'); return data; },
      setItem: () => { throw new Error('quota'); }
    };
    const result = await visit({ storage });
    assert.equal(result.value.textContent, '42 次');
    assert.equal(result.status.textContent, '');
    assert.equal(result.calls.length, 1);
  }
});

test('the head request starts before the DOM exists and early responses render when it is ready', async () => {
  const result = await visit({ deferDOMReady: true, twice: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.value.textContent, '—');
  result.finishDOM();
  assert.equal(result.value.textContent, '42 次');
});

test('cached data is ready at DOMContentLoaded even with a slow live response', async () => {
  const storage = memoryStorage();
  await visit({ storage });
  const result = await visit({ storage, deferDOMReady: true, request: () => new Promise(() => {}) });
  result.finishDOM();
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.status.textContent, '上次记录，更新中');
  assert.equal(result.calls.length, 1);
});
