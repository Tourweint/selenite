# 启动页 · 四版方案（已选 A + C）

> 壳拉起 node 那几秒（首次常 6–12s，预算 25s）窗口里显示什么。
> **已拍板：浅色主题用 A「冷光」，深色主题用 C「夜航」，跟随业务页当前主题切换。** 两版都已落进 `desktop/pages.go`。

## 目录

| 文件 | 是什么 |
|---|---|
| `index.html` | 四版并排对比页（活页面，含「正常 / 慢启动」切换）。先开这个 |
| `A-冷光.html` | 水晶被点亮 → **已用于浅色主题**（paper / white） |
| `B-题头.html` | 纯文字，一张纸一行字（未采用，留作参考） |
| `C-夜航.html` | 深靛开场 → **已用于深色主题**（indigo / black） |
| `D-轨道.html` | 四步进度 + 日志（未采用，留作参考） |
| `shots/*.png` | 四版的静帧（1120×740，真实窗口尺寸） |
| `rendered/*.html` | 真实 Go 模板导出的页面（`paper` / `indigo` / `*-offline`），截图核对用 |
| `rendered/*.png` | 上面这些页面在 Edge 里拍出来的样子（含 `*-slow` 慢启动态） |
| `assets/crystal-mark.png` | 首页题头那枚水晶（已裁透明边，278×460） |

## 现状的两个毛病

改造前 `connectingPage` 一行字、一个脉冲点，底色写死 `#0f1115`：

1. **闪**：业务页默认 paper `#fdf9f2`，加载页是黑的 → 起手黑几秒再一片白。
2. **没证据**：超过 10 秒时用户分不清「慢」和「死了」，页面上没有任何会动的东西可看。

两版共同处理这两件：底色跟主题走、都带同一个 40px 自绘标题栏（同一个 `--backdrop`、同一个品牌字位），切进业务页只有内容区变；进度只给能对得上的账——已等几秒、探测几次、壳真观测到的那一刻，**不画百分比**。

## 四版取舍

| | A 冷光 | B 题头 | C 夜航 | D 轨道 |
|---|---|---|---|---|
| 第一眼 | 认得出是 Selenite | 安静，像书扉页 | 有仪式感 | 像仪表台 |
| 慢启动 | 好：多一行解释 | 一般 | 好：动画耐看 | 最好：卡在哪一步写着 |
| 主题 | 纸白 / 白 | 纸白 / 白 | 只配 indigo / black | 纸白 / 白 |
| 成本 | 低（一张图 + 遮罩） | 最低（纯文字） | 中（SVG 弧 + 三层动效） | 中高（要壳推步骤） |
| 最坏 | 图没打进去就是空白 | 太素，像加载失败 | 浅色用户被黑一下 | 步骤是假的就是撒谎 |

结论：浅色（paper / white）铺 A，深色（indigo / black）铺 C。C 单独用会「给浅色用户黑一下」，A 单独用又撑不起靛蓝夜——拆成两副脸，各自的短板正好被另一个主题排除掉。

## 已经落成什么样

| 位置 | 做了什么 |
|---|---|
| `desktop/pages.go` | `dayPage`（A）+ `nightPage`（C）两套模板，`connectingPage` 按 `themeIsDark(savedTheme())` 选脸；`offlinePage` 同一套标题栏，靠 `{{FACE}}` 换配色 |
| `desktop/theme.go` | 壳自己记一份主题：`%AppConfigDir%/Selenite/theme`；`Shell.SetTheme` / `Shell.Theme` 绑定给业务页 |
| `desktop/main.go` | `loadService` 里接 `watchSplash`（每 400ms 探端口）；`BackgroundColor` 改成 `splashBackground(savedTheme())` |
| `desktop/assets/crystal-mark.png` | `//go:embed` 进二进制，运行期转 base64 data URI → 页面在 `about:blank` 里也完全自包含 |
| `web/index.html` + `web/theme.js` | 每次加载 / 切换主题时回写 `Shell.SetTheme`，启动页才能在业务页起来之前铺对色 |
| `desktop/pages_test.go` | 钉住「浅色铺纸白、深色铺夜航、占位全换掉、水晶是 data URI」；设 `SPLASH_DUMP_DIR` 时顺带导出页面供截图 |

进度从哪来，三条都对得上账：

- **已等几秒**：页面自己的 `performance.now()`；
- **探测几次**：按真实的 250ms 探测间隔算（`{{PROBE_MS}}` 注入，不假报）；
- **壳能真观测到的中间信号**：`watchSplash` 每 400ms `listening(port)` 探一次，node `listen()` 成功那一刻推一句「进程起来了，等它就绪」，报一次就收工。

超过 9s（`slowAfter`）换语气：「再等一会儿」+ 一行解释（首次要编译 TypeScript），标题栏变「较慢」。不换布局，画面不跳。

## 已知边界

1. **拖不动窗口**：`LoadHTML(html, "")` 是 `about:blank`，MyGo 只对授信页面处理 `-webkit-app-region: drag`，所以这 40px 标题栏只是「长得像」，启动期间拖不动。要能拖得改成 `LoadHTML(html, "http://127.0.0.1:39847/")` 之类的授信 origin（页面还没起来时这条路不通），或等 MyGo 放开。
2. **老用户第一次仍是浅色**：`theme` 文件要有一次业务页加载才写得进去。升级后没进过业务页的人，若用的是 indigo / black，会先看到一版纸白启动页。
3. **主题切换后立刻崩掉服务**：启动页读的是上次落盘的主题，切完主题马上重连也是对的；但若切完主题直接杀进程，下一次启动读的是切换后的值，符合预期。

## 预览参数

单页支持两个 query：

- `?state=slow`：直接看慢启动（>9s）那一屏（A/B/C/D 都支持）
- `?t=5.4`：把时间轴推到第 5.4 秒（只有 D 用得上，截某一步的样子）

静帧是用 Edge 无头 + `--force-prefers-reduced-motion` 拍的，所以图里动效停在基础态；直接用浏览器打开 HTML，动画是在跑的。无头里 CSS transition/animation 在虚拟时间下不推进，所以每版都写了「动画关闭时等同终态」的基础样式——真要改模板，别只靠截图判断。

重出真实页面：

```powershell
$env:SPLASH_DUMP_DIR = "<repo>\desktop\design\splash\rendered"
C:\Program Files\Go\bin\go.exe test -count=1 -run TestSplashPages .\desktop
```
