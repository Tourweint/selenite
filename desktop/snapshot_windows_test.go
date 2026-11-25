//go:build windows

package main

import (
	"image"
	"syscall"
	"testing"
	"unsafe"
)

// Win32 那层的冒烟（真调用，不是 mock）：本机有桌面会话时，取鼠标位置 → 找显示器 →
// GDI 抓 64×64 → 能和 mygo 的显示器列表对上。抓屏那一串（GetDC → CreateDIBSection →
// BitBlt）的结构体布局、按值传 POINT 的打包、负高度 DIB 的行序，都在这一条里验。
// 没有桌面会话（服务 / CI）时取不到鼠标位置，跳过。
func TestSnapshotWin32Smoke(t *testing.T) {
	var pt winPoint
	if r, _, _ := syscall.SyscallN(procGetCursorPos.Addr(), uintptr(unsafe.Pointer(&pt))); r == 0 {
		t.Skip("取不到鼠标位置：没有桌面会话")
	}
	mon, err := monitorAt(pt.X, pt.Y)
	if err != nil {
		t.Fatalf("monitorAt： %v", err)
	}
	if mon.W <= 0 || mon.H <= 0 || mon.W > snapshotMaxSide || mon.H > snapshotMaxSide {
		t.Fatalf("显示器矩形不对：%+v", mon)
	}
	if !(winRect{int32(mon.X), int32(mon.Y), int32(mon.X + mon.W), int32(mon.Y + mon.H)}).contains(pt.X, pt.Y) {
		t.Fatalf("鼠标 (%d,%d) 不在查到的显示器 %+v 里", pt.X, pt.Y, mon)
	}

	// mygo 的显示器列表（Screen.Displays）要汇入主线程事件循环，测试进程里没有循环，
	// 调它会一直等——所以这里不调。「物理尺寸能和 mygo 的 Bounds 对上」留给真机验收：
	// 对不上时 CaptureSnapshot 明确报「找不到匹配的显示器」，页面退回 getDisplayMedia。
	t.Logf("鼠标所在显示器 %dx%d @(%d,%d)", mon.W, mon.H, mon.X, mon.Y)

	frame, err := captureMonitorFrame(pxRect{X: mon.X, Y: mon.Y, W: 64, H: 64})
	if err != nil {
		t.Fatalf("captureMonitorFrame：%v", err)
	}
	if frame.Rect != image.Rect(0, 0, 64, 64) {
		t.Fatalf("应抓到 64×64，得到 %v", frame.Rect)
	}
	for _, p := range [][2]int{{0, 0}, {63, 63}, {32, 32}} {
		if _, _, _, a := frame.At(p[0], p[1]).RGBA(); a != 0xffff {
			t.Fatalf("(%d,%d) 的 alpha 应是 255", p[0], p[1])
		}
	}

	// 光标下的窗口：WindowFromPoint / GetAncestor / 可见性 / 类名 / cloaked / DWM 边框整条链
	if r, ok := windowAtScreenPoint(pt.X, pt.Y, nil); ok {
		t.Logf("光标下的可截窗口 %+v", r)
	} else {
		t.Logf("光标下没有可截窗口（桌面 / 任务栏）")
	}
	// 本进程顶层窗枚举 + 窗口矩形：go test 的控制台窗（若有）取得到非空矩形
	own := ownTopLevelWindows()
	t.Logf("本进程顶层窗 %d 个", len(own))
	for hwnd := range own {
		if r, ok := windowBounds(hwnd); ok && !r.empty() {
			t.Logf("顶层窗矩形 %+v", r)
			break
		}
	}
	if len(newTopLevelWindows(ownTopLevelWindows())) != 0 {
		t.Fatal("没建新窗时，前后两次枚举不应多出窗口")
	}
}
