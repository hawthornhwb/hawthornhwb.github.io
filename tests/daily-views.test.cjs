const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(new URL('../_includes/daily-views.js', `file://${__filename}`), 'utf8');
const counterTemplate = readFileSync(new URL('../_includes/daily-views.html', `file://${__filename}`), 'utf8');
const mountSource = counterTemplate.match(/<\/p>\s*<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
}

async function visit({
  href = 'https://hawthornhwb.github.io/?v=posts5#articles',
  path = '/',
  now = '2026-09-26T15:59:59Z',
  request = async () => ({ ok: true, json: async () => ({ success: true, data: { page_pv: 42 } }) }),
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
  let counterPresent = !deferDOMReady;
  const document = Object.assign(new EventTarget(), {
    currentScript: { dataset: { pagePath: path } },
    readyState: deferDOMReady ? 'loading' : 'complete',
    querySelector: () => counterPresent ? element : null
  });
  const context = vm.createContext({
    document,
    window: {
      location: new URL(href),
      localStorage: storage,
      setTimeout: callback => { timer = callback; return 1; },
      clearTimeout: () => { cleared = true; }
    },
    URL, Intl, AbortController, Event,
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
    value, date, status, calls, document, expire: () => timer(), cleared: () => cleared,
    mountCounter: () => {
      counterPresent = true;
      assert.equal(typeof mountSource, 'string', 'the counter template must mount after its markup');
      vm.runInContext(mountSource, context);
    },
    finishDOM: () => {
      counterPresent = true;
      document.readyState = 'interactive';
      document.dispatchEvent(new Event('DOMContentLoaded'));
    }
  };
}

test('one load reports the canonical homepage once, excluding query/hash and referrer', async () => {
  const result = await visit({ twice: true });
  assert.equal(result.calls.length, 1);
  const { url, options } = result.calls[0];
  assert.equal(url, 'https://bsz.dusays.com:9001/api');
  assert.equal(options.method, 'POST');
  assert.deepEqual({ ...options.headers }, {
    'x-bsz-referer': 'https://hawthornhwb.github.io/__daily_views__/2026-09-26/'
  });
  assert.equal(options.body, undefined);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.cache, 'no-store');
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.date.textContent, '2026-09-26 · 北京时间');
  assert.equal(result.cleared(), true);
});

test('midnight in Shanghai starts a new counter regardless of visitor timezone', async () => {
  const before = await visit();
  const after = await visit({ now: '2026-09-26T16:00:00Z' });
  assert.match(before.calls[0].options.headers['x-bsz-referer'], /2026-09-26/);
  assert.match(after.calls[0].options.headers['x-bsz-referer'], /2026-09-27/);
});

test('different articles remain independent; reloading one increments its existing counter', async () => {
  const counts = new Map();
  const request = async (_, options) => {
    const key = options.headers['x-bsz-referer'];
    counts.set(key, (counts.get(key) || 0) + 1);
    return { ok: true, json: async () => ({ success: true, data: { page_pv: counts.get(key) } }) };
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
    ...[{}, ...[-1, '42', null, 0.5, Number.MAX_SAFE_INTEGER + 1]
      .map(page_pv => ({ success: true, data: { page_pv } }))]
      .map(data => async () => ({ ok: true, json: async () => data }))
  ];
  for (const request of cases) {
    const result = await visit({ request });
    assert.equal(result.value.textContent, '暂不可用');
    assert.equal(result.calls.length, 1);
    assert.equal(result.cleared(), true);
  }
});

test('the service must explicitly report success even when a valid count is present', async () => {
  for (const success of [false, undefined, null, 1, 'true']) {
    const storage = memoryStorage();
    const result = await visit({
      storage,
      request: async () => ({ ok: true, json: async () => ({ success, data: { page_pv: 42 } }) })
    });
    assert.equal(result.value.textContent, '暂不可用');
    assert.equal(result.calls.length, 1);
    assert.equal(result.cleared(), true);
    assert.equal(storage.getItem('blog-daily-views-v2:bsz-dusays:/'), null);
  }
});

test('missing or malformed nested service data never becomes a count', async () => {
  for (const data of [
    null,
    { success: true },
    { success: true, data: null },
    { success: true, data: [] },
    { success: true, data: {} },
    { success: true, page_pv: 42 },
    { success: true, data: { busuanzi_page_pv: 42 } }
  ]) {
    const result = await visit({ request: async () => ({ ok: true, json: async () => data }) });
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
  const result = await visit({ request: async () => ({ ok: true, json: async () => ({ success: true, data: { page_pv: 0 } }) }) });
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
  finish({ ok: true, json: async () => ({ success: true, data: { page_pv: 43 } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.value.textContent, '43 次');
  assert.equal(result.status.textContent, '');
  assert.equal(JSON.parse(storage.getItem('blog-daily-views-v2:bsz-dusays:/')).count, 43);
});

test('the new service never reads the old service cache or mixes it into the restarted count', async () => {
  const storage = memoryStorage();
  const oldKey = 'blog-daily-views-v1:/';
  const newKey = 'blog-daily-views-v2:bsz-dusays:/';
  const oldRecord = JSON.stringify({ day: '2026-09-26', count: 900 });
  storage.setItem(oldKey, oldRecord);
  const reads = [];
  const getItem = storage.getItem;
  storage.getItem = key => { reads.push(key); return getItem(key); };
  let finish;
  const result = await visit({
    storage,
    request: () => new Promise(resolve => { finish = resolve; })
  });
  assert.deepEqual(reads, [newKey]);
  assert.equal(result.value.textContent, '加载中…');
  assert.equal(result.status.textContent, '');
  assert.equal(result.calls.length, 1);
  finish({ ok: true, json: async () => ({ success: true, data: { page_pv: 1 } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.value.textContent, '1 次');
  assert.equal(result.status.textContent, '');
  assert.equal(getItem(oldKey), oldRecord);
  assert.deepEqual(JSON.parse(getItem(newKey)), { day: '2026-09-26', count: 1 });
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

test('the counter markup displays an early response before DOMContentLoaded', async () => {
  const result = await visit({ deferDOMReady: true, twice: true });
  assert.equal(result.value.textContent, '—');
  result.mountCounter();
  assert.equal(result.document.readyState, 'loading');
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.date.textContent, '2026-09-26 · 北京时间');
  assert.equal(result.status.textContent, '');
  assert.equal(result.calls.length, 1);
  result.finishDOM();
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.calls.length, 1);
});

test('the counter markup displays cached data and a later response before DOMContentLoaded', async () => {
  const storage = memoryStorage();
  await visit({ storage });
  let finish;
  const result = await visit({
    storage,
    deferDOMReady: true,
    request: () => new Promise(resolve => { finish = resolve; })
  });
  assert.equal(result.value.textContent, '—');
  result.mountCounter();
  assert.equal(result.document.readyState, 'loading');
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.status.textContent, '上次记录，更新中');
  assert.equal(result.calls.length, 1);
  finish({ ok: true, json: async () => ({ success: true, data: { page_pv: 43 } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.document.readyState, 'loading');
  assert.equal(result.value.textContent, '43 次');
  assert.equal(result.status.textContent, '');
  assert.equal(result.calls.length, 1);
  result.finishDOM();
  assert.equal(result.value.textContent, '43 次');
});

test('mounting a pending counter repeatedly never adds a request and a late response updates it', async () => {
  let finish;
  const result = await visit({
    deferDOMReady: true,
    twice: true,
    request: () => new Promise(resolve => { finish = resolve; })
  });
  result.mountCounter();
  result.mountCounter();
  assert.equal(result.document.readyState, 'loading');
  assert.equal(result.value.textContent, '加载中…');
  assert.equal(result.calls.length, 1);
  result.finishDOM();
  assert.equal(result.value.textContent, '加载中…');
  assert.equal(result.calls.length, 1);
  finish({ ok: true, json: async () => ({ success: true, data: { page_pv: 42 } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.value.textContent, '42 次');
  assert.equal(result.status.textContent, '');
  assert.equal(result.calls.length, 1);
});
