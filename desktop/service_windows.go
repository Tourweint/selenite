//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

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
