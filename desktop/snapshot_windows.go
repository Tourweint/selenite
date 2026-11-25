//go:build windows

package main

/*
原生截图的 Win32 部分：GDI 抓屏、显示器、光标下的窗口。

调用方式：标准库 syscall（LazyDLL + SyscallN）。没用 golang.org/x/sys/windows——它要连
sum.golang.org 校验 go.sum（2026-11-25 本机不通），而本机 purego v0.11.1 在 Windows 上
没有 Dlopen、取地址仍得靠标准库；所以直接用标准库，go.mod / go.sum 一个字没动。

坐标全是物理像素（壳进程是 Per-Monitor-Aware V2，见 snapshot.go 文头）。
*/

import (
	"errors"
	"fmt"
	"image"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"github.com/egoist/mygo"
)

const (
	srcCopy                  = 0x00CC0020
	captureBlt               = 0x40000000
	biRGB                    = 0
	dibRGBColors             = 0
	gaRoot                   = 2
	gwhHwndNext              = 2
	dwmwaExtendedFrameBounds = 9
	dwmwaCloaked             = 14
	monitorDefaultToNearest  = 1
	// snapshotMaxSide 单块显示器边长的上限，防脏数据开出一块离谱的缓冲。
	snapshotMaxSide = 16384
)

var (
	snapUser32   = syscall.NewLazyDLL("user32.dll")
	snapGdi32    = syscall.NewLazyDLL("gdi32.dll")
	snapDwmapi   = syscall.NewLazyDLL("dwmapi.dll")
	snapKernel32 = syscall.NewLazyDLL("kernel32.dll")

	procGetCursorPos          = snapUser32.NewProc("GetCursorPos")
	procMonitorFromPoint      = snapUser32.NewProc("MonitorFromPoint")
	procGetMonitorInfo        = snapUser32.NewProc("GetMonitorInfoW")
	procWindowFromPoint       = snapUser32.NewProc("WindowFromPoint")
	procGetDC                 = snapUser32.NewProc("GetDC") // 取屏/还屏是 user32 的，不在 gdi32
	procReleaseDC             = snapUser32.NewProc("ReleaseDC")
	procGetAncestor           = snapUser32.NewProc("GetAncestor")
	procGetWindowRect         = snapUser32.NewProc("GetWindowRect")
	procGetClassName          = snapUser32.NewProc("GetClassNameW")
	procIsWindowVisible       = snapUser32.NewProc("IsWindowVisible")
	procIsIconic              = snapUser32.NewProc("IsIconic")
	procWindowThreadProcessId = snapUser32.NewProc("GetWindowThreadProcessId")
	procGetShellWindow        = snapUser32.NewProc("GetShellWindow")
	procGetTopWindow          = snapUser32.NewProc("GetTopWindow")
	procGetWindow             = snapUser32.NewProc("GetWindow")
	procDwmGetWindowAttribute = snapDwmapi.NewProc("DwmGetWindowAttribute")
	procCreateCompatibleDC    = snapGdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection      = snapGdi32.NewProc("CreateDIBSection")
	procSelectObject          = snapGdi32.NewProc("SelectObject")
	procBitBlt                = snapGdi32.NewProc("BitBlt")
	procDeleteObject          = snapGdi32.NewProc("DeleteObject")
	procDeleteDC              = snapGdi32.NewProc("DeleteDC")
	procGdiFlush              = snapGdi32.NewProc("GdiFlush")
	procGetCurrentProcessId   = snapKernel32.NewProc("GetCurrentProcessId")
)

type winPoint struct{ X, Y int32 }

type winRect struct{ Left, Top, Right, Bottom int32 }

func (r winRect) toPx() pxRect {
	return pxRect{X: int(r.Left), Y: int(r.Top), W: int(r.Right - r.Left), H: int(r.Bottom - r.Top)}
}

func (r winRect) contains(x, y int32) bool {
	return x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom
}

type winMonitorInfo struct {
	Size    uint32
	Monitor winRect
	Work    winRect
	Flags   uint32
}

type winBitmapInfoHeader struct {
	Size          uint32
	Width, Height int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type winBitmapInfo struct {
	Header winBitmapInfoHeader
	Colors [1]uint32
}

// packPoint 把两个 int32 打包成一个 uintptr：POINT 按值传参时 8 字节正好占一个寄存器
// （Windows x64 调用约定），所以 MonitorFromPoint / WindowFromPoint 这样传等价于传结构体。
func packPoint(x, y int32) uintptr {
	return uintptr(uint64(uint32(x)) | uint64(uint32(y))<<32)
}

func nativeSnapshotSupported() bool { return true }

// snapshotGrab 鼠标所在的显示器 → 整屏抓那一块。先于遮罩窗存在，所以遮罩不会进截图。
func snapshotGrab() (snapshotTarget, *image.RGBA, error) {
	var pt winPoint
	if r, _, _ := syscall.SyscallN(procGetCursorPos.Addr(), uintptr(unsafe.Pointer(&pt))); r == 0 {
		return snapshotTarget{}, nil, errors.New("取不到鼠标位置")
	}
	monitor, err := monitorAt(pt.X, pt.Y)
	if err != nil {
		return snapshotTarget{}, nil, err
	}
	frame, err := captureMonitorFrame(monitor)
	if err != nil {
		return snapshotTarget{}, nil, err
	}
	return snapshotTarget{monitor: monitor}, frame, nil
}

// monitorAt 某个屏幕坐标所在的显示器（物理像素）。
func monitorAt(x, y int32) (pxRect, error) {
	mon, _, _ := syscall.SyscallN(procMonitorFromPoint.Addr(), packPoint(x, y), monitorDefaultToNearest)
	if mon == 0 {
		return pxRect{}, errors.New("找不到鼠标所在的显示器")
	}
	var mi winMonitorInfo
	mi.Size = uint32(unsafe.Sizeof(mi))
	if r, _, _ := syscall.SyscallN(procGetMonitorInfo.Addr(), mon, uintptr(unsafe.Pointer(&mi))); r == 0 {
		return pxRect{}, errors.New("读不到显示器信息")
	}
	m := mi.Monitor.toPx()
	if m.W <= 0 || m.H <= 0 {
		return pxRect{}, fmt.Errorf("显示器尺寸不对：%dx%d", m.W, m.H)
	}
	return m, nil
}

// captureMonitorFrame GDI 抓屏：GetDC(NULL) → CreateCompatibleDC → CreateCompatibleBitmap → BitBlt。
// 实际用的是 CreateDIBSection（它本身就是一张兼容位图，而且直接给出像素指针，
// 省掉 GetDIBits 那一次拷贝）。带 CAPTUREBLT：分层窗口（多数截图工具自己、悬浮球）也抓进来。
func captureMonitorFrame(m pxRect) (frame *image.RGBA, err error) {
	w, h := m.W, m.H
	if w <= 0 || h <= 0 || w > snapshotMaxSide || h > snapshotMaxSide {
		return nil, fmt.Errorf("显示器尺寸不对：%dx%d", w, h)
	}
	screen, _, _ := syscall.SyscallN(procGetDC.Addr(), 0)
	if screen == 0 {
		return nil, errors.New("GetDC 失败")
	}
	defer func() { syscall.SyscallN(procReleaseDC.Addr(), 0, screen) }()

	var bi winBitmapInfo
	bi.Header.Size = uint32(unsafe.Sizeof(bi.Header))
	bi.Header.Width = int32(w)
	bi.Header.Height = -int32(h) // 负高度 = 自上而下，与 image 包同序
	bi.Header.Planes = 1
	bi.Header.BitCount = 32
	bi.Header.Compression = biRGB

	var bits unsafe.Pointer
	bmp, _, _ := syscall.SyscallN(procCreateDIBSection.Addr(), screen, uintptr(unsafe.Pointer(&bi)), dibRGBColors, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		return nil, errors.New("CreateDIBSection 失败")
	}
	defer syscall.SyscallN(procDeleteObject.Addr(), bmp)
	// CreateDIBSection 的像素指针要 GdiFlush 之后才保证有效。
	syscall.SyscallN(procGdiFlush.Addr())

	dc, _, _ := syscall.SyscallN(procCreateCompatibleDC.Addr(), screen)
	if dc == 0 {
		return nil, errors.New("CreateCompatibleDC 失败")
	}
	defer syscall.SyscallN(procDeleteDC.Addr(), dc)
	syscall.SyscallN(procSelectObject.Addr(), dc, bmp)
	ok, _, _ := syscall.SyscallN(procBitBlt.Addr(), dc, 0, 0, uintptr(w), uintptr(h), screen, uintptr(int32(m.X)), uintptr(int32(m.Y)), srcCopy|captureBlt)
	if ok == 0 {
		return nil, errors.New("BitBlt 抓屏失败")
	}
	if bits == nil {
		return nil, errors.New("抓屏缓冲是空的")
	}
	// 像素拷进 Go 堆：位图马上要删，缓冲不能留着引用。
	src := unsafe.Slice((*byte)(bits), w*h*4)
	pix := make([]byte, len(src))
	copy(pix, src)
	return frameRGBA(pix, w, h), nil
}

// shellDisplays 壳认识的显示器（DIP 尺寸 + 缩放），displayForMonitor 用。
func shellDisplays() []displayInfo {
	out := make([]displayInfo, 0, 4)
	for _, d := range mygo.Screen.Displays() {
		out = append(out, displayInfo{
			X: d.Bounds.X, Y: d.Bounds.Y, W: d.Bounds.Width, H: d.Bounds.Height, ScaleFactor: d.ScaleFactor,
		})
	}
	return out
}

// ownTopLevelWindows 本进程此刻的顶层窗（主窗口、提示签、菜单……）。
func ownTopLevelWindows() map[uintptr]bool {
	return topLevelWindows(true)
}

// newTopLevelWindows 建窗前后各数一次，多出来的就是刚建的那张（遮罩）。
func newTopLevelWindows(before map[uintptr]bool) map[uintptr]bool {
	after := ownTopLevelWindows()
	for hwnd := range after {
		if before[hwnd] {
			delete(after, hwnd)
		}
	}
	return after
}

// topLevelWindows 枚举顶层窗；onlyOwn 时只留本进程的。
func topLevelWindows(onlyOwn bool) map[uintptr]bool {
	out := map[uintptr]bool{}
	pid := uint32(0)
	if onlyOwn {
		pid = currentProcessID()
	}
	hwnd, _, _ := syscall.SyscallN(procGetTopWindow.Addr(), 0)
	for i := 0; hwnd != 0 && i < 4096; i++ {
		next, _, _ := syscall.SyscallN(procGetWindow.Addr(), hwnd, gwhHwndNext)
		if !onlyOwn || windowProcessID(hwnd) == pid {
			out[hwnd] = true
		}
		hwnd = next
	}
	return out
}

func currentProcessID() uint32 {
	r, _, _ := syscall.SyscallN(procGetCurrentProcessId.Addr())
	return uint32(r)
}

func windowProcessID(hwnd uintptr) uint32 {
	var pid uint32
	syscall.SyscallN(procWindowThreadProcessId.Addr(), hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid
}

// windowBounds 窗口的可见边框（DWM 扩展边框，Win11 圆角阴影不算在内）；取不到退回 GetWindowRect。
func windowBounds(hwnd uintptr) (pxRect, bool) {
	if hwnd == 0 {
		return pxRect{}, false
	}
	var r winRect
	hr, _, _ := syscall.SyscallN(procDwmGetWindowAttribute.Addr(), hwnd, dwmwaExtendedFrameBounds, uintptr(unsafe.Pointer(&r)), unsafe.Sizeof(r))
	if int32(hr) < 0 {
		if ok, _, _ := syscall.SyscallN(procGetWindowRect.Addr(), hwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
			return pxRect{}, false
		}
	}
	p := r.toPx()
	return p, !p.empty()
}

// windowAtScreenPoint 某个屏幕坐标下最上面的那个可截窗口（物理像素，屏幕坐标）。
//
// 遮罩自己永远压在最上，WindowFromPoint 十有八九回的是它——所以先用 WindowFromPoint，
// 命中自己就按 Z 序从上往下找第一个「可截且盖住这个点」的窗口。可截 = 可见、没最小化、
// 不是桌面（Progman / WorkerW）、不是任务栏、没有被 DWM 隐藏（cloaked）、不在排除名单里。
func windowAtScreenPoint(x, y int32, exclude map[uintptr]bool) (pxRect, bool) {
	hwnd, _, _ := syscall.SyscallN(procWindowFromPoint.Addr(), packPoint(x, y))
	if hwnd != 0 {
		if root, _, _ := syscall.SyscallN(procGetAncestor.Addr(), hwnd, gaRoot); root != 0 {
			hwnd = root
		}
		if snapshotWindowUsable(hwnd, exclude) {
			if r, ok := windowBoundsPx(hwnd); ok && r.contains(x, y) {
				return r.toPx(), true
			}
		}
	}
	h, _, _ := syscall.SyscallN(procGetTopWindow.Addr(), 0)
	for i := 0; h != 0 && i < 4096; i++ {
		next, _, _ := syscall.SyscallN(procGetWindow.Addr(), h, gwhHwndNext)
		if snapshotWindowUsable(h, exclude) {
			if r, ok := windowBoundsPx(h); ok && r.contains(x, y) {
				return r.toPx(), true
			}
		}
		h = next
	}
	return pxRect{}, false
}

// windowBoundsPx 同 windowBounds，但返回 winRect（判定「盖住这个点」要用）。
func windowBoundsPx(hwnd uintptr) (winRect, bool) {
	p, ok := windowBounds(hwnd)
	if !ok {
		return winRect{}, false
	}
	return winRect{int32(p.X), int32(p.Y), int32(p.X + p.W), int32(p.Y + p.H)}, true
}

func snapshotWindowUsable(hwnd uintptr, exclude map[uintptr]bool) bool {
	if hwnd == 0 || exclude[hwnd] {
		return false
	}
	if r, _, _ := syscall.SyscallN(procIsWindowVisible.Addr(), hwnd); r == 0 {
		return false
	}
	if r, _, _ := syscall.SyscallN(procIsIconic.Addr(), hwnd); r != 0 {
		return false
	}
	if shell, _, _ := syscall.SyscallN(procGetShellWindow.Addr()); hwnd == shell {
		return false
	}
	switch windowClass(hwnd) {
	case "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd":
		return false
	}
	var cloaked uint32
	hr, _, _ := syscall.SyscallN(procDwmGetWindowAttribute.Addr(), hwnd, dwmwaCloaked, uintptr(unsafe.Pointer(&cloaked)), unsafe.Sizeof(cloaked))
	return int32(hr) < 0 || cloaked == 0
}

func windowClass(hwnd uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := syscall.SyscallN(procGetClassName.Addr(), hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		return ""
	}
	return string(utf16.Decode(buf[:n]))
}
