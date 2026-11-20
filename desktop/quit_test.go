package main

import (
	"os"
	"testing"
)

// 退出时"在飞单"的判定（2026-11-20 按 chancellor 口径核对）：
// 终态是 done / needs_you / idle / failed / aborted；reviewing 已随验收层退役。
// idle（等子单）不算在飞——子单自己也在列表里，算两遍会多报。
func TestCountNonTerminal(t *testing.T) {
	body := []byte(`{"tickets":[
		{"status":"received"},{"status":"planning"},{"status":"planned"},
		{"status":"dispatching"},{"status":"done"},{"status":"needs_you"},
		{"status":"idle"},{"status":"failed"},{"status":"aborted"},{"status":"reviewing"}
	]}`)
	if got := countNonTerminal(body); got != 4 {
		t.Fatalf("应数出 4 个在飞单，实际 %d", got)
	}
	if got := countNonTerminal([]byte("not json")); got != 0 {
		t.Fatalf("解析失败应一律按 0 处理，实际 %d", got)
	}
}

func TestQuitStopsServiceSwitch(t *testing.T) {
	t.Setenv("LIFEDIARY_QUIT_STOP_SERVICE", "")
	if !quitStopsServiceEnabled() {
		t.Fatal("缺省应停服务")
	}
	t.Setenv("LIFEDIARY_QUIT_STOP_SERVICE", " off ")
	if quitStopsServiceEnabled() {
		t.Fatal("off 应回到旧形态（退出只关壳）")
	}
}

// 回落到记忆里的旧 PID 之前要确认"还是 node 吗"：Windows 会回收 PID，
// 服务崩掉后那个数字可能已经属于别的程序，直接 taskkill /T 会误杀。
func TestIsNodeProcess(t *testing.T) {
	if isNodeProcess(0) {
		t.Fatal("0 不该被认成 node")
	}
	if isNodeProcess(os.Getpid()) {
		t.Fatal("测试进程（不是 node.exe）不该被认成 node")
	}
}

// 端口上没人、记忆里的旧 PID 已经被回收给别的程序：Stop 必须丢弃这个数字，
// 而不是对着它 taskkill（这条路径在"退出停服务"之后每次退出都会走）。
func TestStopDropsRecycledPid(t *testing.T) {
	oldBase, oldPid, oldStopped := runtime.base, runtime.pid, runtime.stopped
	defer func() {
		runtime.base, runtime.pid, runtime.stopped = oldBase, oldPid, oldStopped
	}()

	runtime.base = "http://127.0.0.1:1" // 没有服务
	runtime.pid = os.Getpid()           // 假装记下的旧 PID 现在属于测试进程
	runtime.stopped = false

	if _, err := runtime.Stop(); err != nil {
		t.Fatalf("Stop() 不该报错: %v", err)
	}
	if runtime.pid != 0 {
		t.Fatal("旧 PID 已不是 node，应丢弃而不是留着下次误杀")
	}
}
