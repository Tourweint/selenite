/**
 * M0 的链路验证页。它不是产品界面，只用来在没有任何客户端的情况下
 * 肉眼确认"发一句 → 流式吐字 → 正常收尾"。真客户端是 apps/app。
 *
 * 这里手写了一份极简 SSE 解析，没有复用 shared：浏览器加载不了 TS 源码，
 * 而为一个调试页引入打包链路不值得。故意的重复。
 */
export const debugPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>lifediary · M0 链路验证</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --line: #262b35;
    --text: #e8eaed;
    --dim: #8b93a1;
    --accent: #6ea8fe;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex;
    justify-content: center;
    padding: 24px 16px;
  }
  .wrap { width: 100%; max-width: 720px; display: flex; flex-direction: column; min-height: 0; }
  header { display: flex; align-items: baseline; gap: 10px; padding: 0 4px 14px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .01em; }
  .tag {
    font-size: 11px; color: var(--dim); border: 1px solid var(--line);
    border-radius: 999px; padding: 1px 8px;
  }
  .log {
    flex: 1; overflow-y: auto; background: var(--panel);
    border: 1px solid var(--line); border-radius: 14px;
    padding: 16px; display: flex; flex-direction: column; gap: 12px;
    min-height: 320px; max-height: calc(100vh - 190px);
  }
  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .bubble {
    max-width: 82%; padding: 9px 13px; border-radius: 12px;
    white-space: pre-wrap; word-break: break-word;
  }
  .user .bubble { background: #24304a; }
  .bot .bubble { background: #1e222b; border: 1px solid var(--line); }
  .meta { font-size: 11px; color: var(--dim); margin-top: 6px; }
  .caret { display: inline-block; width: 7px; height: 1em; background: var(--accent);
    vertical-align: -2px; animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  form { display: flex; gap: 8px; padding-top: 12px; }
  input {
    flex: 1; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px;
    font: inherit; outline: none;
  }
  input:focus { border-color: var(--accent); }
  button {
    background: var(--accent); color: #0b1220; border: 0; border-radius: 10px;
    padding: 0 18px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .45; cursor: not-allowed; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>lifediary</h1>
      <span class="tag">M0 · 链路验证</span>
    </header>
    <div class="log" id="log"></div>
    <form id="form">
      <input id="input" placeholder="说点什么…" autocomplete="off" />
      <button id="send" type="submit">发送</button>
    </form>
  </div>
<script>
  var log = document.getElementById('log');
  var form = document.getElementById('form');
  var input = document.getElementById('input');
  var send = document.getElementById('send');
  var history = [];
  // 令牌从 URL 带进来：http://127.0.0.1:8082/?token=xxx
  var token = new URLSearchParams(location.search).get('token') || '';
  // 会话 id 由服务端在首轮返回，之后一直带着它续话
  var conversationId = '';

  function addMessage(role, text) {
    var row = document.createElement('div');
    row.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send.disabled = true;

    addMessage('user', text);
    history.push({ role: 'user', content: text });

    var bubble = addMessage('assistant', '');
    var caret = document.createElement('span');
    caret.className = 'caret';
    bubble.appendChild(caret);
    var acc = '';
    var startedAt = performance.now();

    try {
      var res = await fetch('/api/v1/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          conversationId: conversationId || undefined,
          messages: history
        })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()));

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        var split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          var frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          var data = frame.split('\n')
            .filter(function (l) { return l.indexOf('data:') === 0; })
            .map(function (l) { return l.slice(5).trim(); })
            .join('\n');
          if (!data) continue;

          var ev = JSON.parse(data);
          if (ev.type === 'start') {
            conversationId = ev.conversationId;
          } else if (ev.type === 'delta') {
            acc += ev.text;
            bubble.textContent = acc;
            bubble.appendChild(caret);
            log.scrollTop = log.scrollHeight;
          } else if (ev.type === 'error') {
            acc += '\n[错误] ' + ev.message;
            bubble.textContent = acc;
          } else if (ev.type === 'done') {
            caret.remove();
            var meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = 'finishReason=' + ev.finishReason +
              ' · ' + Math.round(performance.now() - startedAt) + 'ms';
            bubble.parentElement.appendChild(meta);
          }
        }
      }
      history.push({ role: 'assistant', content: acc });
    } catch (err) {
      bubble.textContent = '请求失败：' + err.message;
    } finally {
      send.disabled = false;
      input.focus();
    }
  });

  input.focus();
</script>
</body>
</html>`;
