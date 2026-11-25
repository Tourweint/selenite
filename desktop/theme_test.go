package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 壳那本主题账（2026-11-14）：业务页回写什么，下次开窗就读到什么；
// 读不到、读歪了都必须回退 devin（2026-11-25 起的默认，此前是 paper）——
// 启动页宁可多闪一次浅色，也不能空着不画。
func TestThemeMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Selenite", "theme")
	t.Setenv("LIFEDIARY_THEME_FILE", path)
	t.Setenv("LIFEDIARY_THEME", "") // 别让外面的强制覆盖干扰这一轮

	if got := savedTheme(); got != themeDevin {
		t.Fatalf("没有文件时应回退 devin，实际 %q", got)
	}

	// 六套全过一遍，顺序同外观页主题卡。窗口底色按主题名取期望值，不用"暗/浅两值"的 map——
	// 否则新加一套浅色纸时，底色写错也测不出来。最后一套停在 black，
	// 下面"写坏不冲好记录"的断言依赖这一点。
	themed := []struct{ name, splash string }{
		{themeWhite, "#fafaf8"},
		{themeCeladon, "#f1f5f1"},
		{themeDevin, "#faf6ee"},
		{themeAntigravity, "#faf9f5"},
		{themeIndigo, "#12141d"},
		{themeBlack, "#12141d"},
	}
	for _, th := range themed {
		if err := (Shell{}).SetTheme(th.name); err != nil {
			t.Fatalf("记 %s 失败：%v", th.name, err)
		}
		if got := (Shell{}).Theme(); got != th.name {
			t.Fatalf("写下 %s 读回的是 %q", th.name, got)
		}
		if got := splashBackground(th.name); got != th.splash {
			t.Fatalf("%s 的窗口底色应是 %s，实际 %s", th.name, th.splash, got)
		}
		// 四浅两深：isDark 判错会让启动页铺成夜航、自定义主题色取错档
		if themeIsDark(th.name) != (th.splash == "#12141d") {
			t.Fatalf("%s 的明暗判定与底色不一致", th.name)
		}
	}

	// 不认识的主题（含 2026-11-25 删掉的 paper / codex）应该被拒掉，而不是原样写盘。
	// 缓存着旧页面资源的 WebView 还可能回写这两个旧名。
	for _, bad := range []string{"purple", "paper", "codex"} {
		if err := (Shell{}).SetTheme(bad); err == nil {
			t.Fatalf("不认识的主题 %q 应该被拒掉", bad)
		}
	}
	if got := savedTheme(); got != themeBlack {
		t.Fatalf("写坏一次不该把好的记录冲掉，实际 %q", got)
	}

	// 旧壳留下的被删主题：读回来落 devin。
	for _, stale := range []string{"paper\n", "codex\n", "light\n"} {
		if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := savedTheme(); got != themeDevin {
			t.Fatalf("记着 %q 的旧记录应回退 devin，实际 %q", stale, got)
		}
	}

	t.Setenv("LIFEDIARY_THEME", " indigo ")
	if got := savedTheme(); got != themeIndigo {
		t.Fatalf("强制覆盖应容忍空白，实际 %q", got)
	}
}
