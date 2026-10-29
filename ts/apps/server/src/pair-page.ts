/**
 * 配对页（2026-10-29）：在电脑上打开、用手机扫这一屏。
 *
 * 刻意做成一个独立页而不是塞进调试页：
 * - 每次打开/刷新都会**重新生成一枚码**（旧码立即作废），符合"一次性"语义；
 * - 页面上不含任何长期密钥（只有废了就没用的短码），截图泄露的不是凭据；
 * - 带 `?token=<AGENT_TOKEN>` 时额外显示已配对设备与撤销按钮（不带 token 就只看码）。
 */

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export interface PairPageOptions {
	url: string;
	dataUrl: string;
	machineName: string;
	expiresInSeconds: number;
}

export function pairPage(options: PairPageOptions): string {
	const url = escapeHtml(options.url);
	const name = escapeHtml(options.machineName);

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>配对 · lifediary</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b35; --text:#e8eaed; --dim:#8b93a1; --accent:#6ea8fe; }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; background:var(--bg); color:var(--text);
    font:15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display:flex; flex-direction:column; align-items:center; padding:32px 16px; gap:18px;
  }
  h1 { font-size:16px; font-weight:600; margin:0; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:20px; display:flex; flex-direction:column; align-items:center; gap:14px; }
  img { width:280px; height:280px; image-rendering:pixelated; background:#fff; border-radius:12px; padding:8px; }
  .code { font-size:26px; letter-spacing:.32em; font-variant-numeric:tabular-nums; font-weight:600; }
  .dim { color:var(--dim); font-size:13px; }
  .url { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; color:var(--dim); word-break:break-all; max-width:320px; text-align:center; }
  .row { display:flex; gap:8px; align-items:center; }
  button {
    background:var(--accent); color:#0b1220; border:0; border-radius:10px;
    padding:8px 16px; font:inherit; font-weight:600; cursor:pointer;
  }
  button.ghost { background:transparent; color:var(--dim); border:1px solid var(--line); font-weight:400; }
  #devices { width:100%; max-width:520px; display:flex; flex-direction:column; gap:8px; }
  .device { display:flex; justify-content:space-between; align-items:center; gap:12px; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:10px 14px; font-size:13px; }
</style>
</head>
<body>
  <h1>让手机连上这台电脑</h1>
  <div class="card">
    <img src="${options.dataUrl}" alt="配对二维码" />
    <div class="code">${escapeHtml(extractCode(options.url))}</div>
    <div class="dim">打开 App → 设置 → 扫一扫配对</div>
    <div class="dim">这枚码 ${options.expiresInSeconds} 秒内有效，用一次就作废</div>
    <div class="url">${name} · ${url}</div>
    <div class="row">
      <button onclick="location.reload()">换一枚</button>
      <span class="dim" id="countdown"></span>
    </div>
  </div>
  <div id="devices"></div>
<script>
  var expire = ${options.expiresInSeconds};
  var left = expire;
  var el = document.getElementById('countdown');
  var timer = setInterval(function () {
    left -= 1;
    if (left <= 0) { clearInterval(timer); el.textContent = '已过期，点「换一枚」'; return; }
    el.textContent = left + ' 秒后失效';
  }, 1000);

  // 带 token 打开时才是"管理面"：列出已配对设备并可撤销
  var token = new URLSearchParams(location.search).get('token');
  var box = document.getElementById('devices');
  if (token) {
    fetch('/api/v1/pair/devices', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (devices) {
        if (!devices.length) { box.innerHTML = '<div class="dim">还没有已配对的设备</div>'; return; }
        devices.forEach(function (d) {
          var row = document.createElement('div');
          row.className = 'device';
          var label = document.createElement('span');
          label.textContent = d.name + (d.revokedAt ? '（已撤销）' : '') +
            ' · ' + new Date(d.createdAt).toLocaleString();
          row.appendChild(label);
          if (!d.revokedAt) {
            var btn = document.createElement('button');
            btn.className = 'ghost';
            btn.textContent = '撤销';
            btn.onclick = function () {
              fetch('/api/v1/pair/devices/' + d.id + '/revoke', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token }
              }).then(function () { location.reload(); });
            };
            row.appendChild(btn);
          }
          box.appendChild(row);
        });
      })
      .catch(function () { box.innerHTML = '<div class="dim">设备列表读取失败</div>'; });
  }
</script>
</body>
</html>`;
}

function extractCode(pairUrl: string): string {
	const match = /[?&]code=([^&]+)/.exec(pairUrl);
	return match?.[1] ?? "";
}
