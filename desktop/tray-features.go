package main

// 托盘三小件（2026-11-07 扫尾批 1）：设置导航、图标随服务状态变灰、
// 退出前查在飞任务。只碰桌面壳，不改服务端任何契约。

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

// ── 1. 托盘「设置」：把现有窗口导航到 #/settings ──────────────────────
//
// 与启动深链 LIFEDIARY_VIEW=settings 是同一落点、同一套路由：前端是 hash
// 路由（currentRoute() 读 location.hash，#/settings → settings），启动时
// ?view=settings 也是 go("settings") 最终写 location.hash = "#/settings"。
// 这里不新增 URL、不新增 query 参数、不整页 reload，只是推进 SPA 自己的
// hash 路由（触发它的 hashchange → applyRoute），所以不算第二套路由机制。
//
// 托盘回调在主线程跑，长操作要丢 goroutine（见菜单项里的 go openSettings()）；
// Page().Eval 内部会 post 到主线程并等待 JS 结果，可安全从 goroutine 调用。
func openSettings() {
	// showWindow 幂等：已显示/前台是空操作，隐藏则显示、最小化则还原、没建则
	// 创建。它只 Show/Focus，不会重载页面，满足「若窗口未显示先显示再导航」。
	showWindow()
	if win == nil || win.IsDestroyed() {
		return
	}
	// 与前端 go("settings") 完全一样：写 location.hash（赋值表达式，Eval 当
	// 表达式直接求值，无需走 statement 回退），触发 hashchange → applyRoute。
	if _, err := win.Page().Eval(`window.location.hash = '#/settings'`); err != nil {
		log.Println("tray: 打开设置失败:", err)
	}
}

// ── 2. 托盘图标随服务状态变灰 ────────────────────────────────────────
//
// LIFEDIARY_TRAY_STATE=off 是回滚开关：不起轮询、不换图标（菜单「设置」保留，
// 无害）。退出时 stopTrayStateWatcher() 关掉 goroutine。
var (
	trayStateStop     = make(chan struct{})
	trayStateStopOnce sync.Once
)

func trayStateEnabled() bool {
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("LIFEDIARY_TRAY_STATE")), "off")
}

func stopTrayStateWatcher() {
	trayStateStopOnce.Do(func() { close(trayStateStop) })
}

// startTrayStateWatcher 每 5s 探一次 runtime.Status()，只在状态变化时动作。
// Status() 里有 800ms 同步探活，所以必须放 goroutine 里调。
func startTrayStateWatcher() {
	if !trayStateEnabled() || tray == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		var last RuntimeState
		apply := func() {
			st := runtime.Status()
			if st.State == last {
				return
			}
			last = st.State
			applyTrayState(st.State)
		}
		apply() // 立刻定一次初始态，别等第一个 5s
		for {
			select {
			case <-trayStateStop:
				return
			case <-ticker.C:
				apply()
			}
		}
	}()
}

func applyTrayState(s RuntimeState) {
	if tray == nil {
		return
	}
	switch s {
	case RuntimeRunning, RuntimeStarting:
		_ = tray.SetIcon(trayIcon(), false) // 原彩色图标
	case RuntimeStopped, RuntimeFailed:
		_ = tray.SetIcon(trayIdleIconPNG, false) // 灰色图标
	}
	tray.SetToolTip("Selenite — " + trayStateText(s))
}

func trayStateText(s RuntimeState) string {
	switch s {
	case RuntimeRunning:
		return "服务运行中"
	case RuntimeStarting:
		return "服务启动中"
	case RuntimeStopped:
		return "服务已停止"
	case RuntimeFailed:
		return "服务异常"
	default:
		return "服务状态未知"
	}
}

// ── 3. 退出前查在飞任务 ──────────────────────────────────────────────
//
// OnBeforeQuit 先 PreventDefault 挂起退出，异步查 /api/v1/tickets：
//   - 无在飞 / 查询失败（服务没跑）→ 直接放 quit，不烦人；
//   - 有在飞 → 弹确认框；确认放 quit，取消什么都不做（退出被拦下）。
//
// quitting=true（OnClose 关窗放行依赖它）只在真正决定退出时才置，见
// approveQuit；别把它丢回同步置位，否则异步这段就没机会跑。
var quitChecking atomic.Bool

// nonTerminalTicket 是在飞（非终态）状态集合，按任务书口径。
var nonTerminalTicket = map[string]bool{
	"received": true, "planning": true, "planned": true,
	"dispatching": true, "reviewing": true, "idle": true,
}

func checkBeforeQuit() {
	n := inFlightTickets()
	if n == 0 {
		approveQuit()
		return
	}

	// mygo 自带原生消息框（Dialog.Message）：可自定义按钮、可从任意
	// goroutine 调用并阻塞到用户点选。这就是任务书要的确认框，不必退化
	// 到 window.confirm，也不必降级成托盘气泡。
	res, err := mygo.Dialog.Message(mygo.MessageOptions{
		Type:          mygo.MessageQuestion,
		Title:         "退出 Selenite",
		Message:       fmt.Sprintf("还有 %d 个任务在跑，退出后它们继续执行但窗口关闭。确定退出？", n),
		Buttons:       []string{"确定退出", "取消"},
		DefaultButton: 0,
		CancelButton:  1,
	})
	if err == nil && res.Button == 0 {
		approveQuit()
		return
	}
	// 取消 / 对话框出错：什么都不做，退出已被拦下，应用继续活着。
	quitChecking.Store(false) // 允许下次再点「退出」重新查
}

// approveQuit 是唯一真正决定退出的地方。
// quitting 按 main.go 的约定只在主线程读写，所以用 RunOnMain 置位再请求退出；
// 第二次 App.Quit() 会再触发 OnBeforeQuit，那里看到 quitting==true 直接放行，
// 不会再 PreventDefault 挂起一轮，也不会重复弹框。
func approveQuit() {
	mygo.RunOnMain(func() {
		quitting = true
		mygo.App.Quit()
	})
}

// inFlightTickets 返回非终态单数。本机 loopback 无令牌也放行（服务端 auth
// 口径），所以直接 GET，不封装 token。任何一步失败都按 0 处理：查不清就别
// 拦着用户退出。
func inFlightTickets() int {
	port := runtime.Status().Port
	url := fmt.Sprintf("http://127.0.0.1:%d/api/v1/tickets", port)
	c := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get(url)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0
	}
	return countNonTerminal(body)
}

// countNonTerminal 解析 GET /api/v1/tickets 的响应 {"tickets":[...]}，数
// status 落在 nonTerminalTicket 的单。解析失败一律按 0 处理（任务书口径）。
func countNonTerminal(body []byte) int {
	var list struct {
		Tickets []struct {
			Status string `json:"status"`
		} `json:"tickets"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return 0
	}
	n := 0
	for _, t := range list.Tickets {
		if nonTerminalTicket[t.Status] {
			n++
		}
	}
	return n
}
