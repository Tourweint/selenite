//go:build windows

package main

/*
hidden-exec_windows_test.go：startHidden 的代理验证（2026-11-08 扫尾批 9b）。

闪窗只有几十毫秒，截图不可靠，所以这里查的是**窗口对象本身**：
  1. 对照组 —— 用 CREATE_NEW_CONSOLE 故意开一个控制台，标题置为唯一串；
     必须能在屏幕上被枚举到（证明探测器有效，否则下面的"没找到"毫无意义）。
  2. 实验组 —— 同样一条命令走 startHidden；1.5s 内不许出现同名可见窗口。

对照组会真的在屏幕上闪一个约 2 秒的控制台（`ping -n 3`），这是用例的成本，
不是副作用：没有它，这条测试在任何实现下都会"通过"。
*/

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

var (
	user32            = syscall.NewLazyDLL("user32.dll")
	procEnumWindows   = user32.NewProc("EnumWindows")
	procIsWindowVis   = user32.NewProc("IsWindowVisible")
	procGetWindowText = user32.NewProc("GetWindowTextW")
)

// createNewConsole 是 CREATE_NEW_CONSOLE（0x10），只给对照组用。
const createNewConsole = 0x00000010

// visibleWindowWithTitle 枚举所有**可见**的顶层窗口，看标题里有没有 needle。
//
// 只看可见窗口是刻意的：CREATE_NO_WINDOW 下 conhost 可能仍存在无窗口的控制台，
// 用户投诉的是"看得见的那一下"，判据就该与它一致。
func visibleWindowWithTitle(needle string) bool {
	found := false
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if ok, _, _ := procIsWindowVis.Call(hwnd); ok == 0 {
			return 1 // 不可见，跳过
		}
		var buf [512]uint16
		n, _, _ := procGetWindowText.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		if n == 0 {
			return 1
		}
		if strings.Contains(syscall.UTF16ToString(buf[:n]), needle) {
			found = true
			return 0 // 找到就停
		}
		return 1 // 继续枚举
	})
	procEnumWindows.Call(cb, 0)
	return found
}

func waitVisibleWindow(needle string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if visibleWindowWithTitle(needle) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestStartHiddenCreatesNoVisibleWindow(t *testing.T) {
	if _, err := exec.LookPath("cmd"); err != nil {
		t.Skip("没有 cmd.exe，跳过")
	}

	// ── 对照组：证实探测器看得见一个真控制台 ──
	ctrlTitle := fmt.Sprintf("lifediary-probe-ctrl-%d", time.Now().UnixNano())
	ctrl := exec.Command("cmd", "/c", "title "+ctrlTitle+" & ping -n 3 127.0.0.1 >nul")
	ctrl.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewConsole}
	if err := ctrl.Start(); err != nil {
		t.Fatalf("对照组启动失败: %v", err)
	}
	defer func() { _ = ctrl.Process.Kill(); _ = ctrl.Wait() }()

	if !waitVisibleWindow(ctrlTitle, 3*time.Second) {
		t.Fatal("对照组没有出现可见窗口：探测器不可信，本用例的结论不成立")
	}

	// ── 实验组：startHidden 同样一条命令，不许出现可见窗口 ──
	hiddenTitle := fmt.Sprintf("lifediary-probe-hidden-%d", time.Now().UnixNano())
	hidden := exec.Command("cmd", "/c", "title "+hiddenTitle+" & ping -n 3 127.0.0.1 >nul")
	if err := startHidden(hidden); err != nil {
		t.Fatalf("startHidden 启动失败: %v", err)
	}
	defer func() { _ = hidden.Process.Kill(); _ = hidden.Wait() }()

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if visibleWindowWithTitle(hiddenTitle) {
			t.Fatalf("startHidden 拉起的子进程出现了可见窗口（标题 %q）", hiddenTitle)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
