//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// createNoWindow 是 CreateProcess 的 CREATE_NO_WINDOW（0x08000000）：
// 子进程有控制台（标准句柄照常可用），但不分配可见窗口。
//
// 不能和 DETACHED_PROCESS 混用（两者互斥），所以 applyNoWindow 只在调用方
// 没写 CreationFlags 时才补它——node 那条路要的是 DETACHED_PROCESS。
const createNoWindow = 0x08000000

// hideWindow 让子进程完全不出现控制台窗口。
//
// DETACHED_PROCESS(0x8)：不继承父进程的控制台，也不会新建可见窗口；
// CREATE_NEW_PROCESS_GROUP(0x200)：Ctrl+C 之类的信号不要顺带打到它身上。
func hideWindow(cmd *exec.Cmd) {
	const (
		detachedProcess       = 0x00000008
		createNewProcessGroup = 0x00000200
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedProcess | createNewProcessGroup,
	}
}

// applyNoWindow 是 startHidden 的平台落点（见 hidden-exec.go）。
// 已是 DETACHED_PROCESS 的调用不覆盖它的 CreationFlags：那是"服务要活过壳"
// 的语义，比"别闪窗"更强。
func applyNoWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	if cmd.SysProcAttr.CreationFlags == 0 {
		cmd.SysProcAttr.CreationFlags = createNoWindow
	}
}
