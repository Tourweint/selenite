package main

/*
启动页：服务还没起来的那几秒，窗口里画什么（2026-11-14）。

两副脸，跟主题走（用户拍板）：
  - 浅色主题（paper / white）→ 「冷光」：首页题头那枚水晶，呼吸 + 一道冷光扫过晶面。
  - 深色主题（indigo / black）→ 「夜航」：深靛底、光环、一小段弧绕石头转。

三条纪律：
  1. 不画百分比。慢启动的进度不可知，假进度条走到 99% 卡住比没有更糟。
  2. 只报能对得上的账：已等几秒（本页自己的钟）、探测几次（真探活节奏 probeInterval）、
     走到哪（端口真的被占住那一刻，见 watchSplash 与 main.go 的 loadService）。
  3. 底色、标题栏跟业务页同一套，切页时只有内容区变——原来那张是写死 #0f1115 的，
     纸白主题下就是「黑几秒 → 忽然一片白」。

水晶图走 data URI（go:embed 打在二进制里）：页面由 LoadHTML 以 about:blank 打开，
相对路径没有着落，而 file:// 的 baseURL 又要依赖 exe 旁边有 assets 目录。
数据 URI 让这张页彻底自包含，丢哪儿都能画出来。
*/

import (
	_ "embed"
	"encoding/base64"
	"html"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

//go:embed assets/crystal-mark.png
var splashCrystalPNG []byte

var (
	crystalOnce sync.Once
	crystalURI  string
)

// crystalDataURI 只算一次：118KB 的图转成 base64 有 160KB，不能每次开窗都重算。
func crystalDataURI() string {
	crystalOnce.Do(func() {
		crystalURI = "data:image/png;base64," + base64.StdEncoding.EncodeToString(splashCrystalPNG)
	})
	return crystalURI
}

// slowAfter 是「该解释一句了」的门槛：首次启动编 tsx 通常 6–12s，
// 9s 还没通，人已经开始怀疑是不是死了。
const slowAfter = 9 * time.Second

// fill 把模板里的占位换成值。用 ReplaceAll 而不是 Sprintf：
// CSS 里全是 %，走 Sprintf 就得把每一处都写成 %%，改一次错一次。
func fill(tmpl string, repl map[string]string) string {
	out := tmpl
	for k, v := range repl {
		out = strings.ReplaceAll(out, k, v)
	}
	return out
}

// connectingPage 按壳记住的主题挑一副脸。
// 签名保持不变：main.go 只认这一个入口。
func connectingPage(base string) string {
	repl := map[string]string{
		"{{CRYSTAL}}":  crystalDataURI(),
		"{{PROBE_MS}}": strconv.Itoa(int(probeInterval / time.Millisecond)),
		"{{SLOW_MS}}":  strconv.Itoa(int(slowAfter / time.Millisecond)),
	}
	if themeIsDark(savedTheme()) {
		return fill(nightPage, repl)
	}
	return fill(dayPage, repl)
}

// offlinePage 说清楚三件事：连的是谁、为什么没连上、现在该做什么。
// 排版与启动页同一套（同一个标题栏、同一个字级），两张脸是一套东西。
func offlinePage(base string, err error) string {
	repl := map[string]string{
		"{{BASE}}": html.EscapeString(base),
		"{{ERR}}":  html.EscapeString(err.Error()),
		"{{FACE}}": "day",
	}
	if themeIsDark(savedTheme()) {
		repl["{{FACE}}"] = "night"
	}
	return fill(offlineTmpl, repl)
}

// ── 页面状态推送 ──────────────────────────────────────────

// splashPhase 把壳知道的事实推给页面（例如「端口已经被占住了」）。
// 从任意 goroutine 调都行：LoadHTML / Eval 走的是同一条 ui 车道。
func splashPhase(w *mygo.Window, text string) {
	if w == nil || w.IsDestroyed() {
		return
	}
	_, _ = w.Page().Eval("window.splash && window.splash.phase(" + strconv.Quote(text) + ")")
}

// watchSplash 盯「端口有没有被占住」：node 编译完、listen() 成功那一刻，
// 是慢启动里唯一一个真的能观测到、又能说给人听的中间信号。
// 报一次就收工；返回 stop 让调用方随时收摊。
func watchSplash(w *mygo.Window, base string) (stop func()) {
	port := servicePort(base)
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(400 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if listening(port) {
					splashPhase(w, "进程起来了，等它就绪")
					return
				}
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// ── 模板 ────────────────────────────────────────────────
//
// 两副脸的公共骨架：40px 自绘标题栏 + 一句状态 + 一行事实。
// 差别只在中间那块（水晶怎么摆）与配色。

const splashCaret = `<span class="caret" aria-hidden="true"></span>`

// 两副脸共用的状态机。真实事件只有两件：页面自己数秒、壳推一句。
// 其余文字都从这两件派出来，不编第三件。
const splashScript = `<script>
(function () {
  var PROBE_MS = {{PROBE_MS}};
  var SLOW_MS = {{SLOW_MS}};

  var textEl = document.getElementById("status-text");
  var metaEl = document.getElementById("meta");
  var slowEl = document.getElementById("slow");
  var hintEl = document.getElementById("hint");
  var t0 = performance.now();
  var pushed = "";     // 壳推来的那句（端口真的被占住时）
  var shown = "";

  // 换句就是换句：不做淡入淡出。这行只有一句话，170ms 的交叉淡入人根本看不见，
  // 却把「文字停在半透明」变成一个随时会踩的坑（定时器不回调就卡在灰字上）。
  function paint(text) {
    if (text === shown) return;
    shown = text;
    textEl.textContent = text;
  }

  function tick() {
    var ms = performance.now() - t0;
    var sec = ms / 1000;

    var slow = ms >= SLOW_MS;
    paint(pushed || (slow ? "再等一会儿" : "正在唤醒服务"));
    if (slow) {
      slowEl.classList.add("on");
      hintEl.textContent = "较慢";
    }

    var probes = 1 + Math.floor(ms / PROBE_MS);
    metaEl.innerHTML = "探测 <b>" + probes + "</b> 次 · 已等 <b>" + sec.toFixed(1) + "</b>s";
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // 壳调用：window.splash.phase("进程起来了，等它就绪")
  window.splash = {
    phase: function (text) { pushed = String(text || ""); }
  };
})();
</script>`

// dayPage：浅色主题。
const dayPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Selenite</title>
<style>
:root {
  color-scheme: light;
  --bg: #fdf9f2;
  --backdrop: #f1ebe0;
  --text: #2e2b3a;
  --text-2: #6e6b7e;
  --text-3: #9a97a5;
  --primary: #3e4a8c;
  --gem: url("{{CRYSTAL}}");
  --serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", "STSong", "SimSun", "Microsoft YaHei", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font-family: var(--serif); overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

/* 标题栏：跟业务页同一个 40px 条、同一个底色、同一个品牌字位 */
.bar {
  position: fixed; inset: 0 0 auto 0; height: 40px;
  display: flex; align-items: center;
  padding: 0 16px 0 14px;
  background: var(--backdrop);
  user-select: none; -webkit-app-region: drag;
}
.brand { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.hint {
  margin-left: auto; font-family: var(--mono); font-size: 11px;
  color: var(--text-3);
}

.stage { position: fixed; inset: 40px 0 0; display: grid; place-items: center; padding: 20px; }
.lock { display: flex; flex-direction: column; align-items: center; }

.gem-wrap { position: relative; display: grid; place-items: center; }
/* 石头背后那团光：radial-gradient 自带衰减，不用再叠一层 blur 滤镜 */
.halo {
  position: absolute; width: clamp(240px, 34vh, 380px); height: clamp(240px, 34vh, 380px);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(62, 74, 140, .075), rgba(62, 74, 140, .035) 46%, transparent 70%);
  animation: breathe 3.6s cubic-bezier(.4, 0, .2, 1) infinite;
}
@keyframes breathe {
  0%, 100% { opacity: .55; transform: scale(.96); }
  50%      { opacity: 1;   transform: scale(1.04); }
}
/* 纸面上的一点落影：石头不是浮着的，它坐在纸上 */
.shadow {
  position: absolute; bottom: 2px; width: clamp(50px, 10vh, 78px); height: 8px;
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(74, 70, 90, .20), transparent 72%);
  filter: blur(2px);
}
.gem {
  position: relative; display: block;
  height: clamp(112px, 21vh, 172px); width: auto;
  /* 只留贴纸面的一点点暗，不要大范围柔光：纸面上那层柔光会读成一块灰云，
     而石头是躺在纸上，不是悬在半空。 */
  filter: drop-shadow(0 3px 6px rgba(74, 70, 90, .07));
}
/* 一道冷光扫过晶面：遮罩就是石头本身，高光只落在晶体上 */
.sheen {
  position: absolute; inset: 0;
  background: linear-gradient(105deg,
    transparent 34%, rgba(255, 255, 255, .92) 45%,
    rgba(196, 210, 255, .55) 52%, transparent 66%);
  background-size: 240% 100%; background-position: 190% 0;
  -webkit-mask-image: var(--gem); mask-image: var(--gem);
  -webkit-mask-size: contain; mask-size: contain;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  mix-blend-mode: screen; opacity: .8;
  animation: sweep 4.8s cubic-bezier(.45, 0, .3, 1) infinite;
}
@keyframes sweep {
  0%        { background-position: 190% 0; }
  46%, 100% { background-position: -90% 0; }
}

.word {
  margin-top: 26px; font-size: 10.5px; letter-spacing: .38em;
  color: var(--text-3); text-indent: .38em;
}

.status {
  margin-top: 16px;
  font-size: clamp(15px, 1.9vh + 6px, 18px);
  line-height: 1.5; letter-spacing: .05em;
  color: var(--text);
}

/* 句尾那根竖条：一呼一吸的短线比三个跳动的点安静 */
.caret {
  display: inline-block; width: 1px; height: 1em; margin-left: 3px;
  vertical-align: -.12em;
  background: var(--primary); opacity: .55;
  animation: blink 1.9s steps(2, start) infinite;
}
@keyframes blink { 50% { opacity: .08; } }

/* 主线：不确定进度的墨线，不冒充百分比 */
.rule {
  position: relative; margin-top: 24px;
  width: clamp(160px, 22vw, 230px); height: 1px;
  background: rgba(46, 43, 58, .18); overflow: hidden;
}
.rule i {
  position: absolute; top: 0; left: 0; height: 1px; width: 36%;
  background: linear-gradient(90deg, transparent, var(--primary) 45%, var(--primary) 60%, transparent);
  opacity: .85;
  animation: travel 1.9s cubic-bezier(.55, 0, .45, 1) infinite;
}
@keyframes travel {
  0%   { transform: translateX(-105%); }
  100% { transform: translateX(345%); }
}

.meta {
  margin-top: 18px;
  font-family: var(--mono); font-size: 11.5px; letter-spacing: .02em;
  color: var(--text-3); font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.meta b { font-weight: 400; color: var(--text-2); }

.slow {
  margin-top: 10px; max-width: 34em; text-align: center;
  font-size: 12.5px; line-height: 1.7; color: var(--text-2);
  opacity: 0; transform: translateY(-2px);
  transition: opacity .3s ease, transform .3s ease;
}
.slow.on { opacity: 1; transform: none; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
  .halo, .sheen, .caret, .rule i { animation: none; }
  .sheen { opacity: .35; }
}
</style>
</head>
<body>
  <div class="bar">
    <span class="brand">Selenite</span>
    <span class="hint" id="hint">启动中</span>
  </div>

  <div class="stage">
    <div class="lock">
      <div class="gem-wrap">
        <div class="halo"></div>
        <div class="shadow" aria-hidden="true"></div>
        <img class="gem" src="{{CRYSTAL}}" alt="" aria-hidden="true">
        <div class="sheen" aria-hidden="true"></div>
      </div>

      <div class="word">SELENITE</div>

      <p class="status"><span id="status-text">正在唤醒服务</span>` + splashCaret + `</p>
      <div class="rule"><i></i></div>
      <div class="meta" id="meta">探测 <b>1</b> 次 · 已等 <b>0.0</b>s</div>
      <p class="slow" id="slow">第一次启动要先编译 TypeScript，会久一些；它还在工作，不用关窗口。</p>
    </div>
  </div>
` + splashScript + `
</body>
</html>`

// nightPage：深色主题（indigo / black）。
const nightPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Selenite</title>
<style>
:root {
  color-scheme: dark;
  --bg: #12141d;
  --backdrop: #0d0f16;
  --text: #e7e9f2;
  --text-2: #a5a9ba;
  --text-3: #6d7183;
  --primary: #8b97ea;
  --gem: url("{{CRYSTAL}}");
  --serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", "STSong", "SimSun", "Microsoft YaHei", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background-color: var(--bg); color: var(--text);
  font-family: var(--serif); overflow: hidden;
  -webkit-font-smoothing: antialiased;
  /* 舞台的底：中间偏上一点冷光，四角压暗，像一盏只照到石头的顶灯。
     写进 body 的 background-image 而不是叠一个 fixed 伪元素——伪元素是定位层，
     会盖在正文上面，把状态字压成灰的（第一版就是这么错的）。 */
  background-image:
    radial-gradient(58% 46% at 50% 40%, rgba(104, 118, 200, .16), transparent 70%),
    radial-gradient(120% 120% at 50% 50%, transparent 40%, rgba(5, 6, 12, .55) 100%);
}

.bar {
  position: fixed; inset: 0 0 auto 0; height: 40px;
  display: flex; align-items: center;
  padding: 0 16px 0 14px;
  background: var(--backdrop);
  user-select: none; -webkit-app-region: drag;
}
.brand { font-size: 13px; font-weight: 600; color: rgba(231, 233, 242, .78); }
.hint { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--text-3); }

.stage { position: fixed; inset: 40px 0 0; display: grid; place-items: center; padding: 20px; }
.lock { display: flex; flex-direction: column; align-items: center; }

.field {
  position: relative;
  width: clamp(230px, 30vh, 300px); height: clamp(230px, 30vh, 300px);
  display: grid; place-items: center;
}
/* 两道极淡的同心环，错开相位呼吸——是「还在动」的暗示，不是装饰 */
.ring { position: absolute; border-radius: 50%; border: 1px solid rgba(139, 151, 234, .16); }
.ring.r1 { width: 74%; height: 74%; border-color: rgba(139, 151, 234, .22); animation: ping 4.2s cubic-bezier(.25, 0, .25, 1) infinite; }
.ring.r2 { width: 96%; height: 96%; border-color: rgba(139, 151, 234, .08); animation: ping 4.2s 1.4s cubic-bezier(.25, 0, .25, 1) infinite; }
@keyframes ping {
  0%   { opacity: .15; transform: scale(.94); }
  55%  { opacity: .85; transform: scale(1.02); }
  100% { opacity: .12; transform: scale(1.06); }
}
/* 绕石头转的一小段弧：只有 72° 长，转一圈 3.4s。起始角写在基础样式里，
   动画被关掉时（reduced-motion）也停在左上，不会像一圈断掉的线头挂在右下 */
.arc { position: absolute; width: 100%; height: 100%; }
.arc circle {
  fill: none; stroke: var(--primary); stroke-width: 1.25;
  stroke-opacity: .5; stroke-linecap: round;
  stroke-dasharray: 96 900;
  transform-origin: 50% 50%; transform: rotate(-38deg);
  animation: orbit 3.4s linear infinite;
}
@keyframes orbit { from { transform: rotate(-38deg); } to { transform: rotate(322deg); } }

.gem-wrap { position: relative; display: grid; place-items: center; }
/* 冷光雾：石头是浅色物体，暗底上容易被读成一张贴纸，先在它后面铺一层白光 */
.bloom {
  position: absolute; width: clamp(190px, 26vh, 260px); height: clamp(190px, 26vh, 260px);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(198, 210, 255, .20), rgba(139, 151, 234, .10) 38%, transparent 68%);
  animation: bloom 4.2s cubic-bezier(.4, 0, .2, 1) infinite;
}
@keyframes bloom {
  0%, 100% { opacity: .55; transform: scale(.97); }
  50%      { opacity: 1;   transform: scale(1.04); }
}
.gem {
  position: relative; display: block;
  height: clamp(120px, 22vh, 176px); width: auto;
  filter: drop-shadow(0 0 40px rgba(168, 184, 255, .42))
          drop-shadow(0 10px 28px rgba(0, 0, 0, .55));
}
/* 倒影：玻璃桌上的那一点回光，裁掉下半截只留 26px */
.mirror {
  position: absolute; top: 100%; margin-top: 4px;
  height: 26px; width: clamp(72px, 13.2vh, 106px); overflow: hidden;
}
.mirror i {
  display: block; width: 100%; height: clamp(120px, 22vh, 176px);
  background: var(--gem) center top / contain no-repeat;
  transform: scaleY(-1);
  opacity: .22; filter: blur(3px);
  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, .8), transparent 62%);
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, .8), transparent 62%);
}
/* 冷光从左上扫过晶面，遮罩 = 石头本身 */
.sheen {
  position: absolute; inset: 0;
  background: linear-gradient(104deg,
    transparent 34%, rgba(255, 255, 255, .95) 44%,
    rgba(168, 184, 255, .6) 52%, transparent 66%);
  background-size: 240% 100%; background-position: 190% 0;
  -webkit-mask-image: var(--gem); mask-image: var(--gem);
  -webkit-mask-size: contain; mask-size: contain;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  mix-blend-mode: screen; opacity: .9;
  animation: sweep 4.4s cubic-bezier(.45, 0, .3, 1) infinite;
}
@keyframes sweep {
  0%        { background-position: 190% 0; }
  46%, 100% { background-position: -90% 0; }
}

.status {
  margin-top: 30px;
  font-size: clamp(16px, 2vh + 7px, 18px); letter-spacing: .07em;
  /* 深色底上宋体的细笔锋会被抗锯齿吃掉，读起来像灰字；
     给足白 + 一圈极淡的冷光，才跟标题栏那个白色品牌字同档。 */
  color: #edeff8;
  text-shadow: 0 0 20px rgba(139, 151, 234, .22);
}


.meta {
  margin-top: 14px;
  font-family: var(--mono); font-size: 11.5px; color: var(--text-3);
  letter-spacing: .03em; font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.meta b { font-weight: 400; color: var(--text-2); }

.slow {
  margin-top: 12px; max-width: 36em; text-align: center;
  font-size: 12.5px; line-height: 1.75; color: var(--text-3);
  opacity: 0; transform: translateY(-2px);
  transition: opacity .3s ease, transform .3s ease;
}
.slow.on { opacity: 1; transform: none; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
  .ring, .arc circle, .bloom, .sheen { animation: none; }
  .arc circle { stroke-opacity: .35; }
}
</style>
</head>
<body>
  <div class="bar">
    <span class="brand">Selenite</span>
    <span class="hint" id="hint">启动中</span>
  </div>

  <div class="stage">
    <div class="lock">
      <div class="field">
        <div class="ring r1"></div>
        <div class="ring r2"></div>
        <svg class="arc" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="96"/></svg>
        <div class="gem-wrap">
          <div class="bloom"></div>
          <img class="gem" src="{{CRYSTAL}}" alt="" aria-hidden="true">
          <div class="sheen" aria-hidden="true"></div>
          <div class="mirror" aria-hidden="true"><i></i></div>
        </div>
      </div>

      <p class="status"><span id="status-text">正在唤醒服务</span>` + splashCaret + `</p>
      <div class="meta" id="meta">探测 <b>1</b> 次 · 已等 <b>0.0</b>s</div>
      <p class="slow" id="slow">第一次启动要先编译 TypeScript，会久一些；它还在工作，不用关窗口。</p>
    </div>
  </div>
` + splashScript + `
</body>
</html>`

// offlineTmpl：连不上服务。{{FACE}} 是 day / night，用来选同一套配色。
const offlineTmpl = `<!doctype html>
<html lang="zh-CN" data-face="{{FACE}}">
<head>
<meta charset="utf-8">
<title>Selenite</title>
<style>
:root {
  --bg: #fdf9f2; --backdrop: #f1ebe0;
  --text: #2e2b3a; --text-2: #6e6b7e; --text-3: #9a97a5;
  --card: #f6f1e7; --line: rgba(46, 43, 58, .14);
  --primary: #3e4a8c;
  color-scheme: light;
}
html[data-face="night"] {
  --bg: #12141d; --backdrop: #0d0f16;
  --text: #e7e9f2; --text-2: #a5a9ba; --text-3: #6d7183;
  --card: #191c27; --line: rgba(255, 255, 255, .10);
  --primary: #8b97ea;
  color-scheme: dark;
}
:root {
  --serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", "STSong", "SimSun", "Microsoft YaHei", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font-family: var(--serif); overflow: auto;
  -webkit-font-smoothing: antialiased;
}
.bar {
  position: fixed; inset: 0 0 auto 0; height: 40px;
  display: flex; align-items: center;
  padding: 0 16px 0 14px;
  background: var(--backdrop);
  user-select: none; -webkit-app-region: drag;
}
.brand { font-size: 13px; font-weight: 600; }
.hint { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--text-3); }

/* 顶对齐而不是居中：这段内容是给人读的说明，窗口矮的时候居中会把开头
   推到可视区上面去，overflow 也滚不回来。 */
.stage {
  padding: clamp(48px, 9vh, 96px) 24px 48px;
}
.box { width: min(100%, 560px); margin: 0 auto; }
h1 { font-size: 19px; font-weight: 600; margin-bottom: 10px; letter-spacing: .02em; }
p { font-size: 13.5px; line-height: 1.8; color: var(--text-2); }
pre {
  margin: 14px 0 0; padding: 12px 14px;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.7;
  color: var(--text); background: var(--card);
  border: 1px solid var(--line); border-radius: 10px;
  overflow-x: auto; white-space: pre-wrap;
}
.muted { color: var(--text-3); }
.step { margin-top: 18px; }
</style>
</head>
<body>
  <div class="bar">
    <span class="brand">Selenite</span>
    <span class="hint">没连上</span>
  </div>

  <div class="stage">
    <div class="box">
      <h1>连不上服务</h1>
      <p>壳只是客户端，Agent 跑在服务里。这台机器上的服务没起来。</p>
      <pre>{{BASE}}
{{ERR}}</pre>
      <div class="step">
        <p class="muted">在 ts/ 下起服务，然后从托盘菜单点「重新连接」：</p>
        <pre>cd ts
pnpm dev</pre>
      </div>
    </div>
  </div>
</body>
</html>`
