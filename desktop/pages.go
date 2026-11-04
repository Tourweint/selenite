package main

import (
	"fmt"
	"html"
)

// 两页本地兜底页面。它们由壳自己给出，说明「服务没起来」这件事，
// 而不是让用户对着 WebView 的默认错误页猜。

const pageStyle = `<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0f1115; color: #e8eaed;
    font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display: grid; place-content: center; padding: 32px;
  }
  .box { max-width: 560px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; letter-spacing: .01em; }
  .dim { color: #8b93a1; }
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 13px; background: #171a21; border: 1px solid #262b35;
    border-radius: 6px; padding: 1px 6px;
  }
  pre {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 13px; background: #171a21; border: 1px solid #262b35;
    border-radius: 10px; padding: 12px 14px; overflow-x: auto; margin: 14px 0 0;
  }
  .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #6ea8fe; margin-right: 8px; animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: .25; } }
</style>`

func connectingPage(base string) string {
	return fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>lifediary</title>%s</head>
<body><div class="box">
  <h1><span class="dot"></span>正在连接 lifediary 服务</h1>
  <p class="dim">%s</p>
</div></body></html>`, pageStyle, html.EscapeString(base))
}

// offlinePage 说清楚三件事：连的是谁、为什么没连上、现在该做什么。
func offlinePage(base string, err error) string {
	return fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>lifediary</title>%s</head>
<body><div class="box">
  <h1>连不上服务</h1>
  <p class="dim">壳只是客户端，Agent 跑在服务里。服务没在这台机器上跑起来。</p>
  <pre>%s
%s</pre>
  <p class="dim">在 <code>ts/</code> 下起服务，然后从托盘菜单点「重新连接」：</p>
  <pre>cd ts
pnpm dev</pre>
</div></body></html>`, pageStyle, html.EscapeString(base), html.EscapeString(err.Error()))
}
