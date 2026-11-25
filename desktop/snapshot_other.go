//go:build !windows

package main

import "image"

// 壳只在 Windows 出包；别的平台「原生截图」恒不可用，Capabilities 报 false，页面走 getDisplayMedia。

func nativeSnapshotSupported() bool { return false }

func snapshotGrab() (snapshotTarget, *image.RGBA, error) {
	return snapshotTarget{}, nil, errSnapshotUnsupported
}

func shellDisplays() []displayInfo { return nil }

func ownTopLevelWindows() map[uintptr]bool { return nil }

func newTopLevelWindows(map[uintptr]bool) map[uintptr]bool { return nil }

func windowBounds(uintptr) (pxRect, bool) { return pxRect{}, false }

func windowAtScreenPoint(int32, int32, map[uintptr]bool) (pxRect, bool) { return pxRect{}, false }
