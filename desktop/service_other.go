//go:build !windows

package main

import "os/exec"

// 非 Windows 没有"控制台窗口"这回事，留个空实现让代码保持一份。
func hideWindow(_ *exec.Cmd) {}

// applyNoWindow 是 startHidden 的平台落点，非 Windows 无事可做。
func applyNoWindow(_ *exec.Cmd) {}
