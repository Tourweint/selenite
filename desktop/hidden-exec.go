package main

/*
子进程"无窗口"启动的统一入口（2026-11-08 扫尾批 9b）。

为什么要这一层：壳用 `-H windowsgui` 构建，自己是 GUI 子系统程序，**没有控制台**。
Windows 在这种情况下拉起控制台程序（netstat / taskkill / node）时，会给子进程
新建一个控制台窗口——那就是用户看到的"打开壳时闪一下"。

之前只有 node 一条路挂了 hideWindow，netstat / taskkill 是裸的 exec。而 netstat
恰恰跑得最勤：托盘状态轮询 5s 一次 `runtime.Status()` → `pidOnPort` → netstat，
开壳时 `startTrayStateWatcher` 还会立刻先跑一次。所以"闪窗"不是 node 的问题，
是这两个短命工具每次都在开一个真控制台。

规矩：**desktop/ 里不许裸调 cmd.Start() / Run() / Output()**，一律走下面三个
封装。grep `exec.Command` 时，每个调用点后面都该跟一个 hidden 调用。
新增的 exec 点同样受这条约束（改代码的人不必记得 SysProcAttr 怎么写）。
*/

import (
	"bytes"
	"os/exec"
)

// startHidden 拉起一个后台子进程（不等它结束），不产生可见窗口。
// 用于服务进程：壳退出后它要继续活着，所以还带着 hideWindow 的 DETACHED_PROCESS
// 语义（见 runtime.go 的调用点）。
func startHidden(cmd *exec.Cmd) error {
	applyNoWindow(cmd)
	return cmd.Start()
}

// runHidden 跑完再返回，用于 taskkill 这类"只要成功与否"的工具。
func runHidden(cmd *exec.Cmd) error {
	if err := startHidden(cmd); err != nil {
		return err
	}
	return cmd.Wait()
}

// outputHidden 等价于 exec.Cmd.Output()：捕获 stdout。
// 用于 netstat——它的输出要解析，不能丢。
func outputHidden(cmd *exec.Cmd) ([]byte, error) {
	var buf bytes.Buffer
	cmd.Stdout = &buf
	if err := startHidden(cmd); err != nil {
		return nil, err
	}
	err := cmd.Wait()
	return buf.Bytes(), err
}
