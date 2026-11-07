// Command gen-gray-icon 是一次性工具：把托盘彩色图标去饱和度，生成"服务停止/
// 异常"时用的灰色图标 assets/icon-tray-idle.png。
//
// 用途：托盘三小件之一「图标随服务状态变灰」。产物随仓库提交，桌面壳运行时
// 直接 //go:embed，不需要在每台机器上跑这个工具；只有换源图（icon-tray.png）
// 后要重新生成时才用。
//
// 用法（在 desktop/ 目录下执行，路径相对 desktop/）：
//
//	go run ./gen-gray-icon
//	go run ./gen-gray-icon -in assets/icon-tray.png -out assets/icon-tray-idle.png
//
// 只改 RGB 做灰度（Rec.601 加权亮度，比简单平均更接近人眼观感），alpha 原样
// 保留，透明底不会被压暗或糊边。只用标准库 image/png + image。
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
)

func main() {
	in := flag.String("in", "assets/icon-tray.png", "输入 PNG（彩色托盘图标）")
	out := flag.String("out", "assets/icon-tray-idle.png", "输出 PNG（灰度托盘图标）")
	flag.Parse()

	if err := generate(*in, *out); err != nil {
		fmt.Fprintln(os.Stderr, "gen-gray-icon:", err)
		os.Exit(1)
	}
	fmt.Printf("gen-gray-icon: %s -> %s\n", *in, *out)
}

func generate(inPath, outPath string) error {
	f, err := os.Open(inPath)
	if err != nil {
		return err
	}
	src, err := png.Decode(f)
	_ = f.Close()
	if err != nil {
		return fmt.Errorf("解码 %s: %w", inPath, err)
	}

	b := src.Bounds()
	dst := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			// 用非预乘的 RGBA 做灰度：半透明边缘不会被预乘压暗。
			c := color.NRGBAModel.Convert(src.At(x, y)).(color.NRGBA)
			g := uint8((uint32(c.R)*299 + uint32(c.G)*587 + uint32(c.B)*114) / 1000)
			dst.SetNRGBA(x, y, color.NRGBA{R: g, G: g, B: g, A: c.A})
		}
	}

	of, err := os.Create(outPath)
	if err != nil {
		return err
	}
	if err := png.Encode(of, dst); err != nil {
		_ = of.Close()
		return fmt.Errorf("编码 %s: %w", outPath, err)
	}
	return of.Close()
}
