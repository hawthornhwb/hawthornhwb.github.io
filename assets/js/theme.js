(function () {
  var root = document.documentElement;
  var toggle = document.querySelector('.theme-toggle');
  if (!toggle) return;
  function syncToggle() {
    var isDark = root.dataset.theme === 'dark';
    toggle.setAttribute('aria-label', isDark ? '切换到浅色主题' : '切换到深色主题');
    toggle.querySelector('span').textContent = isDark ? '☀' : '☾';
  }
  toggle.addEventListener('click', function () {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('blog-theme-v2', root.dataset.theme); } catch (e) {}
    syncToggle();
  });
  syncToggle();
}());
