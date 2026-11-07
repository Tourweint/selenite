// lifediary 桌面壳。
//
// 它只做两件事：把服务活着、把服务给的界面显示出来。
// Agent、记忆、会话全在 @lifediary/server 里（Node，:39847），壳不碰业务。
//
//	go run .
//
// 为什么加载 http://127.0.0.1:39847/ 而不是内嵌前端：P0 就是要验证
// 「WebView2 里能不能跑通 SSE」。内嵌前端是 P1 之后的事（见
// docs/设计方案/2026-11-03-桌面壳（MyGo）.md）。
package main

import (
	_ "embed"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// trayIconPNG 是托盘图标：64x64 透石膏晶体，透明底。
// 旧版是代码里画的一个蓝圆（占位），现在换成正式品牌图标。
//
//go:embed assets/icon-tray.png
var trayIconPNG []byte

const (
	defaultBaseURL = "http://127.0.0.1:39847"
	probeTimeout   = 3 * time.Second
	probeInterval  = 250 * time.Millisecond
)

// win 是唯一的窗口；关窗只是隐藏，所以它可能长期存在但不可见。
var win *mygo.Window

// quitting 只在主线程读写（OnBeforeQuit 与 OnClose 都在主线程触发）。
// 它用来区分「用户关窗 = 只隐藏」和「应用退出 = 必须真的关窗」：
// 退出流程也会走 OnClose，若无条件 PreventDefault，App.Quit 会被自己取消。
var quitting bool

// tray 需要留引用：退出前显式销毁，避免任务栏残留图标。
var tray *mygo.Tray

func baseURL() string {
	if v := strings.TrimSpace(os.Getenv("LIFEDIARY_BASE_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultBaseURL
}

// serviceOrigin 把 baseURL 归一成 origin（scheme://host[:port]）。
//
// MyGo 的信任校验按 origin 比对（scheme 与 host 都转小写），端口来自
// LIFEDIARY_BASE_URL 或默认值，所以这里跟着 baseURL 算，不写死端口。
// 页面是自绘标题栏，三键走 window.mygo.window，生产构建下必须显式授信。
func serviceOrigin(base string) string {
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return base
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

// healthy 探一次 /healthz。服务没起时这里会很快失败（连接被拒）。
func healthy(base string) bool {
	c := &http.Client{Timeout: 800 * time.Millisecond}
	resp, err := c.Get(base + "/healthz")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// waitHealthy 在 deadline 内反复探。壳自己不起服务：服务是独立的，
// 可能由 pnpm dev 起着，也可能是别的会话留下的（见方案 D3）。
func waitHealthy(base string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if healthy(base) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s 没有响应 /healthz", base)
		}
		time.Sleep(probeInterval)
	}
}

// serverDir 找服务目录：先看环境变量，再看壳所在目录的兄弟目录。
func serverDir() string {
	if dir := strings.TrimSpace(os.Getenv("LIFEDIARY_SERVER_DIR")); dir != "" {
		return dir
	}
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "..", "ts", "apps", "server"))
	}
	candidates = append(candidates, filepath.Join("..", "ts", "apps", "server"))
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, "src", "index.ts")); err == nil {
			return dir
		}
	}
	return ""
}

/*
ensureService 已于 2026-11-07 退役，起停统一走 `runtime`（见 runtime.go）。

退役的原因不是"想重构"，而是这个函数**没有嘴**：它只会拉起、不会记住、也不会停。
设置页要能停服务时，光有"探不到就拉"是不够的——还得知道"这次是用户让我别拉"，
以及"该杀哪个 PID"。这些状态只能落在一个地方，于是收进了 runtimeCtl。
*/

// Shell 是暴露给页面的一小组原生能力（window.mygo.call）。
//
// 服务页面不是 MyGo 的「自家页面」，但它的 origin 在 WindowOptions.Page.TrustedOrigins
// 里，所以可以调这些方法；业务仍全部走 HTTP，这里只补浏览器办不到的事。
type Shell struct{}

// SelectDirectory 弹系统目录选择器，返回选中的绝对路径。
// 用户取消时返回空串（前端按这个约定退化：保留输入框原值）。
func (Shell) SelectDirectory() (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:            win,
		Title:             "选择目录",
		Directory:         true,
		CreateDirectories: true,
	})
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", nil
	}
	return paths[0], nil
}

// shellBindingsEnabled 是 F3.5 的回滚开关：设为 off 就不挂 Shell，
// 前端调用会失败并退化成手输路径（和浏览器里一样）。
func shellBindingsEnabled() bool {
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("LIFEDIARY_SHELL_BINDINGS")), "off")
}

// ── 运行时起停（2026-11-07）────────────────────────────────
//
// 设置页「服务 → 运行时」那张卡用这四个方法。为什么必须走壳：
// 页面要停的就是它自己的后端，停下去之后所有 fetch 都会失败——连"现在是什么状态"
// 都问不出来。只有壳知道 PID、知道服务目录、知道这次是不是用户让它停的。
//
// 注意返回的是 (RuntimeStatus, error)：MyGo 的 Bind 会把 error 映射成前端 Promise 的
// reject，所以"没停成"能和"停成了"区分开，前端不能把失败当成已停。

// RuntimeStatus 读一次当前状态（不看缓存，现探）。
func (Shell) RuntimeStatus() (RuntimeStatus, error) {
	return runtime.Status(), nil
}

// StopRuntime 停掉服务。幂等：本来没在跑也返回 stopped。
func (Shell) StopRuntime() (RuntimeStatus, error) {
	return runtime.Stop()
}

// StartRuntime 拉起服务；起没起来以 /healthz 为准，最多等 25 秒。
func (Shell) StartRuntime() (RuntimeStatus, error) {
	return runtime.Start()
}

// RestartRuntime 先停再起。正在跑的那一轮对话会中断（历史不丢）。
func (Shell) RestartRuntime() (RuntimeStatus, error) {
	return runtime.Restart()
}

// loadService 把窗口指向服务。业务全走 HTTP，桥接只用来补原生能力
// （见 Shell，绑定在 main 里 App.Run 之前完成）。
func loadService(w *mygo.Window) {
	base := baseURL()
	w.Page().LoadHTML(connectingPage(base), "")

	go func() {
		// 自己拉起服务时要多等一会儿：node 起 tsx 再连库，几秒钟很正常
		budget := probeTimeout
		if !healthy(base) {
			// 用户主动停过就别再拉（2026-11-07）：否则点了"停止"再点托盘"重新连接"，
			// 服务又自己回来了，那个开关等于没有。runtime.Ensure 内部认这个闩。
			runtime.Ensure()
			budget = 25 * time.Second
		}
		if err := waitHealthy(base, budget); err != nil {
			// 页面 API 可以从任意 goroutine 调。
			w.Page().LoadHTML(offlinePage(base, err), "")
			return
		}
		w.Page().LoadURL(pageURL(base))
	}()
}

// pageURL 带上令牌。
//
// 服务配了 AGENT_TOKEN 时，所有 /api/v1/* 都要 Bearer —— 页面拿不到就会
// 静默 403（"发了没反应"）。壳从自己的环境里取一次带给页面，省掉手粘。
// 放在 fragment 里：它不会进 Referer，也不会发到服务端；页面的 JS 读一次
// 就存进 localStorage，然后把 URL 清干净。
func pageURL(base string) string {
	link := base + "/"

	// 深链：直接开某一页（`LIFEDIARY_VIEW=settings`），以后托盘「设置」也走这里
	if view := strings.TrimSpace(os.Getenv("LIFEDIARY_VIEW")); view != "" {
		link += "?view=" + url.QueryEscape(view)
	}

	token := strings.TrimSpace(os.Getenv("AGENT_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(os.Getenv("LIFEDIARY_TOKEN"))
	}
	if token != "" {
		link += "#token=" + url.QueryEscape(token)
	}
	return link
}

/*
windowGeometry：按主屏工作区比例定初始窗口。

占主屏工作区 80% × 88%，在工作区内居中；工作区已扣除任务栏，
所以不会压到任务栏。窗口尺寸和最小尺寸都会被限制在工作区内，
小屏上也不会溢出。屏幕信息拿不到时退回 1100×780。
*/
func windowGeometry() (x, y, width, height, minWidth, minHeight int) {
	display := mygo.Screen.PrimaryDisplay()
	wa := display.WorkArea
	if wa.Width <= 0 || wa.Height <= 0 {
		wa = display.Bounds
	}
	if wa.Width <= 0 || wa.Height <= 0 {
		return 0, 0, 1100, 780, 720, 520
	}

	// 分辨率越高，窗口越大；80% / 88% 明显大于原来的 55% / 70%。
	width = wa.Width * 80 / 100
	height = wa.Height * 88 / 100
	minWidth = min(720, wa.Width)
	minHeight = min(520, wa.Height)
	width = max(width, minWidth)
	height = max(height, minHeight)
	width = min(width, wa.Width)
	height = min(height, wa.Height)
	x = wa.X + (wa.Width-width)/2
	y = wa.Y + (wa.Height-height)/2
	return x, y, width, height, minWidth, minHeight
}

// toggleWindow 供托盘菜单使用：可见就隐藏，否则唤起。
func toggleWindow() {
	if win != nil && !win.IsDestroyed() && win.IsVisible() {
		win.Hide()
		return
	}
	showWindow()
}

func showWindow() {
	if win != nil && !win.IsDestroyed() {
		// 最小化时 Show() 的 SW_SHOW 不会还原窗口（只把窗口摆到前台），
		// 所以先 Restore（SW_RESTORE）再 Show。窗口已在前台时这两步都是
		// 空操作，托盘连点不会闪。
		if win.IsMinimized() {
			win.Restore()
		}
		win.Show()
		win.Focus()
		return
	}
	x, y, width, height, minWidth, minHeight := windowGeometry()
	// 有上次的几何存档就用存档（批次二）；比例算法只做首次/存档坏了的兜底
	st := loadWindowState()
	if st != nil {
		x, y, width, height = st.X, st.Y, st.Width, st.Height
	}

	w := mygo.NewWindow(mygo.WindowOptions{
		Title:     "Selenite",
		X:         x,
		Y:         y,
		Width:     width,
		Height:    height,
		MinWidth:  minWidth,
		MinHeight: minHeight,
		// 自绘标题栏：隐藏系统标题栏，系统三键也不画，页面自己画。
		// 窗口仍保留阴影、圆角、四边（含顶边）缩放。
		TitleBarStyle:     mygo.TitleBarHidden,
		HideWindowButtons: true,
		// 服务页面不是 MyGo 的「自家页面」，生产构建下默认拿不到
		// window.mygo；显式授信它自己的 origin，三键与拖动才能用。
		Page: mygo.PageOptions{
			TrustedOrigins: []string{serviceOrigin(baseURL())},
			// 页面用 window.isMyGo() 判断「是否在壳里」来决定显不显示
			// 窗口三键。MyGo 只有 mygo-runtime 导出的 isMyGo()，没有这个
			// 全局，所以在这里补一个等价判断。脚本只由壳注入，普通浏览器
			// 不存在，三键照旧隐藏。
			PreloadScript: `window.isMyGo = window.isMyGo || function () {
  return typeof window.mygo === "object" && window.mygo !== null;
};`,
		},
		// 跟页面底色一致，免得启动时闪一下白
		BackgroundColor: "#181818",
	})
	// 页面加载后会把自己的 <title> 同步成窗口标题（服务页面里是 lifediary）。
	// 壳的标题固定用产品名，不让页面改。
	w.Page().OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
	// 关窗 = 隐藏：服务还要给手机用，提醒也要照跑。
	// 但退出流程（托盘「退出」→ App.Quit）必须先让窗口真正关闭，
	// 否则这里 PreventDefault 会把整个退出取消掉。
	w.OnClose(func(e *mygo.CloseEvent) {
		if quitting {
			return
		}
		e.PreventDefault()
		// 第一次关窗时告诉用户「服务还在跑」（批次二），之后写 ack 不再弹
		firstHideNotice(w)
		w.Hide()
	})
	// 窗口几何持久化（批次二）：move/resize/最大化切换防抖落盘
	w.OnMove(func() { scheduleWindowStateSave(w) })
	w.OnResize(func() { scheduleWindowStateSave(w) })
	w.OnMaximize(func() { scheduleWindowStateSave(w) })
	w.OnClosed(func() { win = nil })
	win = w
	if st != nil && st.Maximized {
		w.Maximize()
	}
	loadService(w)
	// 窗口一建好就记一份初始几何：用户不动窗口也有存档，重启后位置稳定
	scheduleWindowStateSave(w)
}

// trayIcon 返回托盘图标字节（assets/icon-tray.png，64x64 透明底）。
func trayIcon() []byte {
	return trayIconPNG
}

// watchService：运行期守护（批次二）。
//
// 10s 一探 /healthz，连续 3 次失败视为失联，自动重拉一次（30s 防抖，防疯狂重启）。
// 页面自己的 checkHealth 每 8s 自查，服务一回来界面自动恢复；这里的职责只是
// 把挂掉的进程重新拉起来，不碰页面。LIFEDIARY_SHELL_WATCH=off 关掉（回滚开关）。
func watchService(base string) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("LIFEDIARY_SHELL_WATCH")), "off") {
		return
	}
	go func() {
		failures := 0
		var lastPull time.Time
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if win == nil || win.IsDestroyed() {
				continue
			}
			if healthy(base) {
				failures = 0
				continue
			}
			// 用户主动停的：不许重拉（2026-11-07）。没有这一句，点完"停止"半分钟后
			// 服务自己回来，按钮就成了摆设——这是这次改动最容易漏掉的一处。
			if runtime.UserStopped() {
				failures = 0
				continue
			}
			failures++
			if failures < 3 || time.Since(lastPull) < 30*time.Second {
				continue
			}
			lastPull = time.Now()
			log.Println("watch: 服务失联，尝试重拉")
			runtime.Ensure()
		}
	}()
}

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		return // 已经在跑，交给那一个
	}

	app := mygo.App
	// 运行时控制器认一个 base：起停与状态都以它为准（端口也从这里解析）。
	// 必须在任何 Ensure / watchService 之前定下来，否则会去探默认端口。
	runtime.base = baseURL()
	// 在 RequestSingleInstanceLock 之后再改名：锁路径沿用可执行文件名，
	// 老版本进程还在时不会因为改名各起一个实例。显示名用产品名。
	app.SetName("Selenite")
	app.OnSecondInstance(func([]string, string) { showWindow() })

	// 退出开始得比关窗早：先标记，再让 App.Quit 关闭窗口时不再被
	// OnClose 的「关窗 = 隐藏」拦下来。
	app.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
	app.OnWillQuit(func(*mygo.QuitEvent) {
		if tray != nil {
			tray.Destroy()
		}
	})

	app.WhenReady(func() {
		// 刻意不设菜单栏：单窗口应用里 Edit/View/Window 只是占一行。
		// 要调试直接在浏览器打开 http://127.0.0.1:39847/ ，不需要窗口里的 DevTools 菜单。

		if t, err := mygo.NewTray(mygo.TrayOptions{
			Icon:    trayIcon(),
			ToolTip: "Selenite",
			Menu: mygo.NewMenu([]*mygo.MenuItem{
				{Label: "显示/隐藏", Click: func(*mygo.MenuItem, *mygo.Window) { toggleWindow() }},
				{Label: "重新连接", Click: func(*mygo.MenuItem, *mygo.Window) {
					if win == nil || win.IsDestroyed() {
						return
					}
					// 托盘点「重新连接」是**人的明确要求**（2026-11-07）：
					// 它要能越过"用户停过"那道闩，否则停完服务后托盘就再也救不回来，
					// 只剩设置页一条路。自动路径（开窗、守护重拉）仍走 Ensure 认闩——
					// 区分"人点的"和"系统自己撞见的"，是这次改动的分界线。
					go func() {
						if _, err := runtime.Start(); err != nil {
							log.Println("tray: 重新连接失败:", err)
						}
						loadService(win)
					}()
				}},
				mygo.Separator(),
				// RoleQuit 的默认文案来自 MyGo 的本地化表，可能落到英文
				// （Exit）。这里显式写中文，同时保留 Role 的退出语义。
				{Label: "退出", Role: mygo.RoleQuit},
			}),
		}); err != nil {
			// 托盘不可用不该阻止应用启动。
			log.Println("tray:", err)
		} else {
			tray = t
			// 左键单击 = 显示并前置主窗口（最小化则还原）。
			//
			// mygo 的 OnClick 文档写的是「图标没有菜单时」才回调，但那句
			// 说的是 macOS / Linux：Windows 后端在 WM_LBUTTONUP 上无条件
			// 回调（internal/windows/tray.go 的 trayMessage），菜单只挂
			// WM_RBUTTONUP，所以这里不会抢走右键菜单。
			t.OnClick(showWindow)
		}

		showWindow()
		// 运行期服务守护（批次二）：启动探活只做一次，服务跑着挂掉就没人管了
		watchService(baseURL())
	})

	// 关掉窗口不退出：托盘还在，服务还在。
	app.OnWindowAllClosed(func() {})

	// MyGo 的服务注册是全局的（按类型名 → "Shell.SelectDirectory"），
	// 文档要求在建窗口、App.Run 之前调用；它只登记方法表，不分窗口。
	if shellBindingsEnabled() {
		mygo.Bind(Shell{})
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
