package main

/*
原生截图的纯函数（可单测）：矩形、DIP↔物理像素、压暗条带、拖动状态机、编码回退。
这里不碰 Win32、不碰 mygo 的窗口，输入输出全是值。
*/

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"image/png"
	"math"

	xdraw "golang.org/x/image/draw"
)

const (
	// snapshotMaxBytes 编码后的上限 = 页面的 MAX_IMAGE_BYTES（attachments.js，8MB）。
	snapshotMaxBytes = 8 << 20
	// snapshotMaxWidth PNG、JPEG 都超限时，等比缩到这个宽度再编码。
	snapshotMaxWidth = 2560
	// snapshotJPEGQuality PNG 超限后先转 JPEG，质量 90。
	snapshotJPEGQuality = 90
	// snapshotClickSlop 按下到松开位移小于这个值（DIP）算单击，走窗口吸附。
	snapshotClickSlop = 6.0
	// snapshotDimAlpha 选区之外压暗多少（黑，0.45）。
	snapshotDimAlpha = 0.45
)

// pxRect 物理像素矩形（X,Y 是左上角）。
type pxRect struct{ X, Y, W, H int }

// dipRect 遮罩窗内的 DIP 矩形。
type dipRect struct{ X, Y, W, H float32 }

func (r pxRect) empty() bool  { return r.W <= 0 || r.H <= 0 }
func (r dipRect) empty() bool { return r.W <= 0.01 || r.H <= 0.01 }

// ── 矩形 ───────────────────────────────────────────────

// clipRect 把矩形裁到 [0,w) × [0,h) 里；裁完什么都不剩返回零值（empty）。
func clipRect(r pxRect, w, h int) pxRect {
	x0, y0 := max(r.X, 0), max(r.Y, 0)
	x1, y1 := min(r.X+r.W, w), min(r.Y+r.H, h)
	if x1 <= x0 || y1 <= y0 {
		return pxRect{}
	}
	return pxRect{x0, y0, x1 - x0, y1 - y0}
}

// clipDipRect 同 clipRect，DIP 口径。
func clipDipRect(r dipRect, w, h float32) dipRect {
	x0, y0 := max(r.X, 0), max(r.Y, 0)
	x1, y1 := min(r.X+r.W, w), min(r.Y+r.H, h)
	if x1 <= x0 || y1 <= y0 {
		return dipRect{}
	}
	return dipRect{x0, y0, x1 - x0, y1 - y0}
}

// ── DIP ↔ 物理像素（换算只在这一处）────────────────────

// dipToPx DIP → 物理像素，四舍五入。150% 下 100 DIP = 150px，200% 下 = 200px。
func dipToPx(v float32, scale float64) int {
	return int(math.Round(float64(v) * scale))
}

// pxToDip 物理像素 → DIP。
func pxToDip(v int, scale float64) float32 {
	return float32(float64(v) / scale)
}

// rectToPx DIP 矩形 → 物理像素矩形：左右上下各算一次再相减，选框边缘与截图像素一一对齐
// （不先算宽高再乘，那样 150% 下会差 1px）。
func rectToPx(r dipRect, scale float64) pxRect {
	if r.empty() {
		return pxRect{}
	}
	l, t := dipToPx(r.X, scale), dipToPx(r.Y, scale)
	right, bottom := dipToPx(r.X+r.W, scale), dipToPx(r.Y+r.H, scale)
	return pxRect{l, t, right - l, bottom - t}
}

// rectToDip 物理像素矩形 → DIP 矩形；(ox,oy) 是物理坐标系里 DIP 原点的位置
// （遮罩窗左上角的屏幕坐标）。
func rectToDip(r pxRect, ox, oy int, scale float64) dipRect {
	if r.empty() {
		return dipRect{}
	}
	return dipRect{
		X: pxToDip(r.X-ox, scale),
		Y: pxToDip(r.Y-oy, scale),
		W: pxToDip(r.W, scale),
		H: pxToDip(r.H, scale),
	}
}

// displayForMonitor 在 mygo 的显示器列表里找物理尺寸对得上的那一块，带回它的缩放。
// 只比尺寸不比原点：多屏不同缩放下 DIP 原点怎么摆是框架的事，这里不猜——只要
// 「DIP 尺寸 × scale ≈ 物理尺寸」成立，遮罩窗铺满 Bounds 就等于铺满那块显示器。
func displayForMonitor(mw, mh int, displays []displayInfo) (displayInfo, bool) {
	best, bestDiff := displayInfo{}, -1
	for _, d := range displays {
		if d.ScaleFactor <= 0 || d.W <= 0 || d.H <= 0 {
			continue
		}
		diff := absInt(dipToPx(float32(d.W), d.ScaleFactor)-mw) + absInt(dipToPx(float32(d.H), d.ScaleFactor)-mh)
		if bestDiff < 0 || diff < bestDiff {
			best, bestDiff = d, diff
		}
	}
	// 容差 2px：DIP 取整带来的误差就这么多；差得更多说明根本不是同一块屏。
	if bestDiff < 0 || bestDiff > 2 {
		return displayInfo{}, false
	}
	return best, true
}

// displayInfo 是 displayForMonitor 需要的那几个字段（从 mygo.Display 抄出来，纯函数不必依赖框架）。
type displayInfo struct {
	X, Y, W, H  int     // Bounds，DIP
	ScaleFactor float64 // 物理像素 / DIP
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// ── 压暗条带 ───────────────────────────────────────────

// dimStrips 选区**之外**要压暗的区域：没有选区就是整屏一条；有选区就是上下左右最多四条，
// 选区本身不盖，留在原亮度——这就是「高亮」。
func dimStrips(full dipRect, sel *dipRect) []dipRect {
	if sel == nil || sel.empty() {
		return []dipRect{full}
	}
	s := clipDipRect(*sel, full.W, full.H)
	if s.empty() {
		return []dipRect{full}
	}
	right, bottom := s.X+s.W, s.Y+s.H
	strips := make([]dipRect, 0, 4)
	add := func(x, y, w, h float32) {
		if w > 0.01 && h > 0.01 {
			strips = append(strips, dipRect{x, y, w, h})
		}
	}
	add(full.X, full.Y, full.W, s.Y-full.Y)           // 上
	add(full.X, bottom, full.W, full.Y+full.H-bottom) // 下
	add(full.X, s.Y, s.X-full.X, s.H)                 // 左
	add(right, s.Y, full.X+full.W-right, s.H)         // 右
	return strips
}

// ── 尺寸标签的位置 ─────────────────────────────────────

// estimateTextWidth 估一段 12px 文字的宽度（DIP）：CJK 按一个字宽，其余按半个多一点。
// 只用来摆尺寸标签，差几个像素无妨。
func estimateTextWidth(s string) float32 {
	w := float32(16) // 左右 padding
	for _, r := range s {
		if r > 0x2E7F {
			w += 12
		} else {
			w += 6.8
		}
	}
	return w
}

const snapshotLabelHeight = 22

// labelPos 尺寸标签贴在选区右下角外侧；出了屏就挪回选区内侧，保证标签整块在屏内。
func labelPos(sel dipRect, textW, w, h float32) (x, y float32) {
	x, y = sel.X+sel.W+4, sel.Y+sel.H+4
	if x+textW > w-4 {
		x = sel.X + sel.W - textW - 4
	}
	if y+snapshotLabelHeight > h-4 {
		y = sel.Y + sel.H - snapshotLabelHeight - 4
	}
	return max(x, 4), max(y, 4)
}

// ── 拖动状态机 ─────────────────────────────────────────

// snapPointer 一帧的指针快照。Button：0 主键、1 右键、2 中键；Down = 正按着。
type snapPointer struct {
	X, Y   float32
	Button int
	Down   bool
}

// snapDrag 一次按下—拖动—松开；只在主线程读写。
type snapDrag struct {
	Active bool
	SX, SY float32 // 按下点（DIP）
	CX, CY float32 // 当前点 / 松开点（DIP）
}

type snapSettle int

const (
	settleNone   snapSettle = iota // 还没结论
	settleCancel                   // 右键：取消
	settleClick                    // 位移 < 6 DIP：单击，走窗口吸附
	settleDrag                     // 框选完成
)

// snapStep 推进一步状态机：返回这一帧的结论。指针位置先夹回遮罩内——拖出窗口边再松开，
// 选框最多到边，不会算出负尺寸。
func snapStep(d *snapDrag, p snapPointer, w, h float32) snapSettle {
	if p.Down && p.Button == 1 {
		return settleCancel
	}
	x, y := min(max(p.X, 0), w), min(max(p.Y, 0), h)
	if p.Down && p.Button == 0 {
		if !d.Active {
			d.Active, d.SX, d.SY = true, x, y
		}
		d.CX, d.CY = x, y
		return settleNone
	}
	if !d.Active {
		return settleNone
	}
	d.Active = false
	d.CX, d.CY = x, y // 松开那一帧的位置也要算上：它可能比最后一个按住帧多走几像素
	if math.Hypot(float64(d.CX-d.SX), float64(d.CY-d.SY)) < snapshotClickSlop {
		return settleClick
	}
	return settleDrag
}

// rect 当前选框（任意方向拖都归一成左上角 + 正宽高）。
func (d snapDrag) rect() dipRect {
	return dipRect{min(d.SX, d.CX), min(d.SY, d.CY), abs32(d.CX - d.SX), abs32(d.CY - d.SY)}
}

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

// ── 像素 ───────────────────────────────────────────────

// frameRGBA 把 GDI 抓到的 32bpp BGRA 缓冲**就地**变成 image.RGBA（不拷贝）：
// 交换 B/R，并把 alpha 钉成 255——屏幕 DC 抓下来的 alpha 常常是 0，不钉就会得到一张全透明的图。
func frameRGBA(bgra []byte, w, h int) *image.RGBA {
	n := w * h * 4
	if w <= 0 || h <= 0 || len(bgra) < n {
		return nil
	}
	pix := bgra[:n]
	for i := 0; i+3 < n; i += 4 {
		pix[i], pix[i+2] = pix[i+2], pix[i]
		pix[i+3] = 0xff
	}
	return &image.RGBA{Pix: pix, Stride: w * 4, Rect: image.Rect(0, 0, w, h)}
}

// cropRGBA 按物理像素矩形从冻结帧里抠出选区（r 已是帧内坐标）。
func cropRGBA(src *image.RGBA, r pxRect) *image.RGBA {
	if src == nil || r.empty() {
		return nil
	}
	r = clipRect(r, src.Rect.Dx(), src.Rect.Dy())
	if r.empty() {
		return nil
	}
	dst := image.NewRGBA(image.Rect(0, 0, r.W, r.H))
	for row := 0; row < r.H; row++ {
		from := src.PixOffset(r.X, r.Y+row)
		copy(dst.Pix[row*dst.Stride:row*dst.Stride+r.W*4], src.Pix[from:from+r.W*4])
	}
	return dst
}

// resizeRGBA 等比缩到目标宽度（双线性）。
func resizeRGBA(src *image.RGBA, targetW int) *image.RGBA {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	targetW = max(targetW, 1)
	targetH := max(int(math.Round(float64(h)*float64(targetW)/float64(w))), 1)
	dst := image.NewRGBA(image.Rect(0, 0, targetW, targetH))
	xdraw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	return dst
}

// ── 编码回退 ───────────────────────────────────────────

// encodeSnapshot 出一张能过页面 8MB 上限的图：
//
//	PNG ≤ maxBytes → PNG
//	否则 JPEG（质量 90）≤ maxBytes → JPEG
//	否则等比缩到宽 ≤ maxWidth，再各编一次取小的那张
//	仍超 → errSnapshotTooLarge
func encodeSnapshot(img *image.RGBA, maxBytes, maxWidth int) (SnapshotResult, error) {
	if img == nil || img.Rect.Empty() {
		return SnapshotResult{}, errSnapshotEmpty
	}
	if data, err := pngBytes(img); err == nil && len(data) <= maxBytes {
		return pngResult(img, data), nil
	}
	if data, err := jpegBytes(img); err == nil && len(data) <= maxBytes {
		return jpegResult(img, data), nil
	}
	scaled := resizeRGBA(img, min(img.Rect.Dx(), maxWidth))
	jpg, errJ := jpegBytes(scaled)
	pngData, errP := pngBytes(scaled)
	switch {
	case errJ != nil && errP != nil:
		return SnapshotResult{}, errSnapshotTooLarge
	case errJ != nil || (errP == nil && len(pngData) <= len(jpg)):
		if len(pngData) > maxBytes {
			return SnapshotResult{}, errSnapshotTooLarge
		}
		return pngResult(scaled, pngData), nil
	default:
		if len(jpg) > maxBytes {
			return SnapshotResult{}, errSnapshotTooLarge
		}
		return jpegResult(scaled, jpg), nil
	}
}

func pngResult(img *image.RGBA, data []byte) SnapshotResult {
	return SnapshotResult{MimeType: "image/png", Data: base64.StdEncoding.EncodeToString(data), Width: img.Rect.Dx(), Height: img.Rect.Dy()}
}

func jpegResult(img *image.RGBA, data []byte) SnapshotResult {
	return SnapshotResult{MimeType: "image/jpeg", Data: base64.StdEncoding.EncodeToString(data), Width: img.Rect.Dx(), Height: img.Rect.Dy()}
}

func pngBytes(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func jpegBytes(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: snapshotJPEGQuality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
