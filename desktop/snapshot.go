package main

/*
原生截图工具（2026-11-25）：框选 + 窗口自动吸附，取代 WebView2 自带的共享选择器。

为什么换：加号 →「截图」原来走页面的 navigator.mediaDevices.getDisplayMedia，在桌面壳里
弹的是 WebView2 的共享选择器（第三方观感）——不能拖拽框选，也不会吸附窗口。用户要求
换成「咱们自己的原生工具」。方案：docs/设计方案/2026-11-25-原生截图工具（壳内框选与窗口吸附）.md

文件分工：
  snapshot.go          绑定 Shell.CaptureSnapshot + 回滚开关 + 返回契约 + 编排
  snapshot_geom.go     纯函数：矩形裁剪、DIP↔物理像素、压暗条带、拖动状态机、PNG/JPEG 编码回退
  snapshot_view.go     遮罩窗（mygo 原生窗口 + package ui）与逐帧交互
  snapshot_windows.go  Win32（GDI 抓屏、显示器、光标下窗口）；snapshot_other.go 是别的平台的空实现

坐标口径（写死，别再猜）：
  - 壳进程是 Per-Monitor-Aware V2（mygo 启动时设），所以 Win32 的屏幕坐标、GetWindowRect、
    GetCursorPos 一律是**物理像素**；mygo 的窗口与 Screen.Bounds 一律是 **DIP**。
  - 换算只有一处：snapshot_geom.go 的 dipToPx / pxToDip（px = round(dip × scale)）。
    scale 取光标所在显示器的 mygo Display.ScaleFactor。
  - 遮罩左上角的物理坐标（overlay.left/top）取自遮罩窗自己的 GetWindowRect，不靠推算——
    万一框架把窗口挪了位置或裁了尺寸，选框和截图像素仍然对得上。

线程模型（与 popovers.go 同一套规矩）：Bind 方法在独立 goroutine 里跑；视图函数在主线程
绘制帧里跑。因此：
  - 冻结帧、位图、缩放、排除名单在建窗前定死，之后只读；
  - 拖动/悬停/收尾状态（drag、hover、finished）**只有主线程读写**；
  - 结论只经 done 通道（缓冲 1）交给 Bind goroutine，编码在遮罩销毁之后、在 Bind goroutine 里做，
    不占主线程。

不落盘：截图只在内存里走一圈（GDI DIB → image.RGBA → PNG/JPEG → base64 过桥），
不写临时文件、不进剪贴板、不进日志（日志只有耗时与尺寸）。

回滚开关：LIFEDIARY_NATIVE_SNAPSHOT（缺省开；off / false / 0 → Capabilities 报
nativeScreenshot=false，页面退回 getDisplayMedia）。老壳没有 CaptureSnapshot 这个方法，
页面调用 reject，同样回退——浏览器 / 老壳 / 开关关三种情况都是原来的行为。
*/

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// SnapshotResult 是 Shell.CaptureSnapshot 的返回（json tag 与页面侧字段一一对应）。
// 三种形态：成功带 mimeType/data/width/height；取消只有 {canceled:true}；出错走 Go error。
type SnapshotResult struct {
	MimeType string `json:"mimeType,omitempty"` // image/png 或 image/jpeg
	Data     string `json:"data,omitempty"`     // 裸 base64（不带 data: 前缀）
	Width    int    `json:"width,omitempty"`    // 物理像素
	Height   int    `json:"height,omitempty"`   // 物理像素
	Canceled bool   `json:"canceled,omitempty"`
}

var (
	errSnapshotOff         = errors.New("原生截图已关闭（LIFEDIARY_NATIVE_SNAPSHOT=off）")
	errSnapshotUnsupported = errors.New("这个平台的壳没有原生截图")
	errSnapshotNoWindow    = errors.New("主窗口不在，原生截图用不了")
	errSnapshotEmpty       = errors.New("截图区域是空的")
	errSnapshotTooLarge    = errors.New("截图编码后仍超过 8MB")
)

// snapshotBusy 同一时刻只允许一张遮罩：遮罩开着时再点一次「截图」按取消处理。
var snapshotBusy atomic.Bool

// nativeSnapshotEnabled 是本批的回滚开关：off / false / 0（不分大小写）算关，
// 其余（含没设）都算开。回滚不等于改代码。
func nativeSnapshotEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LIFEDIARY_NATIVE_SNAPSHOT"))) {
	case "off", "false", "0":
		return false
	}
	return true
}

// nativeSnapshotAvailable 是 Capabilities 报给页面的值：开关开**且**这个平台有实现。
func nativeSnapshotAvailable() bool {
	return nativeSnapshotEnabled() && nativeSnapshotSupported()
}

// snapshotTarget 一次截图的目标显示器（v1 只覆盖鼠标所在那一块）。
type snapshotTarget struct {
	monitor pxRect // 物理像素，Win32 屏幕坐标
}

// CaptureSnapshot 弹全屏遮罩，等用户框选 / 点窗口 / 取消，返回截图；期间一直阻塞
// （与 ShowMenu 同一个姿势：framework 允许 Bind 方法阻塞）。
//
// 顺序是硬要求：**先抓帧再建遮罩**——遮罩是自己的一张顶层窗，建在抓帧之前就会把自己冻进截图。
// ctx 必须是第一个参数（同 ShowMenu）：页面导航走人时 ctx.Done，收掉遮罩别让调用挂死。
func (Shell) CaptureSnapshot(ctx context.Context) (SnapshotResult, error) {
	if !nativeSnapshotEnabled() {
		return SnapshotResult{}, errSnapshotOff
	}
	if !nativeSnapshotSupported() {
		return SnapshotResult{}, errSnapshotUnsupported
	}
	if win == nil || win.IsDestroyed() {
		return SnapshotResult{}, errSnapshotNoWindow
	}
	if !snapshotBusy.CompareAndSwap(false, true) {
		return SnapshotResult{Canceled: true}, nil
	}
	defer snapshotBusy.Store(false)

	// 开着的菜单 / 提示签是本应用的小窗，冻进帧里只会误导：先收掉再抓。
	closeCurrentMenu()
	Shell{}.HideTip()

	started := time.Now()
	target, frame, err := snapshotGrab()
	if err != nil {
		return SnapshotResult{}, err
	}
	o := &snapshotOverlay{
		frame:  frame,
		mw:     frame.Rect.Dx(),
		mh:     frame.Rect.Dy(),
		origin: target.monitor,
		done:   make(chan snapshotOutcome, 1),
	}
	if err := o.open(); err != nil {
		return SnapshotResult{}, err
	}
	log.Printf("snapshot: 遮罩已显示 %s（显示器 %dx%d）", time.Since(started).Round(time.Millisecond), o.mw, o.mh)

	var outcome snapshotOutcome
	select {
	case outcome = <-o.done:
	case <-ctx.Done():
		outcome = snapshotOutcome{canceled: true}
	}
	o.close() // 销毁遮罩 + 主窗口拉回前台，然后才编码

	if outcome.canceled {
		return SnapshotResult{Canceled: true}, nil
	}
	rect := clipRect(outcome.rect, o.mw, o.mh)
	if rect.empty() {
		return SnapshotResult{}, errSnapshotEmpty
	}
	return encodeSnapshot(cropRGBA(frame, rect), snapshotMaxBytes, snapshotMaxWidth)
}
