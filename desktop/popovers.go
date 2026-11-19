package main

/*
原生弹出层（2026-11-19 批1）：悬停提示与右键菜单族交给 MyGo 的 flyout。

为什么换（用户目标「把前端部分组件换成 go，一些比较核心对性能要求比较高的」）：
弹出层是全应用触发频率最高、对帧延迟最敏感的一族。web 版每次都要建 DOM、量宽、
防裁切（hover-tip / sec-menu / 执行器模型下拉三处重复「挂 body 躲 overflow:hidden」
的绕法），还会与页面动画争主线程。原生 flyout（mygo.NewFlyout + package ui）是
独立小窗、GPU 自绘、不进 WebView2 合成树，能伸出窗口边缘，Windows 11 自动圆角、
系统阴影，外点击关闭语义与系统菜单一致（按下只关菜单、不穿透进页面——framework
文档明文），顺手解决 web 菜单「同一颗 ⋯ 再点一下关不掉」那类次序坑。

方案：docs/设计方案/2026-11-19-壳弹出层原生化（mygo ui 接管悬停提示与右键菜单）.md

坐标口径（写死，别再猜）：flyout 锚点以「父窗口内容区的 DIP」计；页面 CSS px ×
Page.ZoomFactor = DIP。壳不设 ZoomFactor（生产构建下 WebView2 的缩放键只在检查器
开启时有效，日常恒 1），所以这里把页面坐标原样当 DIP 用。将来给页面开缩放时，
rectToGo 是唯一要跟着乘的地方。

回滚开关：LIFEDIARY_NATIVE_POPOVERS=off → Capabilities 返回 nativePopups=false，
页面探测后全量走 DOM 旧路（老壳没有 Capabilities 这个方法，页面调用 reject，
同样回 DOM——所以新旧壳/浏览器四象限都安全）。

线程模型（mygo 的规矩）：Bind 方法在独立 goroutine 里跑；窗口 API 内部汇入主线程；
视图函数（tipView / menuView）在主线程绘制帧里跑。因此：
  - 状态一律走 atomic 快照（tipSnap / menuSnap），视图只 Load、不拿锁——
    否则建窗等主线程画首帧、首帧又要拿同一把锁，直接死锁。
  - OnClosed 里只做「select 非阻塞发 -1 + 原子清指针」，不拿锁。
  - 菜单选择走「阻塞的 Bind 方法 + 缓冲 1 的 channel」：页面拿到 Promise resolve
    的序号后在本地跑自己的闭包——业务闭包不过桥，桥上只有数据。

「业务不进壳」边界：这里只画壳、收坐标、回序号；菜单项做什么（粘贴到哪个字段、
开哪张模态）全在页面侧。壳不认识业务，跟 Dialog / 托盘同一档。
*/

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// ── 请求/响应类型（json tag 与页面侧 payload 一一对应）──────────

// popoverRect 页面里的一个矩形（getBoundingClientRect + 视口坐标），DIP 口径见文头。
type popoverRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// TipRequest 一次悬停提示：anchor 是锚点矩形（光标点传零尺寸矩形），tip 是文字。
type TipRequest struct {
	Anchor popoverRect `json:"anchor"`
	Tip    string      `json:"tip"`
}

// MenuItem 菜单项。业务动作（run）留在页面侧，这里只传显示要用的字段。
type MenuItem struct {
	Label     string `json:"label,omitempty"`
	Hint      string `json:"hint,omitempty"`
	Kbd       string `json:"kbd,omitempty"`
	Danger    bool   `json:"danger,omitempty"`
	Separator bool   `json:"separator,omitempty"`
	Disabled  bool   `json:"disabled,omitempty"`
}

// MenuRequest 一次菜单：anchor + 摆位 + 项列表。
type MenuRequest struct {
	Anchor    popoverRect `json:"anchor"`
	Placement string      `json:"placement,omitempty"` // bottom-start（默认）/ bottom-end
	Items     []MenuItem  `json:"items"`
}

// ShellCapabilities 页面探测壳能力的返回。
type ShellCapabilities struct {
	NativePopups bool `json:"nativePopups"`
}

// nativePopoversEnabled 是本批的回滚开关：=off 时 Capabilities 报 false，
// 页面全量走 DOM 旧路。回滚不等于改代码。
func nativePopoversEnabled() bool {
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("LIFEDIARY_NATIVE_POPOVERS")), "off")
}

// ── 壳能力探测 ───────────────────────────────────────────

// Capabilities 页面启动时探一次并缓存；普通浏览器没有 window.mygo，根本调不到这里。
func (Shell) Capabilities() ShellCapabilities {
	return ShellCapabilities{NativePopups: nativePopoversEnabled()}
}

// ── 悬停提示（对应 web 的 .hover-tip 小黑签）────────────────

// tipState 是一帧要画的提示；不可变，换内容就换指针。
type tipState struct {
	lines []string
}

var (
	tipSnap = atomic.Pointer[tipState]{}
	tipWin  = atomic.Pointer[mygo.Window]{}
)

// errPopoversOff / errNoWindow 给页面侧区分「开关关了回 DOM」和「壳不在」。
var errPopoversOff = errors.New("原生弹出层已关闭（LIFEDIARY_NATIVE_POPOVERS=off）")
var errNoWindow = errors.New("主窗口不在，画不出弹出层")

// ShowTip 显示/更新悬停提示。同一时刻只有一枚：已开着就换锚点换字（SetAnchor +
// Invalidate），不重建窗口——快速划过工具栏时这就是一帧的事。
func (Shell) ShowTip(req TipRequest) error {
	if !nativePopoversEnabled() {
		return errPopoversOff
	}
	parent := win
	if parent == nil || parent.IsDestroyed() {
		return errNoWindow
	}
	tipSnap.Store(&tipState{lines: splitTipLines(req.Tip)})
	rect := rectToGo(req.Anchor)
	if old := tipWin.Load(); old != nil && !old.IsDestroyed() {
		old.SetAnchor(rect)
		old.Invalidate()
		return nil
	}
	fl := mygo.NewFlyout(mygo.FlyoutOptions{
		Parent:    parent,
		Anchor:    rect,
		Placement: mygo.PlacementTopStart,
		Gap:       10,
		// FitContent：按内容量宽高，MaxWidth 处折行——对应 web 版 320px 的宽度上限
		//（越界翻转交给 flyout）。
		FitContent: true,
		MaxWidth:   320,
		Shadow:     false,
		// 非 Focusable：不抢键盘、不因外点击自己关（页面在 mouseout/click/scroll
		// 时调 HideTip，与 web 版的收口时机逐条对应；Esc 壳兜底关）。
		Content: ui.View(tipView),
	})
	fl.OnClosed(func() {
		if tipWin.Load() == fl {
			tipWin.Store(nil)
		}
	})
	tipWin.Store(fl)
	return nil
}

// HideTip 收掉提示。没有就什么都不做（页面在 scroll/resize 等高频时机也调）。
func (Shell) HideTip() {
	if fl := tipWin.Load(); fl != nil && !fl.IsDestroyed() {
		fl.Close()
	}
}

// tipView 在主线程画提示：固定黑底白字（2026-11-14 web 侧拍板「不跟主题」，
// 深色主题下跟变量会翻成白底黑字——原生侧照抄同一条），按 \n 拆行（pre-line）。
// 背景画在 c.Root() 上而不是 Column 上：Root 永远填满窗口，FitContent 量出来的
// 尺寸和内容差的那几个像素也是背景色，不会露出 Win11 系统底板（真机踩过：画在
// Column 上，窗口底部露出一条白）。
func tipView(c *ui.Context) {
	snap := tipSnap.Load()
	if snap == nil || len(snap.lines) == 0 {
		return
	}
	c.Root().Background(ui.Hex("#191919"))
	ui.Column(c).Padding(5, 9).Children(func() {
		for _, line := range snap.lines {
			// 空行塞一个空格保住行高（web 的 white-space: pre-line 同款效果）
			text := line
			if text == "" {
				text = " "
			}
			ui.Text(c, text).FontSize(12).TextColor(ui.Hex("#f7f7f5"))
		}
	})
}

// splitTipLines 把 data-tip 的多行文字拆成行：剥 \r（CRLF 污染）、掉尾空行。
func splitTipLines(tip string) []string {
	if strings.TrimSpace(tip) == "" {
		return nil
	}
	raw := strings.Split(strings.TrimRight(tip, "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		lines = append(lines, strings.TrimRight(line, "\r"))
	}
	return lines
}

// ── 右键菜单族（对应 web 的 .sec-menu）────────────────────

// menuState 是一帧要画的菜单；不可变。
type menuState struct {
	anchor    mygo.Rectangle
	placement mygo.Placement
	items     []MenuItem
}

var (
	menuSnap   = atomic.Pointer[menuState]{}
	menuWin    = atomic.Pointer[mygo.Window]{}
	menuHover  = atomic.Int32{}              // 键盘/悬停高亮的行号
	menuPickCh = atomic.Pointer[chan int]{} // 当前这次 ShowMenu 的应答通道
)

// ShowMenu 打开菜单并阻塞，返回所选序号；用户按掉（外点击/Esc）返回 -1。
// 页面拿到序号后在自己那边跑对应的闭包——业务不过桥。
func (Shell) ShowMenu(req MenuRequest, ctx context.Context) (int, error) {
	if !nativePopoversEnabled() {
		return -1, errPopoversOff
	}
	parent := win
	if parent == nil || parent.IsDestroyed() {
		return -1, errNoWindow
	}
	if len(req.Items) == 0 {
		return -1, nil
	}
	// 已开一张先关（页面 closeSecMenu 之后才来调，这里兜底防叠两张）；
	// 旧窗的 OnClosed 会往旧调用自己的通道发 -1，把上一轮 ShowMenu 放回去。
	if old := menuWin.Load(); old != nil && !old.IsDestroyed() {
		old.Close()
	}
	snap := &menuState{
		anchor:    rectToGo(req.Anchor),
		placement: placementFromRequest(req.Placement),
		items:     req.Items,
	}
	menuSnap.Store(snap)
	menuHover.Store(int32(firstEnabledItem(snap.items)))

	// ch 只属于这一次调用：OnClosed 与行点击都往它发（缓冲 1 + select 防重发）。
	ch := make(chan int, 1)
	menuPickCh.Store(&ch)
	fl := mygo.NewFlyout(mygo.FlyoutOptions{
		Parent:     parent,
		Anchor:     snap.anchor,
		Placement:  snap.placement,
		Gap:        2,
		FitContent: true,
		MinWidth:   176,
		MaxWidth:   280,
		// Focusable：吃键盘（方向键/Enter 在 menuView 里处理）；Windows 上外点击
		// 只关菜单不穿透（framework 明文），OnClosed 给这次调用回 -1。
		Focusable: true,
		Shadow:    false,
		Content:   ui.View(menuView),
	})
	fl.OnClosed(func() {
		select {
		case ch <- -1:
		default:
		}
	})
	menuWin.Store(fl)

	select {
	case idx := <-ch:
		return idx, nil
	case <-ctx.Done():
		// 页面导航走人：收掉菜单，别让这次调用挂死。
		if cur := menuWin.Load(); cur != nil && !cur.IsDestroyed() {
			cur.Close()
		}
		select {
		case idx := <-ch:
			return idx, nil
		default:
			return -1, nil
		}
	}
}

// menuPick 由菜单视图（主线程）在选中一行时调：发序号、关窗。
func menuPick(idx int) {
	if ch := menuPickCh.Load(); ch != nil {
		select {
		case *ch <- idx:
		default:
		}
	}
	if fl := menuWin.Load(); fl != nil && !fl.IsDestroyed() {
		fl.Close()
	}
}

// menuView 在主线程画菜单：五套主题色板、行 hover/键盘高亮、方向键 + Enter。
// 背景同样画在 c.Root() 上（理由同 tipView：Column 不填满窗口时会露系统底板）。
func menuView(c *ui.Context) {
	snap := menuSnap.Load()
	if snap == nil {
		return
	}
	pal := popoverPalette(savedTheme())
	c.Root().Background(pal.bg)

	// 键盘：方向键在可用项之间挪高亮，Enter 选中；Esc 壳自己关（OnClosed → -1）。
	if c.Shortcut(0, ui.KeyDown) {
		menuHover.Store(int32(nextEnabledItem(snap.items, int(menuHover.Load()), +1)))
		c.Invalidate()
	}
	if c.Shortcut(0, ui.KeyUp) {
		menuHover.Store(int32(nextEnabledItem(snap.items, int(menuHover.Load()), -1)))
		c.Invalidate()
	}
	if c.Shortcut(0, ui.KeyEnter) {
		idx := int(menuHover.Load())
		if it := itemAt(snap.items, idx); it != nil && !it.Disabled && !it.Separator {
			menuPick(idx)
		}
	}

	ui.Column(c).Padding(4).Children(func() {
		for i, item := range snap.items {
			if item.Separator {
				ui.Box(c.Key("sep"+strconv.Itoa(i))).Height(1).FillWidth().Margin(4, 0).Background(pal.divider)
				continue
			}
			row := ui.Column(c.Key(i)).Padding(7, 10).Radius(8)
			hover := int(menuHover.Load()) == i && !item.Disabled
			if !hover && !item.Disabled && row.Hovered() {
				menuHover.Store(int32(i))
				c.Invalidate()
				hover = true
			}
			// 危险行的 hover 底色带一点红（web 用 color-mix，这里是预算好的值）
			row.Background(pickColor(pal.hover, pal.hoverDanger, item.Danger, hover))
			row.Children(func() {
				labelColor := pal.text
				if item.Danger {
					labelColor = pal.danger
				}
				ui.Row(c).Children(func() {
					label := ui.Text(c, item.Label).FontSize(13).FontWeight(600).TextColor(labelColor).Grow(1)
					if item.Disabled {
						label.Opacity(0.45)
					}
					if item.Kbd != "" {
						ui.Text(c, item.Kbd).FontSize(11).TextColor(pal.text3)
					}
				})
				if item.Hint != "" {
					ui.Text(c, item.Hint).FontSize(11.5).TextColor(pal.text3)
				}
			})
		}
	})
}

// pickColor 选行底色：普通 hover 一档，危险行 hover 带红的一档。
func pickColor(normal, dangerHover ui.Color, danger, active bool) ui.Color {
	if !active {
		return ui.Color{} // 透明：不画底
	}
	if danger {
		return dangerHover
	}
	return normal
}

// ── 纯函数（可单测）──────────────────────────────────────

// rectToGo 页面矩形 → mygo 矩形。1:1 的前提（壳不开缩放）见文头坐标口径。
func rectToGo(r popoverRect) mygo.Rectangle {
	return mygo.Rectangle{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height}
}

// placementFromRequest 只认白名单里的摆位，认不出回默认 bottom-start
//（右键贴光标右下），防页面侧传脏串。
func placementFromRequest(s string) mygo.Placement {
	switch s {
	case string(mygo.PlacementBottomEnd):
		return mygo.PlacementBottomEnd
	case string(mygo.PlacementTopStart):
		return mygo.PlacementTopStart
	case string(mygo.PlacementTop):
		return mygo.PlacementTop
	default:
		return mygo.PlacementBottomStart
	}
}

// firstEnabledItem 初始高亮落在第一个可用项（web 版把焦点给第一项的口径）。
func firstEnabledItem(items []MenuItem) int {
	for i, item := range items {
		if !item.Disabled && !item.Separator {
			return i
		}
	}
	return -1
}

// nextEnabledItem 从 from 起按 dir 挪到下一个可用项；没有可用项就原地不动。
func nextEnabledItem(items []MenuItem, from, dir int) int {
	if len(items) == 0 {
		return from
	}
	idx := from
	for range len(items) {
		idx = (idx + dir + len(items)) % len(items)
		it := items[idx]
		if !it.Disabled && !it.Separator {
			return idx
		}
	}
	return from
}

func itemAt(items []MenuItem, idx int) *MenuItem {
	if idx < 0 || idx >= len(items) {
		return nil
	}
	return &items[idx]
}

// ── 菜单色板（与 style-01-tokens.css 逐值对齐）────────────────
//
// web 菜单取 var(--bg)/var(--surface-low)/var(--text)/var(--text-3)/var(--c-error)/
// var(--divider)；这里按壳记的主题名给同一套值。danger 行 hover 是
// color-mix(in srgb, --c-error 9%, --surface-low) 的预算值（Go 侧不做 color-mix）。

type popoverColors struct {
	bg          ui.Color
	hover       ui.Color
	hoverDanger ui.Color
	text        ui.Color
	text3       ui.Color
	danger      ui.Color
	divider     ui.Color
}

func popoverPalette(theme string) popoverColors {
	switch theme {
	case themeWhite:
		return popoverColors{
			bg:          ui.Hex("#fafaf8"),
			hover:       ui.Hex("#f3f3f0"),
			hoverDanger: ui.Hex("#eeeeec"),
			text:        ui.Hex("#1a1a1e"),
			text3:       ui.Hex("#9b9ba4"),
			danger:      ui.Hex("#b3564d"),
			divider:     ui.RGBA(0, 0, 0, 0.10),
		}
	case themeIndigo:
		return popoverColors{
			bg:          ui.Hex("#12141d"),
			hover:       ui.Hex("#181b26"),
			hoverDanger: ui.Hex("#2a2831"),
			text:        ui.Hex("#e7e9f2"),
			text3:       ui.Hex("#6d7183"),
			danger:      ui.Hex("#e5a9a2"),
			divider:     ui.RGBA(255, 255, 255, 0.09),
		}
	case themeBlack:
		return popoverColors{
			bg:          ui.Hex("#17171a"),
			hover:       ui.Hex("#121215"),
			hoverDanger: ui.Hex("#232226"),
			text:        ui.Hex("#e6e6ea"),
			text3:       ui.Hex("#66666f"),
			danger:      ui.Hex("#e5a9a2"),
			divider:     ui.RGBA(255, 255, 255, 0.12),
		}
	case themeCeladon:
		return popoverColors{
			bg:          ui.Hex("#f1f5f1"),
			hover:       ui.Hex("#e8eee8"),
			hoverDanger: ui.Hex("#e7e8e2"),
			text:        ui.Hex("#1e2a25"),
			text3:       ui.Hex("#8b9a90"),
			danger:      ui.Hex("#b3564d"),
			divider:     ui.RGBA(30, 42, 37, 0.12),
		}
	default: // paper（也是认不出主题时的兜底）
		return popoverColors{
			bg:          ui.Hex("#fdf9f2"),
			hover:       ui.Hex("#f7f3eb"),
			hoverDanger: ui.Hex("#f1e5dd"),
			text:        ui.Hex("#2e2b3a"),
			text3:       ui.Hex("#9a97a5"),
			danger:      ui.Hex("#b3564d"),
			divider:     ui.RGBA(200, 197, 188, 0.55),
		}
	}
}
