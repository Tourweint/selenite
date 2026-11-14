package main

/*
启动页的两副脸（2026-11-14）。

这里钉住的是「不可能靠肉眼每次复核」的三件事：
  1. 浅色用冷光（纸白）、深色用夜航（深靛）——选错脸只会在别人的机器上闪一下；
  2. 模板占位必须全部换掉，漏一个就会在页面上原样印出 {{...}}；
  3. 水晶图必须是内嵌 data URI——启动页的 baseURL 是 about:blank，相对路径没有着落。

设 SPLASH_DUMP_DIR 时顺手把渲染结果写出去，配 Edge headless 截图用：
    $env:SPLASH_DUMP_DIR = "...\design\splash\rendered"
    go test -count=1 -run TestSplashPages .
*/

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSplashPages(t *testing.T) {
	cases := []struct {
		name  string
		theme string
		want  []string
		deny  []string
	}{
		{
			name:  "浅色·冷光",
			theme: "paper",
			want:  []string{"#fdf9f2", "SELENITE", "data:image/png;base64,", "window.splash", "探测 <b>"},
			deny:  []string{"{{", "#12141d"},
		},
		{
			name:  "深色·夜航",
			theme: "indigo",
			want:  []string{"#12141d", "ring r1", "data:image/png;base64,", "window.splash"},
			deny:  []string{"{{", "background: #fdf9f2"},
		},
		{
			name:  "纯黑也算深色",
			theme: "black",
			want:  []string{"#12141d", "ring r1"},
		},
		{
			name:  "纯白也算浅色",
			theme: "white",
			want:  []string{"#fdf9f2", "SELENITE"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("LIFEDIARY_THEME", c.theme)
			html := connectingPage("http://127.0.0.1:39847")
			for _, w := range c.want {
				if !strings.Contains(html, w) {
					t.Fatalf("主题 %s 的启动页里找不到 %q", c.theme, w)
				}
			}
			for _, d := range c.deny {
				if strings.Contains(html, d) {
					t.Fatalf("主题 %s 的启动页里不该出现 %q", c.theme, d)
				}
			}
		})
	}

	// 连不上那张：同一套标题栏，靠 data-face 换配色；错误文本要按原样出现（已转义）。
	t.Run("连不上", func(t *testing.T) {
		for _, face := range []string{"day", "night"} {
			theme := "paper"
			if face == "night" {
				theme = "indigo"
			}
			t.Setenv("LIFEDIARY_THEME", theme)
			html := offlinePage("http://127.0.0.1:39847", errors.New("probe timeout after 25s"))
			if !strings.Contains(html, `data-face="`+face+`"`) {
				t.Fatalf("%s 脸应该铺 %s，实际没带上 data-face", theme, face)
			}
			if strings.Contains(html, "{{") {
				t.Fatalf("%s 脸的连不上页还有没换掉的占位", theme)
			}
			if !strings.Contains(html, "probe timeout after 25s") {
				t.Fatalf("%s 脸的连不上页没带出错误原文", theme)
			}
		}
	})

	// 写盘给截图用，不设就不写。
	if dir := os.Getenv("SPLASH_DUMP_DIR"); dir != "" {
		for _, th := range []string{"paper", "indigo"} {
			t.Setenv("LIFEDIARY_THEME", th)
			if err := os.WriteFile(filepath.Join(dir, th+".html"), []byte(connectingPage("http://127.0.0.1:39847")), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, th+"-offline.html"),
				[]byte(offlinePage("http://127.0.0.1:39847", errors.New("probe timeout after 25s"))), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
}
