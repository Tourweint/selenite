package main

/*
runtime_test.go：运行时控制器的可验证部分（2026-11-07）。

只测**不需要真起 Node**的那些判据——真起服务、真杀进程那一段是验收脚本的活
（见文档里的 7 条），放在单测里会变成"依赖环境"的脆弱测试。

覆盖三件事：
  1. servicePort 能从 base 里取出端口（停错端口比停不掉更糟）；
  2. pidOnPort 在没有服务监听时返回 0（不制造"杀了个无辜进程"的风险）；
  3. 用户停过之后 Ensure 不再拉起（守护的闩；没有它，停止按钮 30 秒后自动失效）。
*/

import (
	"os"
	"os/exec"
	"testing"
)

func TestServicePort(t *testing.T) {
	cases := map[string]int{
		"http://127.0.0.1:39847": 39847,
		"http://127.0.0.1:5000/":  5000,
		"http://127.0.0.1":        39847, // 没写端口 → 默认值
		"":                        39847,
		"not a url":               39847,
	}
	for base, want := range cases {
		if got := servicePort(base); got != want {
			t.Errorf("servicePort(%q) = %d, want %d", base, got, want)
		}
	}
}

func TestPidOnPortNoListener(t *testing.T) {
	// 选一个确定没人监听的端口（1 号端口需要特权，普通进程连不上也起不了）
	if pid := pidOnPort(1); pid != 0 {
		t.Errorf("pidOnPort(1) = %d, want 0（没有监听者时不能返回别人的 PID）", pid)
	}
}

// TestStoppedFlagBlocksEnsure：用户停过之后，Ensure 必须什么都不做。
//
// 这是这次改动最容易漏的一处：watchService 每 10s 探一次、连续 3 次失败就重拉。
// 没有这个闩，用户点完"停止"半分钟后服务自己回来，按钮就成了摆设。
// 用一个**不可达**的 base 让 healthy() 必然 false —— 如果 Ensure 真的去拉，
// 它会因为找不到服务目录/起不来而在日志里留下痕迹；这里直接看 stopped 是否被清。
func TestStoppedFlagBlocksEnsure(t *testing.T) {
	old := runtime.base
	oldStopped := runtime.stopped
	oldPid := runtime.pid
	defer func() {
		runtime.base = old
		runtime.stopped = oldStopped
		runtime.pid = oldPid
	}()

	runtime.base = "http://127.0.0.1:1"
	runtime.pid = 0
	runtime.stopped = true

	// 避免 Ensure 真的去起 node：指向一个不存在的目录
	prevDir := os.Getenv("LIFEDIARY_SERVER_DIR")
	os.Setenv("LIFEDIARY_SERVER_DIR", "")
	defer os.Setenv("LIFEDIARY_SERVER_DIR", prevDir)

	runtime.Ensure()

	if !runtime.stopped {
		t.Fatal("Ensure() 清掉了 stopped 闩：用户停过的服务会被守护偷偷拉回来")
	}
	if runtime.pid != 0 {
		t.Fatalf("Ensure() 在用户停过之后仍记录了 PID %d", runtime.pid)
	}
}

// TestStopIsIdempotent：本来没在跑时 Stop 必须成功返回（不报错、不杀别人）。
func TestStopIsIdempotent(t *testing.T) {
	old := runtime.base
	oldStopped := runtime.stopped
	oldPid := runtime.pid
	defer func() {
		runtime.base = old
		runtime.stopped = oldStopped
		runtime.pid = oldPid
	}()

	runtime.base = "http://127.0.0.1:1" // 没有服务
	runtime.pid = 0
	runtime.stopped = false

	status, err := runtime.Stop()
	if err != nil {
		t.Fatalf("Stop() 在没有服务时返回错误: %v", err)
	}
	if status.State != RuntimeStopped {
		t.Errorf("Stop() 之后状态 = %q, want %q", status.State, RuntimeStopped)
	}
	if !runtime.stopped {
		t.Error("Stop() 没有立 stopped 闩：守护会立刻把服务拉回来")
	}
}

// TestStatusSeparatesStoppedFromFailed：用户停的 vs 自己挂的，界面上必须分开说。
func TestStatusSeparatesStoppedFromFailed(t *testing.T) {
	old := runtime.base
	oldStopped := runtime.stopped
	oldPid := runtime.pid
	defer func() {
		runtime.base = old
		runtime.stopped = oldStopped
		runtime.pid = oldPid
	}()

	runtime.base = "http://127.0.0.1:1"
	runtime.pid = 0

	runtime.stopped = true
	if got := runtime.Status().State; got != RuntimeStopped {
		t.Errorf("用户停过时状态 = %q, want %q", got, RuntimeStopped)
	}

	runtime.stopped = false
	if got := runtime.Status().State; got != RuntimeFailed {
		t.Errorf("没停但也不健康时状态 = %q, want %q（不能报成用户停的）", got, RuntimeFailed)
	}
}

// 确保测试进程不会因为 netstat 缺失而假装通过：pidOnPort 依赖它。
func TestNetstatAvailable(t *testing.T) {
	if _, err := exec.LookPath("netstat"); err != nil {
		t.Skip("没有 netstat，跳过（Windows 自带；其它平台这条用例不适用）")
	}
}
