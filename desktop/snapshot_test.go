package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"math/rand"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 回滚开关：缺省开；off / false / 0（不分大小写、容忍空白）算关。
func TestNativeSnapshotEnabled(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{"", true}, {"on", true}, {"1", true}, {"yes", true},
		{"off", false}, {" OFF ", false}, {"false", false}, {"False", false}, {"0", false},
	} {
		t.Setenv("LIFEDIARY_NATIVE_SNAPSHOT", tc.value)
		if got := nativeSnapshotEnabled(); got != tc.want {
			t.Fatalf("LIFEDIARY_NATIVE_SNAPSHOT=%q：想要 %v，得到 %v", tc.value, tc.want, got)
		}
		// Capabilities 报给页面的值跟着开关走（非 Windows 平台恒 false，那边也不该开）
		if got := (Shell{}).Capabilities().NativeScreenshot; got != tc.want && nativeSnapshotSupported() {
			t.Fatalf("开关 %q 时 Capabilities.nativeScreenshot 应为 %v，得到 %v", tc.value, tc.want, got)
		}
	}
}

// DIP ↔ 物理像素：150% / 缩放 2 时的换算与往返。
func TestDipPxRoundTrip(t *testing.T) {
	if got := dipToPx(100, 1.5); got != 150 {
		t.Fatalf("缩放 1.5 时 100 DIP 应为 150px，得到 %d", got)
	}
	if got := dipToPx(100, 2); got != 200 {
		t.Fatalf("缩放 2 时 100 DIP 应为 200px，得到 %d", got)
	}
	if got := pxToDip(150, 1.5); got != 100 {
		t.Fatalf("缩放 1.5 时 150px 应为 100 DIP，得到 %v", got)
	}
	for _, scale := range []float64{1, 1.25, 1.5, 1.75, 2, 2.5} {
		for px := 0; px <= 2000; px++ {
			if back := dipToPx(pxToDip(px, scale), scale); back != px {
				t.Fatalf("scale %v：%dpx → DIP → %dpx，没回到原值", scale, px, back)
			}
		}
	}
}

// 选框（DIP）→ 截图（物理像素）的矩形换算：四边各算一次再相减。
func TestRectToPx(t *testing.T) {
	got := rectToPx(dipRect{10.3, 7.2, 100.4, 50.6}, 2)
	if want := (pxRect{21, 14, 200, 102}); got != want {
		t.Fatalf("rectToPx 得到 %+v，想要 %+v", got, want)
	}
	// 窗口矩形（px）→ DIP 画高亮 → 再回 px 截图，必须原样回来：这就是「选框与截图像素对齐」
	for _, scale := range []float64{1, 1.25, 1.5, 2, 2.5} {
		r := pxRect{X: 13, Y: 27, W: 333, H: 111}
		back := roundTripPx(r, scale)
		if back != r {
			t.Fatalf("scale %v：%+v → DIP → %+v，没回到原值", scale, r, back)
		}
	}
	if got := rectToPx(dipRect{5, 5, 0, 10}, 2); !got.empty() {
		t.Fatalf("零宽选框应为空，得到 %+v", got)
	}
	if got := rectToDip(pxRect{}, 0, 0, 1.5); !got.empty() {
		t.Fatalf("空矩形转 DIP 应为空，得到 %+v", got)
	}
}

func TestClipRect(t *testing.T) {
	cases := []struct {
		in, want pxRect
	}{
		{pxRect{10, 10, 20, 20}, pxRect{10, 10, 20, 20}}, // 在屏内：原样
		{pxRect{-5, -5, 20, 20}, pxRect{0, 0, 15, 15}},   // 左上溢出
		{pxRect{90, 90, 50, 50}, pxRect{90, 90, 10, 10}}, // 右下溢出
		{pxRect{120, 120, 10, 10}, pxRect{}},             // 整个在屏外
		{pxRect{-50, 20, 10, 10}, pxRect{}},              // 整个在左边外
	}
	for _, c := range cases {
		if got := clipRect(c.in, 100, 100); got != c.want {
			t.Errorf("clipRect(%+v, 100, 100) = %+v，想要 %+v", c.in, got, c.want)
		}
		if got := clipDipRect(dipRect{float32(c.in.X), float32(c.in.Y), float32(c.in.W), float32(c.in.H)}, 100, 100); got != (dipRect{float32(c.want.X), float32(c.want.Y), float32(c.want.W), float32(c.want.H)}) {
			t.Errorf("clipDipRect(%+v) 与 clipRect 口径不一致：%+v", c.in, got)
		}
	}
}

// 压暗条带：选区之外的区域；选区本身一条都不盖。
func TestDimStrips(t *testing.T) {
	full := dipRect{0, 0, 100, 50}
	if got := dimStrips(full, nil); len(got) != 1 || got[0] != full {
		t.Fatalf("没有选区应整屏一条，得到 %+v", got)
	}
	empty := dipRect{}
	if got := dimStrips(full, &empty); len(got) != 1 || got[0] != full {
		t.Fatalf("空选区应整屏一条，得到 %+v", got)
	}

	sel := dipRect{10, 10, 30, 20}
	strips := dimStrips(full, &sel)
	if len(strips) != 4 {
		t.Fatalf("屏中间的选区应切成四条，得到 %d 条：%+v", len(strips), strips)
	}
	area := float32(0)
	for _, s := range strips {
		area += s.W * s.H
		// 条带与选区不相交（闭区间只在边上相接）
		if s.X < sel.X+sel.W && s.X+s.W > sel.X && s.Y < sel.Y+sel.H && s.Y+s.H > sel.Y {
			t.Fatalf("条带 %+v 盖到了选区 %+v", s, sel)
		}
	}
	if want := float32(100*50 - 30*20); area != want {
		t.Fatalf("条带总面积应为 %v（整屏减选区），得到 %v", want, area)
	}

	corner := dipRect{80, 30, 20, 20} // 右下角贴边：只有上、左两条
	if got := dimStrips(full, &corner); len(got) != 2 {
		t.Fatalf("贴右下角的选区应切出两条，得到 %+v", got)
	}
	whole := full
	if got := dimStrips(full, &whole); len(got) != 0 {
		t.Fatalf("选区就是整屏时不应有压暗条带，得到 %+v", got)
	}
}

func TestLabelPos(t *testing.T) {
	if x, y := labelPos(dipRect{10, 10, 30, 20}, 80, 200, 120); x != 44 || y != 34 {
		t.Fatalf("选区右下外侧应为 (44, 34)，得到 (%v, %v)", x, y)
	}
	x, y := labelPos(dipRect{150, 100, 40, 16}, 80, 200, 120)
	if x+80 > 196 || y+snapshotLabelHeight > 116 || x < 4 || y < 4 {
		t.Fatalf("贴边时标签应整块留在屏内：(%v, %v)", x, y)
	}
}

// 拖动状态机：单击（< 6 DIP）走窗口吸附，拖动出框，右键取消。
func TestSnapStep(t *testing.T) {
	var d snapDrag
	if got := snapStep(&d, snapPointer{X: 10, Y: 10, Button: 0, Down: true}, 100, 100); got != settleNone {
		t.Fatalf("刚按下不应有结论，得到 %v", got)
	}
	if !d.Active {
		t.Fatal("按下后应进入拖动态")
	}
	if got := snapStep(&d, snapPointer{X: 12, Y: 11, Button: 0}, 100, 100); got != settleClick {
		t.Fatalf("位移 2 DIP 松开应算单击，得到 %v", got)
	}
	if d.Active {
		t.Fatal("松开后应退出拖动态")
	}

	d = snapDrag{}
	snapStep(&d, snapPointer{X: 30, Y: 5, Button: 0, Down: true}, 100, 100)
	snapStep(&d, snapPointer{X: 10, Y: 10, Button: 0, Down: true}, 100, 100)
	if got := snapStep(&d, snapPointer{X: 10, Y: 10, Button: 0}, 100, 100); got != settleDrag {
		t.Fatalf("位移 25 DIP 松开应算框选，得到 %v", got)
	}
	if got := d.rect(); got != (dipRect{10, 5, 20, 5}) {
		t.Fatalf("反向拖动的选框应归一成左上角 + 正尺寸，得到 %+v", got)
	}

	// 刚好 6 DIP：不算单击
	d = snapDrag{}
	snapStep(&d, snapPointer{X: 0, Y: 0, Button: 0, Down: true}, 100, 100)
	if got := snapStep(&d, snapPointer{X: 6, Y: 0, Button: 0}, 100, 100); got != settleDrag {
		t.Fatalf("位移正好 6 DIP 应算框选，得到 %v", got)
	}

	// 拖出遮罩边再松开：位置先夹回屏内，不会算出负尺寸
	d = snapDrag{}
	snapStep(&d, snapPointer{X: 10, Y: 10, Button: 0, Down: true}, 100, 100)
	if got := snapStep(&d, snapPointer{X: -50, Y: -50, Button: 0}, 100, 100); got != settleDrag {
		t.Fatalf("拖出边界松开应算框选，得到 %v", got)
	}
	if got := d.rect(); got != (dipRect{0, 0, 10, 10}) {
		t.Fatalf("越界选框应被夹到 [0,100] 内，得到 %+v", got)
	}

	d = snapDrag{}
	if got := snapStep(&d, snapPointer{X: 10, Y: 10, Button: 1, Down: true}, 100, 100); got != settleCancel {
		t.Fatalf("右键按下应取消，得到 %v", got)
	}
	d = snapDrag{}
	if got := snapStep(&d, snapPointer{X: 10, Y: 10, Button: 0, Down: false}, 100, 100); got != settleNone {
		t.Fatalf("没按下就松开不应有结论，得到 %v", got)
	}
}

// GDI 的 BGRA 缓冲 → RGBA：交换 B/R，alpha 钉成 255；缓冲不够长得到 nil。
func TestFrameRGBA(t *testing.T) {
	// 2×1：左像素 (B,G,R,A)=(1,2,3,0)，右像素=(4,5,6,0)
	frame := frameRGBA([]byte{1, 2, 3, 0, 4, 5, 6, 0}, 2, 1)
	if frame == nil || frame.Rect != image.Rect(0, 0, 2, 1) {
		t.Fatalf("frameRGBA 得到 %v", frame)
	}
	if got := color.RGBAModel.Convert(frame.At(0, 0)).(color.RGBA); got != (color.RGBA{R: 3, G: 2, B: 1, A: 255}) {
		t.Fatalf("左像素应为 RGBA(3,2,1,255)，得到 %+v", got)
	}
	if got := color.RGBAModel.Convert(frame.At(1, 0)).(color.RGBA); got != (color.RGBA{R: 6, G: 5, B: 4, A: 255}) {
		t.Fatalf("右像素应为 RGBA(6,5,4,255)，得到 %+v", got)
	}
	if frameRGBA([]byte{1, 2, 3}, 2, 1) != nil {
		t.Fatal("缓冲不够长应返回 nil")
	}
	if frameRGBA(nil, 0, 0) != nil {
		t.Fatal("零尺寸应返回 nil")
	}
}

func TestCropRGBA(t *testing.T) {
	src := &image.RGBA{
		Pix:    []byte{1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255},
		Stride: 8,
		Rect:   image.Rect(0, 0, 2, 2),
	}
	crop := cropRGBA(src, pxRect{X: 1, Y: 0, W: 1, H: 2})
	if crop == nil || crop.Rect != image.Rect(0, 0, 1, 2) {
		t.Fatalf("抠出右列应得 1×2，得到 %v", crop)
	}
	if crop.Pix[0] != 2 || crop.Pix[crop.Stride] != 4 {
		t.Fatalf("抠出的像素不对：%v", crop.Pix)
	}
	// 不拷贝冻结帧的底层数组
	crop.Pix[0] = 9
	if src.Pix[4] != 2 {
		t.Fatal("crop 不应改到冻结帧")
	}
	if cropRGBA(src, pxRect{X: 5, Y: 5, W: 3, H: 3}) != nil {
		t.Fatal("屏外矩形应抠不出东西")
	}
	if cropRGBA(src, pxRect{}) != nil {
		t.Fatal("空矩形应抠不出东西")
	}
}

// noiseImage 一张确定性噪点图：PNG、JPEG 都压不动，专门用来逼出回退链。
func noiseImage(w, h int, seed int64) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	rng := rand.New(rand.NewSource(seed))
	for i := range img.Pix {
		img.Pix[i] = byte(rng.Intn(256))
	}
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = 255
	}
	return img
}

// 编码回退链：PNG → JPEG(90) → 缩宽再编码；每一步的产物都必须 ≤ 上限。
func TestEncodeSnapshotFallback(t *testing.T) {
	// 1. 平图：PNG 一次过，尺寸原样
	flat := image.NewRGBA(image.Rect(0, 0, 64, 48))
	res, err := encodeSnapshot(flat, snapshotMaxBytes, snapshotMaxWidth)
	if err != nil {
		t.Fatalf("平图 PNG 应直接通过：%v", err)
	}
	if res.MimeType != "image/png" || res.Width != 64 || res.Height != 48 {
		t.Fatalf("应为 64×48 PNG，得到 %+v", res)
	}
	raw, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil || len(raw) == 0 || len(raw) > snapshotMaxBytes {
		t.Fatalf("裸 base64 解不回来或超限：err=%v len=%d", err, len(raw))
	}
	if res.Canceled {
		t.Fatal("成功结果不应带 canceled")
	}

	// 2. 噪点图 PNG 超限 → 转 JPEG
	noisy := noiseImage(300, 200, 7)
	pngLen, jpgLen := encodeLens(t, noisy)
	if jpgLen >= pngLen {
		t.Skipf("这张噪点图 JPEG(%d) 不比 PNG(%d) 小，测不出回退", jpgLen, pngLen)
	}
	budget := (pngLen + jpgLen) / 2
	res, err = encodeSnapshot(noisy, budget, snapshotMaxWidth)
	if err != nil {
		t.Fatalf("PNG 超限后 JPEG 应通过（上限 %d）：%v", budget, err)
	}
	raw, _ = base64.StdEncoding.DecodeString(res.Data)
	if res.MimeType != "image/jpeg" || res.Width != 300 || res.Height != 200 || len(raw) > budget {
		t.Fatalf("应原尺寸转 JPEG 且不超限，得到 %+v（%d 字节，上限 %d）", res, len(raw), budget)
	}

	// 3. PNG、JPEG 都超限 → 缩到宽 ≤ maxWidth 再编码
	const tiny = 6000
	res, err = encodeSnapshot(noisy, tiny, 32)
	if err != nil {
		t.Fatalf("缩宽后应通过（上限 %d）：%v", tiny, err)
	}
	raw, _ = base64.StdEncoding.DecodeString(res.Data)
	if res.Width > 32 || res.Width != 32 || res.Height != 21 || len(raw) > tiny {
		t.Fatalf("应缩到 32×21 且不超限，得到 %+v（%d 字节）", res, len(raw))
	}

	// 4. 怎么都压不进 → 明确报错（页面据此回退 getDisplayMedia）
	if _, err := encodeSnapshot(noisy, 10, 32); err != errSnapshotTooLarge {
		t.Fatalf("上限 10 字节应报 errSnapshotTooLarge，得到 %v", err)
	}
	if _, err := encodeSnapshot(nil, snapshotMaxBytes, snapshotMaxWidth); err != errSnapshotEmpty {
		t.Fatalf("nil 应报 errSnapshotEmpty，得到 %v", err)
	}
	if _, err := encodeSnapshot(image.NewRGBA(image.Rect(0, 0, 0, 0)), snapshotMaxBytes, snapshotMaxWidth); err != errSnapshotEmpty {
		t.Fatalf("空图应报 errSnapshotEmpty，得到 %v", err)
	}
}

// 缩宽是等比的，宽至少 1。
func TestResizeRGBA(t *testing.T) {
	img := noiseImage(100, 50, 3)
	if got := resizeRGBA(img, 50); got.Rect != image.Rect(0, 0, 50, 25) {
		t.Fatalf("100×50 缩到宽 50 应得 50×25，得到 %v", got.Rect)
	}
	if got := resizeRGBA(img, 0); got.Rect.Dx() != 1 {
		t.Fatalf("目标宽 ≤ 0 应按 1 算，得到 %v", got.Rect)
	}
	if got := resizeRGBA(img, 100); got.Rect != img.Rect || bytes.Equal(got.Pix, make([]byte, len(got.Pix))) {
		t.Fatal("原尺寸缩放应得到同样大小的非空图")
	}
}

// roundTripPx 窗口矩形（px）→ DIP → px：原点挪到矩形左上角，换算完再挪回来。
func roundTripPx(r pxRect, scale float64) pxRect {
	back := rectToPx(rectToDip(r, r.X, r.Y, scale), scale)
	back.X += r.X
	back.Y += r.Y
	return back
}

// encodeLens 这张图 PNG、JPEG(90) 各编出来多大（字节）。
func encodeLens(t *testing.T, img image.Image) (int, int) {
	t.Helper()
	pngData, err := pngBytes(img)
	if err != nil {
		t.Fatalf("PNG 编码失败：%v", err)
	}
	jpgData, err := jpegBytes(img)
	if err != nil {
		t.Fatalf("JPEG 编码失败：%v", err)
	}
	return len(pngData), len(jpgData)
}

// 按物理尺寸在 mygo 的显示器列表里找那一块，带回缩放。
func TestDisplayForMonitor(t *testing.T) {
	displays := []displayInfo{
		{X: 0, Y: 0, W: 1707, H: 960, ScaleFactor: 1.5},   // 2560×1440 @150%
		{X: 1707, Y: 0, W: 1920, H: 1080, ScaleFactor: 1}, // 1920×1080 @100%
	}
	if d, ok := displayForMonitor(2560, 1440, displays); !ok || d.ScaleFactor != 1.5 {
		t.Fatalf("2560×1440 应匹配到 1.5 倍缩放那块，得到 %+v ok=%v", d, ok)
	}
	if d, ok := displayForMonitor(1920, 1080, displays); !ok || d.X != 1707 {
		t.Fatalf("1920×1080 应匹配到第二块，得到 %+v ok=%v", d, ok)
	}
	if _, ok := displayForMonitor(3840, 2160, displays); ok {
		t.Fatal("列表里没有的尺寸不应匹配")
	}
	if _, ok := displayForMonitor(2560, 1440, nil); ok {
		t.Fatal("空列表不应匹配")
	}
	broken := []displayInfo{{W: 2560, H: 1440, ScaleFactor: 0}}
	if _, ok := displayForMonitor(2560, 1440, broken); ok {
		t.Fatal("缩放为 0 的脏数据不应匹配")
	}
}

// 遮罩视图无窗口真渲染（mygo 的 ui.NewTester）：冻结帧、提示条画得出来；Esc 把「取消」
// 回给 CaptureSnapshot 的通道，之后的帧不再重复回执。
func TestSnapshotViewWindowless(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 64, 48))
	o := &snapshotOverlay{
		frame:  frame,
		mw:     64,
		mh:     48,
		bitmap: ui.NewBitmap(frame),
		scale:  1,
		width:  200,
		height: 120,
		done:   make(chan snapshotOutcome, 1),
	}
	overlaySnap.Store(o)
	defer func() { overlaySnap.Store(nil) }()

	tt := ui.NewTester(snapshotView, 200, 120)
	if !tt.HasText(snapshotHint) {
		t.Fatalf("顶部提示条没画出来：%v", tt.Texts())
	}
	select {
	case <-o.done:
		t.Fatal("还没操作就有结论")
	default:
	}
	tt.Key(0, ui.KeyEscape)
	select {
	case out := <-o.done:
		if !out.canceled {
			t.Fatalf("Esc 应回取消，得到 %+v", out)
		}
	default:
		t.Fatal("Esc 没有把取消回给通道")
	}
	tt.Frame()
	select {
	case out := <-o.done:
		t.Fatalf("收尾后不应再回执，得到 %+v", out)
	default:
	}
}

// 光标下没有可截的窗口（桌面 / 任务栏 / 桌面壳）时，顶部提示条也必须每一帧都画：
// 否则用户只看到全屏压暗，没有任何操作说明。这时不画选框和尺寸标签。
func TestSnapshotViewHintWithoutHover(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 64, 48))
	const px, py = float32(100), float32(60)
	o := &snapshotOverlay{
		frame:  frame,
		mw:     64,
		mh:     48,
		bitmap: ui.NewBitmap(frame),
		scale:  1,
		width:  200,
		height: 120,
		done:   make(chan snapshotOutcome, 1),
	}
	overlaySnap.Store(o)
	defer func() { overlaySnap.Store(nil) }()

	tt := ui.NewTester(snapshotView, 200, 120)

	// 初始帧的指针在别处，视图会真的去查一次窗口并记下那个位置；所以等它画完再预置
	// 「(px, py) 这个位置查过了，底下是这个窗」。同一位置不重复查，断言才不依赖测试机上碰巧开着什么窗。
	// 矩形故意不从 0,0 起：真实窗口裁剪到显示器后左上角恒为 0,0，预置值不可能被碰巧查出来。
	const rw, rh = 40, 24
	preset := pxRect{X: 8, Y: 6, W: rw, H: rh}
	o.hoverOK, o.hoverKeyX, o.hoverKeyY = true, px, py
	o.hoverPx, o.hover = preset, dipRect{X: 8, Y: 6, W: rw, H: rh}
	tt.Move(px, py)
	tt.Frame()
	// 画面里出现它的尺寸标签，才证明这一帧确实是按 (px, py) 画的、用的是预置结果
	if !tt.HasText("40 × 24") || o.hoverPx != preset {
		t.Fatalf("前置条件不成立：这一帧没有按预置的悬停窗画（%v px=%+v）", tt.Texts(), o.hoverPx)
	}
	// 同一个位置，查过的结果改成「没有窗口」：不该再去查真实窗口，只该剩提示条
	o.hoverPx, o.hover = pxRect{}, dipRect{}
	tt.Frame()
	if o.hoverKeyX != px || o.hoverKeyY != py || o.hoverPx != (pxRect{}) {
		t.Fatalf("没有悬停窗口的那一帧又去查了真实窗口（key=%v,%v px=%+v）", o.hoverKeyX, o.hoverKeyY, o.hoverPx)
	}
	if texts := tt.Texts(); len(texts) != 1 || texts[0] != snapshotHint {
		t.Fatalf("没有悬停窗口时画面里只该有顶部提示条，得到 %v", texts)
	}
	select {
	case out := <-o.done:
		t.Fatalf("没有悬停窗口不该自己收尾，得到 %+v", out)
	default:
	}
}
