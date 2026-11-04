package main

// 窗口几何持久化与首次隐藏告知（2026-11-04 批次二，对照 deepseek-harness 的壳）。
//
// 存用户配置目录（%AppConfigDir%/Selenite/），不进 .data——那是服务的地盘。
// 损坏或明显越界的存档直接回退比例算法，不报错。
// 保存走防抖：OnMove/OnResize 会连发，不能每次都写盘。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

type windowState struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized"`
}

var (
	stateMu   sync.Mutex
	saveTimer *time.Timer
	lastSaved windowState
)

// windowStatePath 允许用环境变量改落点（测试用）；默认在用户配置目录。
func windowStatePath() string {
	if v := strings.TrimSpace(os.Getenv("LIFEDIARY_WINDOW_STATE")); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "Selenite", "window.json")
}

func loadWindowState() *windowState {
	path := windowStatePath()
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var st windowState
	if json.Unmarshal(b, &st) != nil {
		return nil
	}
	// 明显坏掉的存档（尺寸过小）不认，交给比例算法兜底
	if st.Width < 400 || st.Height < 300 {
		return nil
	}
	return &st
}

// scheduleWindowStateSave 防抖 800ms：连发的 move/resize 只落一次盘。
func scheduleWindowStateSave(w *mygo.Window) {
	stateMu.Lock()
	defer stateMu.Unlock()
	if saveTimer != nil {
		saveTimer.Stop()
	}
	saveTimer = time.AfterFunc(800*time.Millisecond, func() { saveWindowState(w) })
}

func saveWindowState(w *mygo.Window) {
	if w == nil || w.IsDestroyed() {
		return
	}
	path := windowStatePath()
	if path == "" {
		return
	}
	b := w.Bounds()
	st := windowState{
		X:         b.X,
		Y:         b.Y,
		Width:     b.Width,
		Height:    b.Height,
		Maximized: w.IsMaximized(),
	}
	stateMu.Lock()
	if st == lastSaved {
		stateMu.Unlock()
		return
	}
	lastSaved = st
	stateMu.Unlock()

	data, err := json.Marshal(st)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	// 临时文件 + rename，写一半被杀也不会留下半个 json
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// ── 首次隐藏告知（批次二）────────────────────────────────
//
// 「关窗 = 最小化到托盘」是既有行为，但用户从来不知道服务还在跑
// （deepseek-harness 的 background-notice 同款问题）。第一次关窗时弹一次
// 原生说明，之后写 ack 标记，永不复发。

func hideNoticePath() string {
	if v := strings.TrimSpace(os.Getenv("LIFEDIARY_HIDE_NOTICE")); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "Selenite", "hide-notice-ack")
}

func hideNoticeAcked() bool {
	path := hideNoticePath()
	if path == "" {
		return true // 拿不到路径就不弹，宁可不提示也别每次都弹
	}
	_, err := os.Stat(path)
	return err == nil
}

func markHideNoticeAcked() {
	path := hideNoticePath()
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, []byte("ack\n"), 0o644)
}

func firstHideNotice(w *mygo.Window) {
	if hideNoticeAcked() {
		return
	}
	// 弹不弹得出来都不阻塞隐藏：Dialog 失败就当说过了
	_, _ = mygo.Dialog.Message(mygo.MessageOptions{
		Parent:  w,
		Type:    mygo.MessageInfo,
		Title:   "Selenite 仍在运行",
		Message: "窗口已最小化到托盘，服务还在继续跑。",
		Detail:  "提醒、手机连接、后台任务都不会停。从托盘图标可以重新打开或退出。",
	})
	markHideNoticeAcked()
}
