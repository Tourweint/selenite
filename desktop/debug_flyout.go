// 菜单首帧残影的复现台：LIFEDIARY_DEBUG_FLYOUT=1 时 main() 走这里，
// 不起服务、不建托盘、不连壳页面——迷你父窗 + 真实 menuView 的 flyout，
// 按 ShowMenu 的复用姿势走三个阶段（种子帧 → 矮菜单缩高首开；高菜单 → 矮菜单再缩）。
// stdout 打标记与窗口尺寸，PowerShell 按标记定时截屏，跑完自退。
package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func dbgFlyout() {
	app := mygo.App
	app.WhenReady(func() {
		parent := mygo.NewWindow(mygo.WindowOptions{
			Title:  "menu-debug",
			X:      980,
			Y:      420,
			Width:  430,
			Height: 320,
		})
		go dbgRun(parent)
	})
	app.Run()
}

func dbgSizes(tag string, fl *mygo.Window) {
	w, h := fl.Size()
	cw, ch := fl.ContentSize()
	fmt.Printf("%s size=%dx%d content=%dx%d\n", tag, w, h, cw, ch)
}

func dbgShow(fl *mygo.Window, anchor mygo.Rectangle, tag string) {
	fl.SetAnchor(anchor)
	fl.Invalidate()
	_, _ = fl.CapturePage()
	dbgSizes("pre-Show "+tag, fl)
	fl.Show()
	dbgSizes("post-Show "+tag, fl)
}

func dbgHide(fl *mygo.Window) {
	fl.Hide()
	time.Sleep(1500 * time.Millisecond) // 给外部截图留出 +900ms 那一张
}

func dbgRun(parent *mygo.Window) {
	time.Sleep(600 * time.Millisecond) // 等父窗首帧

	// 种子帧（同 PrewarmMenus：9 行）
	menuSnap.Store(&menuState{items: prewarmItems})
	fl := mygo.NewFlyout(mygo.FlyoutOptions{
		Parent:     parent,
		Placement:  mygo.PlacementBottomStart,
		Gap:        2,
		FitContent: true,
		MinWidth:   176,
		MaxWidth:   280,
		Focusable:  true,
		Shadow:     false,
		Hidden:     true,
		Content:    ui.View(menuView),
	})
	_, _ = fl.CapturePage()
	fmt.Println("SEEDED")

	anchor := mygo.Rectangle{X: 200, Y: 120, Width: 30, Height: 22}

	// 阶段 A：真菜单 1 行（执事 ⋯ 的真实形状），缩高首开
	menuSnap.Store(&menuState{items: []MenuItem{{Label: "新建执事"}}})
	dbgShow(fl, anchor, "A")
	fmt.Println("MENU-SHOWN-A")
	time.Sleep(1500 * time.Millisecond)
	dbgHide(fl)

	// 阶段 B1：高菜单（6 行）
	menuSnap.Store(&menuState{items: []MenuItem{
		{Label: "重命名"}, {Label: "置顶"}, {Label: "归档"}, {Label: "分享"}, {Label: "复制"}, {Label: "删除", Danger: true},
	}})
	dbgShow(fl, anchor, "B1")
	fmt.Println("MENU-SHOWN-B1")
	time.Sleep(1500 * time.Millisecond)
	dbgHide(fl)

	// 阶段 B2：再缩回 1 行
	menuSnap.Store(&menuState{items: []MenuItem{{Label: "新建执事"}}})
	dbgShow(fl, anchor, "B2")
	fmt.Println("MENU-SHOWN-B2")
	time.Sleep(1500 * time.Millisecond)
	dbgHide(fl)

	fmt.Println("DBG-DONE")
	app := mygo.App
	app.Exit(0)
}
