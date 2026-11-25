package main

import (
	"testing"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// 开关：=off 关（大小写与空白都容忍），其余与未设都算开。
func TestNativePopoversEnabled(t *testing.T) {
	t.Setenv("LIFEDIARY_NATIVE_POPOVERS", "off")
	if nativePopoversEnabled() {
		t.Fatal("off 应该关掉原生弹出层")
	}
	t.Setenv("LIFEDIARY_NATIVE_POPOVERS", " OFF ")
	if nativePopoversEnabled() {
		t.Fatal("带空格的 OFF 也应该关掉")
	}
	t.Setenv("LIFEDIARY_NATIVE_POPOVERS", "")
	if !nativePopoversEnabled() {
		t.Fatal("未设/空值默认应该开")
	}
	t.Setenv("LIFEDIARY_NATIVE_POPOVERS", "on")
	if !nativePopoversEnabled() {
		t.Fatal("on 应该开")
	}
}

// 摆位白名单：认不出的回 bottom-start，页面传脏串也不会把菜单摆到天上去。
func TestPlacementFromRequest(t *testing.T) {
	cases := map[string]mygo.Placement{
		"":             mygo.PlacementBottomStart,
		"bottom-start": mygo.PlacementBottomStart,
		"bottom-end":   mygo.PlacementBottomEnd,
		"top-start":    mygo.PlacementTopStart,
		"top":          mygo.PlacementTop,
		"bogus":        mygo.PlacementBottomStart,
		"left":         mygo.PlacementBottomStart,
	}
	for in, want := range cases {
		if got := placementFromRequest(in); got != want {
			t.Fatalf("placementFromRequest(%q) = %v，要 %v", in, got, want)
		}
	}
}

// 提示拆行：CRLF 污染剥掉、尾空行掉掉、全空白不出。
func TestSplitTipLines(t *testing.T) {
	if got := splitTipLines("第一行\r\n第二行\n"); len(got) != 2 || got[0] != "第一行" || got[1] != "第二行" {
		t.Fatalf("CRLF 与尾空行处理不对：%q", got)
	}
	if got := splitTipLines("   "); got != nil {
		t.Fatalf("全空白应出 nil：%q", got)
	}
	if got := splitTipLines(""); got != nil {
		t.Fatalf("空串应出 nil：%q", got)
	}
}

// 高亮导航：跳过禁用与分隔线、到头回绕、全不可用原地不动。
func TestMenuHighlightNavigation(t *testing.T) {
	items := []MenuItem{
		{Label: "禁用", Disabled: true},
		{Separator: true},
		{Label: "全选"},
		{Label: "复制", Disabled: true},
		{Label: "粘贴"},
	}
	if got := firstEnabledItem(items); got != 2 {
		t.Fatalf("初始高亮应落在第一个可用项 2，得到 %d", got)
	}
	if got := nextEnabledItem(items, 2, 1); got != 4 {
		t.Fatalf("从 2 向下应到 4，得到 %d", got)
	}
	if got := nextEnabledItem(items, 4, 1); got != 2 {
		t.Fatalf("从 4 向下应回绕到 2，得到 %d", got)
	}
	if got := nextEnabledItem(items, 2, -1); got != 4 {
		t.Fatalf("从 2 向上应回绕到 4，得到 %d", got)
	}
	all := []MenuItem{{Disabled: true}, {Separator: true}}
	if got := nextEnabledItem(all, 0, 1); got != 0 {
		t.Fatalf("全不可用应原地不动，得到 %d", got)
	}
}

// 六套主题的色板都得齐全：任何一项是零值色（黑透明），菜单就会画出看不见的行。
// 这是给「往 tokens.css 加第七套主题却忘了壳这边」的人留的哨兵。
// 名单与 theme.go 的常量逐个对上：再加主题时这里和 themeKnown 必须一起动。
func TestPopoverPalettesComplete(t *testing.T) {
	for _, name := range []string{
		themeWhite, themeIndigo, themeBlack, themeCeladon,
		themeDevin, themeAntigravity,
	} {
		pal := popoverPalette(name)
		for fieldName, c := range map[string]ui.Color{
			"bg": pal.bg, "hover": pal.hover, "hoverDanger": pal.hoverDanger,
			"text": pal.text, "text3": pal.text3, "danger": pal.danger, "divider": pal.divider,
			"border": pal.border,
		} {
			if c.A == 0 {
				t.Fatalf("%s 主题的 %s 是零值色", name, fieldName)
			}
		}
	}
	// 每套都得认得：认不出的落 devin 兜底，色板就和 devin 一模一样——
	// 名单里谁漏配了 case，这一条会把它揪出来（devin 自己就是兜底，除外）。
	devin := popoverPalette(themeDevin)
	for _, name := range []string{themeWhite, themeIndigo, themeBlack, themeCeladon, themeAntigravity} {
		if popoverPalette(name) == devin {
			t.Fatalf("%s 的色板与 devin 兜底完全相同，疑似漏了 case", name)
		}
	}
	// 认不出或已删的主题（paper / codex）落 devin 兜底，不该 panic 也不该是零值色。
	for _, name := range []string{"mystery", "paper", "codex"} {
		pal := popoverPalette(name)
		if pal.bg.A == 0 {
			t.Fatalf("%s 的兜底色板不应是零值色", name)
		}
		if pal != devin {
			t.Fatalf("认不出的主题 %q 应落 devin 兜底，实际 %+v", name, pal)
		}
	}
}

// 坐标 1:1 直通（前提：壳不开 ZoomFactor，见 popovers.go 文头）。
func TestRectToGoPassthrough(t *testing.T) {
	got := rectToGo(popoverRect{X: 12, Y: 34, Width: 56, Height: 78})
	if got != (mygo.Rectangle{X: 12, Y: 34, Width: 56, Height: 78}) {
		t.Fatalf("矩形应原样直通：%v", got)
	}
}

// menuView 无窗口真渲染（mygo 的 ui.NewTester）：行画得出来、键盘导航跳过禁用项、
// Enter 把所选序号回给 ShowMenu 的通道。主题钉死，别读用户机器上的配置。
func TestMenuViewWindowless(t *testing.T) {
	t.Setenv("LIFEDIARY_THEME", "indigo")
	menuSnap.Store(&menuState{
		anchor:    mygo.Rectangle{},
		placement: mygo.PlacementBottomStart,
		items: []MenuItem{
			{Label: "全选", Kbd: "Ctrl+A"},
			{Label: "复制", Disabled: true},
			{Label: "粘贴", Danger: true},
		},
	})
	menuHover.Store(0)
	ch := make(chan int, 1)
	menuNow.Store(&menuOpen{win: nil, pick: ch})
	tt := ui.NewTester(menuView, 240, 160)
	defer func() { menuSnap.Store(nil); menuNow.Store(nil) }()
	if !tt.HasText("全选") || !tt.HasText("Ctrl+A") || !tt.HasText("粘贴") {
		t.Fatalf("菜单行没画全：%v", tt.Texts())
	}
	// 向下：从「全选」(0) 跳过禁用的「复制」(1) 落到「粘贴」(2)
	tt.Key(0, ui.KeyDown)
	if menuHover.Load() != 2 {
		t.Fatalf("键盘下移应跳过禁用项落到 2，得到 %d", menuHover.Load())
	}
	// Enter 选中：序号回给通道（win 为 nil 时 menuPick 只发不藏，测试里正合适）
	tt.Key(0, ui.KeyEnter)
	select {
	case idx := <-ch:
		if idx != 2 {
			t.Fatalf("Enter 应回 2，得到 %d", idx)
		}
	default:
		t.Fatal("Enter 没有把所选序号回给通道")
	}
}

// 鼠标点行选中（2026-11-22 修「侧栏 ⋯ 展开的小菜单点不了」）：menuView 一直只处理
// 悬停高亮与键盘 Enter，行没接 Clicked——ctx 根修前 DOM 兜底菜单在底下替它接了点击，
// 根修后兜底退场，原生菜单「只能看不能点」才露出来。
func TestMenuViewMouseClickSelects(t *testing.T) {
	t.Setenv("LIFEDIARY_THEME", "indigo")
	menuSnap.Store(&menuState{
		anchor:    mygo.Rectangle{},
		placement: mygo.PlacementBottomStart,
		items: []MenuItem{
			{Label: "重命名"},
			{Label: "置顶"},
			{Separator: true},
			{Label: "归档"},
		},
	})
	menuHover.Store(0)
	ch := make(chan int, 1)
	menuNow.Store(&menuOpen{win: nil, pick: ch})
	tt := ui.NewTester(menuView, 240, 200)
	defer func() { menuSnap.Store(nil); menuNow.Store(nil) }()
	tt.Frame()

	// 点第三项（普通行）→ 序号 1；点分隔线不算。
	if err := tt.Click("置顶"); err != nil {
		t.Fatalf("点不到菜单行：%v", err)
	}
	tt.Frame()
	select {
	case idx := <-ch:
		if idx != 1 {
			t.Fatalf("鼠标点「置顶」应回 1，得到 %d", idx)
		}
	default:
		t.Fatal("鼠标点击菜单行没有把序号回给通道")
	}
}

// 收起状态机：CAS 只收自己还「在位」的那张——并发的下一次 ShowMenu 会复用同一张
// 常驻窗、换上自己的新 waiter，旧调用迟到的收起不能误伤新的。
func TestDismissMenuGuard(t *testing.T) {
	old := &menuOpen{win: nil, pick: make(chan int, 1)}
	menuNow.Store(old)
	dismissMenu(old)
	select {
	case <-old.pick:
	default:
		t.Fatal("收起应给旧 waiter 回 -1")
	}
	if menuNow.Load() != nil {
		t.Fatal("收起后应无当前菜单")
	}
	// 旧调用迟到的收起：当前已经换成新的，不得动它
	fresh := &menuOpen{win: nil, pick: make(chan int, 1)}
	menuNow.Store(fresh)
	dismissMenu(old)
	select {
	case <-fresh.pick:
		t.Fatal("旧调用的收起不该误伤新 waiter")
	default:
	}
	if menuNow.Load() != fresh {
		t.Fatal("当前菜单应仍是新的")
	}
	menuNow.Store(nil)
}

// tipView 无窗口真渲染：多行按 \n 拆开各画一行。
func TestTipViewWindowless(t *testing.T) {
	tipSnap.Store(&tipState{lines: splitTipLines("第一行\n第二行")})
	defer func() { tipSnap.Store(nil) }()
	tt := ui.NewTester(tipView, 320, 80)
	if !tt.HasText("第一行") || !tt.HasText("第二行") {
		t.Fatalf("提示两行没都画出来：%v", tt.Texts())
	}
}
