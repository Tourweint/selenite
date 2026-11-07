package main

/*
运行时控制器（2026-11-07）。

为什么要写在壳里而不是页面里：页面杀不掉自己的后端——它一点"停止"，接下来每个
fetch 都失败，连"我现在是什么状态"都问不出来。只有壳知道三件事：服务从哪个目录起、
PID 是多少、该不该重新拉起。所以分工照旧：**壳管进程的起停与探活，业务全走 HTTP**。

与 ensureService（本文件里已退役）的区别不只是多几个函数：
  - 记住"这次是用户主动停的"（`stopped` 闩），否则 watchService 30 秒后就把它偷偷拉回来；
  - 记住自己拉起的 PID（`pid`），停下来才知道该杀谁；
  - 停完要等端口真空出来，不然后脚 Start 立刻撞 EADDRINUSE。

分工上的一个判断：**"谁在监听这个端口"以端口为准，不以记忆为准**。
PID 会被系统回收，我们自己记的那个数可能早就变成别的进程；而端口上那个才是
现在真在提供服务的。所以 Status/Stop 都先查端口，只有查不到时才回落到 r.pid。
*/

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RuntimeState 是给界面看的四态；不要拿 healthy() 直接推断，
// 因为"用户停的"和"自己挂的"在界面上必须分开说。
type RuntimeState string

const (
	RuntimeRunning  RuntimeState = "running"
	RuntimeStarting RuntimeState = "starting"
	RuntimeStopped  RuntimeState = "stopped"
	RuntimeFailed   RuntimeState = "failed" // 不是用户停的，但也不健康
)

// RuntimeStatus 是 `Shell.RuntimeStatus` 的返回，前端据此画按钮。
type RuntimeStatus struct {
	State   RuntimeState `json:"state"`
	PID     int          `json:"pid"`
	Port    int          `json:"port"`
	Owned   bool         `json:"owned"` // true = 这份进程是壳自己拉起来的
	Healthy bool         `json:"healthy"`
	CanStop bool         `json:"canStop"`
}

type runtimeCtl struct {
	mu   sync.Mutex
	base string
	// stopped = 用户主动停过。守护进程与开窗都不许重拉；Start() 会清掉它。
	stopped bool
	// pid = 壳自己拉起的那份（0 表示不是壳起的：pnpm dev 起的、或还没起）。
	pid int
	// busy = 正在起（Start 里拉起后等就绪的那几十秒），界面显示"启动中"。
	busy bool
}

var runtime = &runtimeCtl{base: defaultBaseURL}

// servicePort 从 base 里取端口；取不到就用默认值。
func servicePort(base string) int {
	if u, err := url.Parse(base); err == nil && u.Port() != "" {
		if n, err := strconv.Atoi(u.Port()); err == nil && n > 0 {
			return n
		}
	}
	return 39847
}

// listening 比 /healthz 更根本：刚起、还在加载技能与记忆时 healthz 可能还没通，
// 但端口已经被占住了。停完等端口腾空、以及判断"端口上有没有人"，都用这个。
func listening(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// pidOnPort 找出监听该端口的进程。
//
// 只在人点停止、以及查状态时跑，不在热路径上；所以用 netstat 解析就够，
// 不为它维护一套 TCP 表 → PID 的 syscall（那是要跟着 Windows 版本变的）。
func pidOnPort(port int) int {
	out, err := exec.Command("netstat", "-ano", "-p", "TCP").Output()
	if err != nil {
		return 0
	}
	needle := fmt.Sprintf(":%d", port)
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || !strings.EqualFold(f[3], "LISTENING") || !strings.HasSuffix(f[1], needle) {
			continue
		}
		if pid, err := strconv.Atoi(f[4]); err == nil {
			return pid
		}
	}
	return 0
}

func (r *runtimeCtl) Status() RuntimeStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.statusLocked()
}

func (r *runtimeCtl) statusLocked() RuntimeStatus {
	port := servicePort(r.base)
	up := healthy(r.base)

	// 顺序有讲究（2026-11-07 实测踩过）：**先看真实状态，再看"正在启动"**。
	// 反过来写会把"已经起来了"误报成 starting——Start() 是等到 healthy 才返回的，
	// 那时 busy 还没清（defer 在 return 之后才跑），界面就会一直停在"启动中"。
	var state RuntimeState
	switch {
	case up:
		state = RuntimeRunning
	case r.busy:
		state = RuntimeStarting
	case r.stopped:
		state = RuntimeStopped
	default:
		state = RuntimeFailed
	}

	pid := pidOnPort(port)
	if pid == 0 {
		pid = r.pid // 端口上没人但还记得自己起过：把它当作"挂掉的旧进程"
	}
	return RuntimeStatus{
		State:   state,
		PID:     pid,
		Port:    port,
		Owned:   r.pid != 0,
		Healthy: up,
		CanStop: pid != 0,
	}
}

// UserStopped 给守护进程看：用户停的，别重拉。
//
// 这个闩是这次改动最容易漏的一处：watchService 每 10s 探一次、连续 3 次失败就
// 自动重拉。没有它，用户点完"停止"半分钟后服务自己回来，按钮就成了摆设。
func (r *runtimeCtl) UserStopped() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopped
}

func (r *runtimeCtl) Start() (RuntimeStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.startLocked()
}

func (r *runtimeCtl) startLocked() (RuntimeStatus, error) {
	if healthy(r.base) {
		r.stopped = false // 已经活着：清掉闩，免得守护被一个过期的"停过"卡住
		return r.statusLocked(), nil
	}
	dir := serverDir()
	if dir == "" {
		return r.statusLocked(), errors.New("找不到服务目录（可设 LIFEDIARY_SERVER_DIR）")
	}

	r.busy = true
	defer func() { r.busy = false }()

	cmd := exec.Command("node", "--import", "tsx", "src/index.ts")
	cmd.Dir = dir
	env := os.Environ()
	// 密钥主落点是 .env（2026-11-06 起，服务端 loadEnvFile 首行加载）；
	// 这里只是兼容旧部署的兜底映射：DASHSCOPE_API_KEY → LLM_API_KEY。
	if strings.TrimSpace(os.Getenv("LLM_API_KEY")) == "" {
		if key := strings.TrimSpace(os.Getenv("DASHSCOPE_API_KEY")); key != "" {
			env = append(env, "LLM_API_KEY="+key)
		}
	}
	cmd.Env = env
	hideWindow(cmd)

	if err := cmd.Start(); err != nil {
		return r.statusLocked(), fmt.Errorf("启动失败: %w", err)
	}
	r.pid = cmd.Process.Pid
	r.stopped = false
	// 只放句柄、不 Wait：服务要活过壳（提醒、手机连接都在），壳关了它照跑。
	_ = cmd.Process.Release()
	log.Printf("runtime: 已拉起服务（PID %d，%s）", r.pid, dir)

	// 起没起来以 /healthz 为准：端口被占、迁移失败、密钥没配，都能在这二十几秒里暴露，
	// 而不是等用户点开页面才发现是空白。
	if err := waitHealthy(r.base, 25*time.Second); err != nil {
		return r.statusLocked(), fmt.Errorf("进程已拉起（PID %d）但没就绪: %w", r.pid, err)
	}
	return r.statusLocked(), nil
}

func (r *runtimeCtl) Stop() (RuntimeStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	port := servicePort(r.base)
	// 先立闩再动手：哪怕下面 taskkill 失败，"用户想停"这个意图也已经成立，
	// 守护不会因为我们没杀干净而把服务"帮"着拉起来。
	r.stopped = true

	pid := pidOnPort(port)
	if pid == 0 {
		pid = r.pid
	}
	if pid == 0 {
		r.pid = 0
		return r.statusLocked(), nil // 本来就没在跑，停是幂等的
	}

	// /T 不能省：tsx 是 loader 进程，它会再 fork 真正的服务进程；
	// 只杀父进程会留下孤儿占着端口，下次启动直接 EADDRINUSE。
	if err := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run(); err != nil {
		r.stopped = false // 没停成，把闩还回去，别让用户以为停了
		return r.statusLocked(), fmt.Errorf("停止失败（PID %d）: %w", pid, err)
	}

	// 等端口真空出来再返回：不然后脚点"启动"会撞 EADDRINUSE。
	deadline := time.Now().Add(8 * time.Second)
	for listening(port) && time.Now().Before(deadline) {
		time.Sleep(120 * time.Millisecond)
	}
	r.pid = 0
	log.Printf("runtime: 已停止服务（PID %d）", pid)
	return r.statusLocked(), nil
}

func (r *runtimeCtl) Restart() (RuntimeStatus, error) {
	if _, err := r.Stop(); err != nil {
		return r.Status(), err
	}
	return r.Start()
}

// Ensure 给"开窗"和守护进程用：用户停过就不动，否则确保在跑。
func (r *runtimeCtl) Ensure() {
	if r.UserStopped() {
		return
	}
	if _, err := r.Start(); err != nil {
		log.Println("runtime:", err)
	}
}
