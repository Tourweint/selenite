package main

/*
主题记忆（2026-11-14）。

业务页的主题存在 WebView 的 localStorage 里。
壳在开窗那一刻读不到它：那时页面还是 about:blank，服务还没起来，没人能告诉壳
「这个用户喜欢纸白还是靛蓝夜」。而启动页必须跟业务页同色，否则就是这次要消灭的
那一下「黑几秒 → 忽然一片白」。

所以壳自己记一份：业务页每次加载时，把当前主题顺手回写给壳一次
（ts/apps/server/web/index.html 的防闪脚本里那一行），壳落在自己的配置目录；
下次启动直接照它铺。写不进、读不到都回退 devin（燕麦，2026-11-25 起的默认主题，
此前是 paper 米黄）——宁可多一次浅色闪，也不能因为一个读不出来的文件名把人卡在启动页。
*/

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 六套主题，与 style-01-tokens.css 的 html[data-theme] 一一对应（4 浅 + 2 深）。
// 2026-11-19 补 celadon（青瓷，2026-11-14 页面侧加的）：此前壳不认识它，
// SetTheme 存不了、原生弹出层（popovers.go）也取不到色，只能落兜底。
// 2026-11-25 补 devin（燕麦）/ antigravity（陶白）两套暖色纸，全是浅色，themeIsDark 不用动；
// 同日收口删掉 paper（米黄）与 codex（奶油），默认改 devin。旧壳记着的 paper / codex
// 读回来一律落 devin。见 docs/变更记录/2026-11-25-主题收口（保留燕麦，删米黄与奶油）.md。
const (
	themeWhite       = "white"
	themeIndigo      = "indigo"
	themeBlack       = "black"
	themeCeladon     = "celadon"
	themeDevin       = "devin"
	themeAntigravity = "antigravity"
)

// themeKnown 判断一个字符串是不是六套之一；大小写与空白都容忍，
// 因为这个文件谁都可能写（页面、手改、旧版本）。
func themeKnown(name string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case themeWhite:
		return themeWhite, true
	case themeIndigo:
		return themeIndigo, true
	case themeBlack:
		return themeBlack, true
	case themeCeladon:
		return themeCeladon, true
	case themeDevin:
		return themeDevin, true
	case themeAntigravity:
		return themeAntigravity, true
	}
	return "", false
}

// themeIsDark：indigo / black 是暗色两套，其余（含读不到）按浅色。
func themeIsDark(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case themeIndigo, themeBlack:
		return true
	}
	return false
}

// themePath 允许环境变量改落点（测试用）；默认跟 window.json 同目录。
func themePath() string {
	if v := strings.TrimSpace(os.Getenv("LIFEDIARY_THEME_FILE")); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "Selenite", "theme")
}

// savedTheme 读壳记住的主题。读不到、记的是已删主题，都回退 devin。
//
// LIFEDIARY_THEME 是显式覆盖（调试时不想反复点设置页）：设了就优先，
// 免得「明明设了环境变量，启动页还是白的」这种迷惑。
func savedTheme() string {
	if v := strings.TrimSpace(os.Getenv("LIFEDIARY_THEME")); v != "" {
		if name, ok := themeKnown(v); ok {
			return name
		}
	}
	path := themePath()
	if path == "" {
		return themeDevin
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return themeDevin
	}
	name, ok := themeKnown(string(b))
	if !ok {
		return themeDevin
	}
	return name
}

// saveTheme 落盘。头尾空白与换行都剥掉：这个文件是给猫读的，不是给人看的。
func saveTheme(name string) error {
	real, ok := themeKnown(name)
	if !ok {
		return fmt.Errorf("不认识的主题：%q", name)
	}
	path := themePath()
	if path == "" {
		return fmt.Errorf("拿不到配置目录")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(real+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// splashBackground 给窗口的 BackgroundColor：页面画出来之前，窗口本身就是这个色。
// 与业务页该主题的 --bg 同一个值，切页时不会先闪一下别的颜色。
// 启动页自己只有明暗两副脸（pages.go 的 dayPage / nightPage），浅色那副画的是 devin 的底；
// 选其余浅色主题时窗口底色对、启动页内容区仍是燕麦，到业务页加载完才换——
// celadon / white / antigravity 都是这个状态，不是 2026-11-25 引入的。
func splashBackground(name string) string {
	if themeIsDark(name) {
		return "#12141d"
	}
	switch name {
	case themeWhite:
		return "#fafaf8"
	case themeCeladon:
		return "#f1f5f1"
	case themeAntigravity:
		return "#faf9f5"
	}
	return "#faf6ee" // devin，也是认不出主题时的兜底
}

// ── 给业务页的绑定 ────────────────────────────────────────
//
// 页面在 index.html 里每次加载回写一次；theme.js 切主题时也回写一次。
// 都走 window.mygo.call("Shell.SetTheme", name)，普通浏览器里没有 window.mygo，
// 那一边静默——所以这里不需要「壳在不在」的判断，只有调用方需要。

// SetTheme 记住当前主题，供下次开窗时的启动页取色。
func (Shell) SetTheme(name string) error {
	return saveTheme(name)
}

// Theme 读回壳记的那一份（设置页可以显示「启动页跟随哪套」）。
func (Shell) Theme() string {
	return savedTheme()
}
