package main

/*
原生截图的遮罩窗：mygo 原生窗口（不是第二个 WebView 页面）+ package ui 自绘。
指针 / 键盘 API 以 mygo v0.10.0 的 ui 源码为准（ui/api_gen.go）：
  Element.PointerPosition / Element.PressedButton  —— 框架文档里画布平移用的就是这一对
  Context.Shortcut(0, ui.KeyEscape)                 —— 同 menuView 的方向键 / Enter
*/

import (
	"fmt"
	"image"
	"sync/atomic"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

const (
	snapshotHint      = "拖动框选 · 单击选窗口 · Esc 取消"
	snapshotHintWidth = 268.0
)

// snapshotOutcome 一次遮罩的结论：取消，或要截的物理像素矩形（显示器内坐标）。
type snapshotOutcome struct {
	canceled bool
	rect     pxRect
}

// snapshotOverlay 一张开着的遮罩。建窗前定死的字段之后只读；drag / hover* / finished
// **只有主线程读写**（视图函数在主线程绘制帧里跑）。
type snapshotOverlay struct {
	frame  *image.RGBA // 冻结帧，物理像素，RGBA
	mw, mh int         // 冻结帧尺寸 = 显示器物理尺寸
	origin pxRect      // 显示器的屏幕坐标（物理像素），建窗前的推算值

	bitmap  *ui.Bitmap
	scale   float64
	left    int // 遮罩左上角的屏幕坐标（物理像素），取自遮罩窗自己
	top     int
	width   float32 // 遮罩尺寸（DIP）= 显示器 Bounds
	height  float32
	exclude map[uintptr]bool
	overlay *mygo.Window
	done    chan snapshotOutcome

	drag      snapDrag
	hoverKeyX float32 // 上次算悬停窗时的指针位置（DIP）
	hoverKeyY float32
	hover     dipRect
	hoverPx   pxRect
	hoverOK   bool
	finished  bool
}

// overlaySnap 视图函数从这里取当前这张遮罩；nil = 没开着。
var overlaySnap atomic.Pointer[snapshotOverlay]

// open 建窗并显示。整段汇入主线程：读显示器列表、建位图、建窗都要在主线程，
// 而且「建窗前后各数一次本进程的顶层窗」要在同一段主线程代码里做，中间不能插进别的窗。
func (o *snapshotOverlay) open() error {
	var (
		ran     bool
		failure error
	)
	mygo.RunOnMain(func() {
		ran = true
		failure = o.openOnMain()
	})
	if !ran {
		return errSnapshotNoWindow
	}
	return failure
}

func (o *snapshotOverlay) openOnMain() error {
	display, ok := displayForMonitor(o.mw, o.mh, shellDisplays())
	if !ok {
		return fmt.Errorf("找不到与 %dx%d 匹配的显示器", o.mw, o.mh)
	}
	o.scale = display.ScaleFactor
	o.width, o.height = float32(display.W), float32(display.H)
	o.bitmap = ui.NewBitmap(o.frame)

	before := ownTopLevelWindows()
	o.overlay = mygo.NewWindow(mygo.WindowOptions{
		Title:             "Selenite 截图",
		X:                 display.X,
		Y:                 display.Y,
		Width:             display.W,
		Height:            display.H,
		Frameless:         true,
		AlwaysOnTop:       true,
		SkipTaskbar:       true,
		DisableResize:     true,
		DisableMove:       true,
		DisableMinimize:   true,
		DisableMaximize:   true,
		DisableShadow:     true,
		DisableFullScreen: true,
		BackgroundColor:   "#000000", // 首帧之前别闪白
		Content:           ui.View(snapshotView),
	})
	o.exclude = newTopLevelWindows(before)
	// 框架自己把窗收走（Alt+F4、外部销毁……）：一律按取消收尾，别让调用挂死。
	o.overlay.OnClosed(func() { o.finish(snapshotOutcome{canceled: true}) })

	// 左上角以遮罩窗的真实落点为准；取不到就按显示器原点算。
	o.left, o.top = o.origin.X, o.origin.Y
	for hwnd := range o.exclude {
		if r, ok := windowBounds(hwnd); ok {
			o.left, o.top = r.X, r.Y
		}
	}
	overlaySnap.Store(o)
	o.overlay.Show()
	o.overlay.Focus()
	return nil
}

// close 销毁遮罩并把主窗口拉回前台——别让焦点留在已经销毁的窗口上。
func (o *snapshotOverlay) close() {
	mygo.RunOnMain(func() {
		overlaySnap.Store(nil)
		if o.overlay != nil && !o.overlay.IsDestroyed() {
			o.overlay.Destroy()
		}
		if win != nil && !win.IsDestroyed() {
			win.Focus()
		}
	})
}

// finish 收尾（只做一次）：把结论交给 Bind goroutine。之后的帧什么都不画。
func (o *snapshotOverlay) finish(out snapshotOutcome) {
	if o.finished {
		return
	}
	o.finished = true
	select {
	case o.done <- out:
	default:
	}
}

// windowUnder 截光标（DIP）下那个顶层窗口，返回它在显示器内的物理像素矩形（已裁到屏内）。
// 找不到（桌面、任务栏、自己）返回 false。
func (o *snapshotOverlay) windowUnder(x, y float32) (pxRect, bool) {
	sx := o.left + dipToPx(x, o.scale)
	sy := o.top + dipToPx(y, o.scale)
	r, ok := windowAtScreenPoint(int32(sx), int32(sy), o.exclude)
	if !ok {
		return pxRect{}, false
	}
	r.X, r.Y = r.X-o.left, r.Y-o.top
	r = clipRect(r, o.mw, o.mh)
	return r, !r.empty()
}

// hoverRect 悬停高亮的窗口（DIP）。同一位置不重复查：不动鼠标的那些帧直接用上次的结果。
func (o *snapshotOverlay) hoverRect(x, y float32) (pxRect, bool) {
	if !o.hoverOK || x != o.hoverKeyX || y != o.hoverKeyY {
		o.hoverPx, o.hoverOK = o.windowUnder(x, y)
		o.hoverKeyX, o.hoverKeyY = x, y
		o.hover = rectToDip(o.hoverPx, 0, 0, o.scale)
	}
	return o.hoverPx, o.hoverOK
}

// snapshotView 每帧：读指针 → 推状态机 → 画冻结帧、压暗条带、选框、尺寸标签、提示条。
func snapshotView(c *ui.Context) {
	o := overlaySnap.Load()
	if o == nil || o.finished {
		return
	}
	W, H := o.width, o.height
	if c.Shortcut(0, ui.KeyEscape) {
		o.finish(snapshotOutcome{canceled: true})
		return
	}

	// 指针层：整屏一块透明盒子，选框 / 标签都挂在它下面——按下落在任何一层都会算到它头上。
	pad := ui.Box(c).Absolute().Left(0).Top(0).Width(W).Height(H).Cursor(ui.CursorCrosshair)
	x, y, _ := pad.PointerPosition()
	button, down := pad.PressedButton()
	switch snapStep(&o.drag, snapPointer{X: x, Y: y, Button: button, Down: down}, W, H) {
	case settleCancel:
		o.finish(snapshotOutcome{canceled: true})
		return
	case settleClick:
		r, ok := o.windowUnder(x, y)
		if !ok {
			o.finish(snapshotOutcome{canceled: true})
			return
		}
		o.finish(snapshotOutcome{rect: r})
		return
	case settleDrag:
		o.finish(snapshotOutcome{rect: rectToPx(o.drag.rect(), o.scale)})
		return
	}

	// 现在的高亮：拖动中是选框，否则是光标下的窗口。
	var sel dipRect
	var selPx pxRect
	switch {
	case o.drag.Active:
		sel = o.drag.rect()
		selPx = rectToPx(sel, o.scale)
	default:
		var ok bool
		selPx, ok = o.hoverRect(x, y)
		sel = clipDipRect(o.hover, W, H)
		if !ok || sel.empty() {
			sel = dipRect{}
		}
	}
	full := dipRect{0, 0, W, H}
	dragging := o.drag.Active && !sel.empty()
	hovering := selPx != (pxRect{}) && !dragging

	pad.Children(func() {
		ui.Image(c, o.bitmap).Absolute().Left(0).Top(0).Width(W).Height(H)
		strips := dimStrips(full, nil)
		if dragging || hovering {
			selPtr := sel
			strips = dimStrips(full, &selPtr)
		}
		for i, s := range strips {
			ui.Box(c.Key(i)).Absolute().Left(s.X).Top(s.Y).Width(s.W).Height(s.H).Background(ui.RGBA(0, 0, 0, snapshotDimAlpha))
		}
		// 顶部居中的操作提示条：每一帧都画——光标在桌面 / 任务栏上没有可高亮的窗口时，
		// 用户也得知道怎么操作。挂在指针层下面，落在它上面的按下照样算到指针层。
		ui.Column(c).Absolute().Left((W - snapshotHintWidth) / 2).Top(16).Width(snapshotHintWidth).Height(32).Center().Background(ui.Hex("#191919")).Radius(10).Children(func() {
			ui.Text(c, snapshotHint).FontSize(12).Font(popoverFont).TextColor(ui.Hex("#f7f7f5"))
		})
		if !dragging && !hovering {
			return
		}
		// 选框：外圈深色勾边 + 内圈亮蓝，亮底暗底都看得清
		ui.Box(c.Key("sel-out")).Absolute().Left(sel.X-1).Top(sel.Y-1).Width(sel.W+2).Height(sel.H+2).Border(1, ui.RGBA(0, 0, 0, 0.55))
		ui.Box(c.Key("sel-in")).Absolute().Left(sel.X).Top(sel.Y).Width(sel.W).Height(sel.H).Border(1, ui.Hex("#3d8bff"))
		text := fmt.Sprintf("%d × %d", selPx.W, selPx.H)
		lx, ly := labelPos(sel, estimateTextWidth(text), W, H)
		ui.Column(c).Absolute().Left(lx).Top(ly).Padding(3, 8).Background(ui.Hex("#191919")).Radius(6).Children(func() {
			ui.Text(c, text).FontSize(12).Font(popoverFont).TextColor(ui.Hex("#f7f7f5"))
		})
	})
}
