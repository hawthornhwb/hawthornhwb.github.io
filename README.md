# hawthornhwb.github.io
Personal blog powered by GitHub Pages

## 每日访问量

- 首页显示「首页今日访问」，每篇文章显示「本文今日阅读」。这是当前页面的浏览次数（PV），刷新也计数，不是独立访客数。
- 按 `Asia/Shanghai`（北京时间）划分日期，各页面独立计数，从功能上线后开始积累，无法补回历史访问。页面标注本次加载时的统计日期，跨午夜后刷新查看新一天的数据。
- 使用 [不蒜子 busuanzi.cc](https://www.busuanzi.cc/doc.php) 的公共统计服务，无需密钥或额外服务器。只在正式域名 `hawthornhwb.github.io` 下发送计数请求，本地预览不计数。
- 适配器位于 `assets/js/daily-views.js`，沿用官方 3.6.9 脚本的 JSON POST 接口。以 `https://hawthornhwb.github.io/__daily_views__/YYYY-MM-DD/原页面路径` 作为虚拟计数键，读取返回的 `busuanzi_page_pv`，从而实现单页每日统计；这个路径不需要实际生成网页。日期之间相互独立，URL 查询参数和锚点不影响计数。
- 仅向服务发送公开域名与日期化页面路径，不发送查询参数、来源页或 Cookie。服务端仍能看到请求 IP；数据保存在第三方，公共计数仅供大致参考，可能受拦截器、服务中断或人为请求影响。
- 请求超时或响应异常时显示「暂不可用」，不伪造为 0，也不自动重试以免重复计数。未启用 JavaScript 时显示「—」。公共接口若发生变更，需要更新适配器。
- 当前显示当日计数，不包含历史趋势图、后台报表或文章列表中各篇文章的批量计数。

验证统计逻辑：`node --test tests/daily-views.test.cjs`。
