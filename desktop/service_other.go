//go:build !windows

package main

import "os/exec"

// 非 Windows 没有"控制台窗口"这回事，留个空实现让代码保持一份。
func hideWindow(_ *exec.Cmd) {}
