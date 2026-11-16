package main

import "github.com/egoist/mygo"

// ReadClipboard / WriteClipboard 给页面自绘的输入框右键菜单用（2026-11-16）。
//
// 为什么不直接用 navigator.clipboard：WebView2 的异步剪贴板读取要先拿到
// ClipboardRead 权限，壳没有处理 PermissionRequested 时默认是拒绝的；MyGo 的
// Clipboard 直接走系统剪贴板，是壳里确定能用的那条路。
//
// 普通浏览器里页面不会调这两个方法（Web 端保留原生右键菜单）；老壳没有这两个
// 方法时，页面侧会退回 navigator.clipboard 并给出失败提示，不会卡死。
func (Shell) ReadClipboard() string {
	return mygo.Clipboard.ReadText()
}

// WriteClipboard 把纯文本放进系统剪贴板。
func (Shell) WriteClipboard(text string) error {
	mygo.Clipboard.WriteText(text)
	return nil
}
