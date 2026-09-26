(() => {
  'use strict';

  const counter = document.querySelector('[data-daily-views]');
  if (!counter || counter.dataset.started) return;
  counter.dataset.started = 'true';

  const value = counter.querySelector('[data-view-count]');
  const dateLabel = counter.querySelector('[data-view-date]');
  // Never add local previews or other deployments to the live site's counts.
  if (window.location.hostname !== 'hawthornhwb.github.io') {
    value.textContent = '本地预览不计数';
    return;
  }

  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  dateLabel.textContent = `${day} · 北京时间`;
  value.textContent = '加载中…';

  // Busuanzi counts each URL independently. A date-prefixed virtual path makes
  // page_pv a daily counter, without depending on the provider's reset timezone.
  // Jekyll supplies the canonical path, so ?v=posts5 and #anchors share a count.
  const url = new URL(counter.dataset.pagePath, window.location.origin);
  url.pathname = `/__daily_views__/${day}${url.pathname}`;
  url.search = '';
  url.hash = '';

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);

  // Same POST protocol as https://cdn.busuanzi.cc/busuanzi/3.6.9/busuanzi.min.js.
  // Send no query strings, referrer, credentials, or third-party JavaScript.
  fetch('https://cdn.busuanzi.cc/api.php', {
    method: 'POST',
    body: JSON.stringify({ url: url.href, referrer: '' }),
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
      const count = data.busuanzi_page_pv;
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Invalid counter response');
      }
      value.textContent = `${count.toLocaleString('zh-CN')} 次`;
    })
    .catch(() => {
      // No automatic retry: an ambiguous response may already have been counted.
      value.textContent = '暂不可用';
    })
    .finally(() => window.clearTimeout(timeout));
})();
