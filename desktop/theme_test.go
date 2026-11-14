package main

import (
	"path/filepath"
	"testing"
)

// 壳那本主题账（2026-11-14）：业务页回写什么，下次开窗就读到什么；
// 读不到、读歪了都必须回退 paper——启动页宁可多闪一次浅色，也不能空着不画。
func TestThemeMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Selenite", "theme")
	t.Setenv("LIFEDIARY_THEME_FILE", path)
	t.Setenv("LIFEDIARY_THEME", "") // 别让外面的强制覆盖干扰这一轮

	if got := savedTheme(); got != themePaper {
		t.Fatalf("没有文件时应回退 paper，实际 %q", got)
	}

	for _, th := range []string{themePaper, themeWhite, themeIndigo, themeBlack} {
		if err := (Shell{}).SetTheme(th); err != nil {
			t.Fatalf("记 %s 失败：%v", th, err)
		}
		if got := (Shell{}).Theme(); got != th {
			t.Fatalf("写下 %s 读回的是 %q", th, got)
		}
		if got := splashBackground(th); got != map[bool]string{true: "#12141d", false: "#fdf9f2"}[themeIsDark(th)] {
			t.Fatalf("%s 的窗口底色不对：%s", th, got)
		}
	}

	if err := (Shell{}).SetTheme("purple"); err == nil {
		t.Fatal("不认识的主题应该被拒掉，而不是原样写盘")
	}
	if got := savedTheme(); got != themeBlack {
		t.Fatalf("写坏一次不该把好的记录冲掉，实际 %q", got)
	}

	t.Setenv("LIFEDIARY_THEME", " indigo ")
	if got := savedTheme(); got != themeIndigo {
		t.Fatalf("强制覆盖应容忍空白，实际 %q", got)
	}
}
