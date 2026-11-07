package main

/*
verify_runtime_test.go：真停真起的验收（2026-11-07）。

与 runtime_test.go 的分工：那个测纯判据（端口解析、闩），不碰真进程；
这里**真的停掉正在跑的服务、真的再起回来**，验的是"点了按钮会发生什么"。

为什么用 Go test 而不是手工点界面：桌面壳的窗口要人看着，而这条链路的成败判据
全是可观测的（端口有没有、healthz 通不通、PID 变没变），写成用例才能重复跑。

默认跳过：它会短暂停掉本机服务，不该在随手 `go test ./...` 时发生。
要跑就显式开：

	LIFEDIARY_E2E_RUNTIME=1 go test -run TestRuntimeStopStartE2E -v ./desktop

注意：跑之前服务得是在跑的（壳或手动起的都行），否则这条用例退化成一个空转。
*/

import (
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"
)

func requireE2E(t *testing.T) {
	t.Helper()
	if os.Getenv("LIFEDIARY_E2E_RUNTIME") != "1" {
		t.Skip("跳过真停真起（设 LIFEDIARY_E2E_RUNTIME=1 才跑）")
	}
}

func TestRuntimeStopStartE2E(t *testing.T) {
	requireE2E(t)
	runtime.base = baseURL()
	port := servicePort(runtime.base)

	if !listening(port) {
		t.Fatalf("端口 %d 上没有服务：这条用例要先有活着的服务才验得出东西", port)
	}
	before := pidOnPort(port)
	t.Logf("起始 PID=%d port=%d", before, port)

	// 1) 停
	status, err := runtime.Stop()
	if err != nil {
		t.Fatalf("Stop 失败: %v", err)
	}
	if status.State != RuntimeStopped {
		t.Errorf("Stop 之后 state=%q, want stopped", status.State)
	}
	deadline := time.Now().Add(8 * time.Second)
	for listening(port) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if listening(port) {
		t.Fatal("Stop 之后端口仍被占用：孤儿进程没杀干净（tsx loader 的 /T 没生效？）")
	}
	if runtime.UserStopped() != true {
		t.Error("Stop 之后 stopped 闩没立起来")
	}
	t.Logf("已停止，端口 %d 已释放", port)

	// 2) 守护不许重拉
	runtime.Ensure()
	time.Sleep(500 * time.Millisecond)
	if listening(port) {
		t.Fatal("Ensure 在用户停过之后又把服务拉起来了：守护的闩没生效")
	}

	// 3) 起
	status, err = runtime.Start()
	if err != nil {
		t.Fatalf("Start 失败: %v", err)
	}
	if status.State != RuntimeRunning {
		t.Errorf("Start 之后 state=%q, want running", status.State)
	}
	if !healthy(runtime.base) {
		t.Fatal("Start 返回成功但 /healthz 不通")
	}
	after := pidOnPort(port)
	if after == 0 {
		t.Fatal("Start 之后端口上没人")
	}
	if after == before {
		t.Errorf("重启后 PID 没变（%d）：可能根本没换进程", after)
	}
	t.Logf("已启动，新 PID=%d", after)

	// 4) 数据还在（历史不该被重启弄丢）
	if err := pingMessages(runtime.base); err != nil {
		t.Errorf("重启后读历史失败: %v", err)
	}
}

// pingMessages 读一次会话索引，确认"服务回来了并且库是通的"。
//
// 走真 HTTP（不是只看端口通不通）：端口开着但 durable 打不开时，正是上次那个
// "全站 500 到重启为止"的现场，只探端口会把这种状态误判成健康。
func pingMessages(base string) error {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(base + "/api/v1/agent/chats?limit=1")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("HTTP %d：服务活着但接口仍然报错", resp.StatusCode)
	}
	return nil
}
