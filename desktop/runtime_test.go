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
	"time"
)

func TestServicePort(t *testing.T) {
	cases := map[string]int{
		"http://127.0.0.1:39847": 39847,
		"http://127.0.0.1:5000/": 5000,
		"http://127.0.0.1":       39847, // 没写端口 → 默认值
		"":                       39847,
		"not a url":              39847,
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

// 批 21 §五：守护熔断状态机（不需要真起 Node 的那部分）。
// 窗口内 3 次失败开熔断；健康/手动重试清零；窗口外的旧失败不计入。
func TestWatchBreaker(t *testing.T) {
	r := &runtimeCtl{base: "http://127.0.0.1:1"}
	base := time.Now()
	if r.BreakerOpen() {
		t.Fatal("新控制器不该带着熔断")
	}
	// 窗口内两次失败：还不开
	if r.NotePullFailure(base) {
		t.Fatal("1 次失败不该开熔断")
	}
	if r.NotePullFailure(base.Add(time.Minute)) {
		t.Fatal("2 次失败不该开熔断")
	}
	// 第三次（仍在 10 分钟窗口内）→ 熔断打开
	if !r.NotePullFailure(base.Add(2 * time.Minute)) {
		t.Fatal("窗口内第 3 次失败应开熔断")
	}
	if !r.BreakerOpen() {
		t.Fatal("熔断应已打开")
	}
	// 清零（手动重试/健康）→ 关
	r.ResetWatchBreaker()
	if r.BreakerOpen() {
		t.Fatal("清零后熔断应解除")
	}
	// 窗口滑动：两次在窗口内、第三次已滑出 → 不开
	r2 := &runtimeCtl{base: "http://127.0.0.1:1"}
	_ = r2.NotePullFailure(base)
	_ = r2.NotePullFailure(base.Add(time.Minute))
	if r2.NotePullFailure(base.Add(11 * time.Minute)) {
		t.Fatal("10 分钟窗口外的失败不应计入（老失败不该永久记账）")
	}
}
