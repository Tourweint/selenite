package main

// 托盘两小件（2026-11-07 扫尾批 1；2026-11-20 起「设置」项退役，只剩两件）：
// 图标随服务状态变灰、退出前确认并停掉 Node 服务。只碰桌面壳，不改服务端任何契约。
//
// 原来第一件是「把窗口导航到 #/settings」。页面自己就能进设置，托盘再放一个
// 只是重复入口；退出却是**唯一**能把壳和服务一起关掉的地方，所以把位置让给它。

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

// ── 1. 托盘图标随服务状态变灰 ────────────────────────────────────────
//
// LIFEDIARY_TRAY_STATE=off 是回滚开关：不起轮询、不换图标（菜单项不受影响）。
// 退出时 stopTrayStateWatcher() 关掉 goroutine。
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
	// 悬停只留名字（2026-11-20）：状态已经由图标颜色表达，不再往 tooltip 里塞
	// 版本与服务状态文案。
	tray.SetToolTip("Selenite")
}

// ── 2. 退出：确认在飞任务 + 停掉 Node 服务 ──────────────────────────
//
// 2026-11-20：托盘「退出」的含义改成「停服务 + 退壳」。此前退出只关壳，
// Node 服务（DETACHED_PROCESS）留在后台——桌面上看不见它、也没有入口停，
// 用户只能去任务管理器找 node。窗口 X 仍是"只隐藏"（手机与提醒要靠服务），
// 两个一起收只有托盘这一条路。
//
// OnBeforeQuit 先 PreventDefault 挂起退出，异步做两件事：
//  1. 查 /api/v1/tickets：有在飞单就确认（退出会中断它们）；
//  2. runtime.Stop() 停服务；停不掉时弹「重试 / 仍然退出 / 取消退出」，
//     **不偷偷带着一个活着的 node 退出**。
//
// 两关都过了才放行 App.Quit。
//
// LIFEDIARY_QUIT_STOP_SERVICE=off 回到旧形态：退出只关壳，服务留在后台。
// 回滚是"一行 env"，不是改代码（AGENTS.md 硬约束）。
//
// quitting=true（OnClose 关窗放行依赖它）只在真正决定退出时才置，见
// approveQuit；别把它丢回同步置位，否则异步这段就没机会跑。
var quitChecking atomic.Bool

func quitStopsServiceEnabled() bool {
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("LIFEDIARY_QUIT_STOP_SERVICE")), "off")
}

// nonTerminalTicket 是在飞（非终态）状态集合。
// 2026-11-20 按 chancellor types.ts / store.ts 核对：终态是
// done / needs_you / idle / failed / aborted。idle（等子单）不再算在飞——
// 它的子单自己也在列表里，算两遍会多报；reviewing 已于 2026-11-19 验收层退役。
var nonTerminalTicket = map[string]bool{
	"received": true, "planning": true, "planned": true, "dispatching": true,
}

func checkBeforeQuit() {
	if n := inFlightTickets(); n > 0 {
		// 回滚形态（off）下退出不停服务，文案要跟着变，别承诺没做的事。
		quitLabel := "退出并停止服务"
		message := fmt.Sprintf("还有 %d 个任务在跑。退出会停止服务并中断它们（已完成的历史保留）。确定退出？", n)
		if !quitStopsServiceEnabled() {
			quitLabel = "退出"
			message = fmt.Sprintf("还有 %d 个任务在跑，退出后它们继续执行但窗口关闭。确定退出？", n)
		}
		// mygo 自带原生消息框（Dialog.Message）：可自定义按钮、可从任意
		// goroutine 调用并阻塞到用户点选。这就是任务书要的确认框，不必退化
		// 到 window.confirm，也不必降级成托盘气泡。
		res, err := mygo.Dialog.Message(mygo.MessageOptions{
			Type:          mygo.MessageQuestion,
			Title:         "退出 Selenite",
			Message:       message,
			Buttons:       []string{quitLabel, "取消"},
			DefaultButton: 0,
			CancelButton:  1,
		})
		if err != nil || res.Button != 0 {
			// 取消 / 对话框出错：什么都不做，退出已被拦下，应用继续活着。
			quitChecking.Store(false) // 允许下次再点「退出」重新查
			return
		}
	}
	if !stopServiceBeforeQuit() {
		quitChecking.Store(false)
		return
	}
	approveQuit()
}

// stopServiceBeforeQuit 停掉 Node 服务；返回 false = 用户选择不退出。
// 停不掉时必须问一声：静默退出会留下一个用户找不到的 node，正是这次要治的病。
func stopServiceBeforeQuit() bool {
	if !quitStopsServiceEnabled() {
		return true
	}
	_, err := runtime.Stop()
	for err != nil {
		// 弹不出来（Dialog 出错）就别拦着用户：按「仍然退出」处理。
		res, derr := mygo.Dialog.Message(mygo.MessageOptions{
			Type:    mygo.MessageWarning,
			Title:   "停止服务失败",
			Message: "没能停掉 Node 服务：" + err.Error(),
			Detail: "服务可能还在后台跑。可以重试；选「仍然退出」则只关窗口、服务留下" +
				"（重新打开 Selenite 再退出，或用任务管理器结束 node）。",
			Buttons:       []string{"重试", "仍然退出", "取消退出"},
			DefaultButton: 0,
			CancelButton:  2,
		})
		if derr != nil {
			return true
		}
		switch res.Button {
		case 0: // 重试
			_, err = runtime.Stop()
		case 1: // 仍然退出
			return true
		default: // 取消退出
			return false
		}
	}
	return true
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
