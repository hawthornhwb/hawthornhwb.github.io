(() => {
  'use strict';

  const path = document.currentScript?.dataset.pagePath;
  if (!path || window.blogDailyViewsStarted) return;
  window.blogDailyViewsStarted = true;

  let text = '加载中…';
  let status = '';
  let dateText = '北京时间';
  function render() {
    const counter = document.querySelector('[data-daily-views]');
    if (!counter) return;
    counter.querySelector('[data-view-count]').textContent = text;
    counter.querySelector('[data-view-status]').textContent = status;
    counter.querySelector('[data-view-date]').textContent = dateText;
  }
  // Render as soon as the counter markup exists. DOMContentLoaded also waits
  // for unrelated deferred scripts, so it is only a fallback for mounting.
  document.addEventListener('blog:daily-views-ready', render, { once: true });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  }
  // Never add local previews or other deployments to the live site's counts.
  if (window.location.hostname !== 'hawthornhwb.github.io') {
    text = '本地预览不计数';
    render();
    return;
  }

  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  dateText = `${day} · 北京时间`;

  // Busuanzi counts each URL independently. A date-prefixed virtual path makes
  // page_pv a daily counter, without depending on the provider's reset timezone.
  // Jekyll supplies the canonical path, so ?v=posts5 and #anchors share a count.
  const url = new URL(path, window.location.origin);
  // Keep the new provider's counts separate from the retired busuanzi.cc cache.
  const cacheKey = `blog-daily-views-v2:bsz-dusays:${url.pathname}`;
  let cachedCount;
  try {
    const cached = JSON.parse(window.localStorage.getItem(cacheKey));
    if (cached?.day === day && Number.isSafeInteger(cached.count) && cached.count >= 0) {
      cachedCount = cached.count;
      text = `${cachedCount.toLocaleString('zh-CN')} 次`;
      status = '上次记录，更新中';
    }
  } catch (_) { /* Storage can be disabled, full, or contain invalid JSON. */ }
  render();
  url.pathname = `/__daily_views__/${day}${url.pathname}`;
  url.search = '';
  url.hash = '';

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);

  // BSZ accepts the canonical counter key in x-bsz-referer. A POST both records
  // this visit and returns page_pv; never prefetch or retry this write request.
  // Send no query strings, browsing referrer, credentials, or third-party JS.
  fetch('https://bsz.dusays.com:9001/api', {
    method: 'POST',
    headers: { 'x-bsz-referer': url.href },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal: controller.signal
  })
    .then(response => {
      if (!response.ok) throw new Error('Counter request failed');
      return response.json();
    })
    .then(data => {
      const count = data?.data?.page_pv;
      if (data?.success !== true || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('Invalid counter response');
      }
      text = `${count.toLocaleString('zh-CN')} 次`;
      status = '';
      render();
      try {
        // One record per page; a new day replaces yesterday instead of reusing it.
        window.localStorage.setItem(cacheKey, JSON.stringify({ day, count }));
      } catch (_) { /* Counting must work even when caching is unavailable. */ }
    })
    .catch(() => {
      // No automatic retry: an ambiguous response may already have been counted.
      if (cachedCount !== undefined) {
        status = '上次记录，更新暂不可用';
      } else {
        text = '暂不可用';
      }
      render();
    })
    .finally(() => window.clearTimeout(timeout));
})();
