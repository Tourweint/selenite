# VPS 中继机运维手册（<VPS_IP>）

> 一句话：这台机器跑着多设备同步的中继；这份文档只回答两件事——**怎么进去**、**连不上时按哪几步查**。
> 最后核对：2026-11-15 01:45（CST），当时 SSH 正常、中继 `active`、`/healthz` 返回 `{"ok":true,"onlineDevices":1}`。

## 0. 一页速查

| 项 | 值 |
|---|---|
| 公网地址 | `<VPS_IP>`（阿里云，KVM 虚拟机） |
| 主机名 | `<VPS_HOST>`（内网 `eth0` = `<VPS_INTERNAL_IP>/18`） |
| 系统 | Ubuntu 22.04.5 LTS，内核 5.15.0-142-generic，时区 `Asia/Shanghai`，NTP 已开 |
| 规格 | 2 vCPU / 1608 MB 内存 + 2 GB swap / 40 GB 磁盘（已用 27%） |
| SSH | `22/tcp`，**只认密钥**（密码登录已关闭） |
| 中继服务 | `lifediary-relay.service`，`8084/tcp`，Node v20.20.2（`/usr/bin/node`） |
| 中继目录 | `/opt/lifediary-relay`（代码 `src/`，数据 `.data/`，运行用户 `relay`） |
| 探活 | `http://<VPS_IP>:8084/healthz` → `{"ok":true,"onlineDevices":N}` |
| 防火墙 | ufw 开启，默认拒绝入站，只放行 22 与 8084；fail2ban 带 `sshd` jail |
| 日志 | journald，上限 200 MB（当前约 176 MB） |

**最常用的一条命令**（在你自己电脑上）：

```powershell
ssh root@<VPS_IP>
```

## 1. 怎么进（四条路，按顺序试）

### ① 这台电脑：已经能用

```powershell
ssh root@<VPS_IP>
```

走的是 `C:\Users\<user>\.ssh\id_ed25519`（`~/.ssh/config` 里已经写了 `Host <VPS_IP> / User root`）。
VPS 上 `authorized_keys` 目前**只有这一把**：

```
<SSH_KEY_FINGERPRINT>  <user>@<user> (ED25519)
```

### ② 另一台电脑：加它自己的一把钥匙

在那台电脑上：

```powershell
ssh-keygen -t ed25519 -C "第二台电脑"
# 生成后把 id_ed25519.pub 的内容（整行）拿到任意一台能进的电脑上执行：
ssh root@<VPS_IP> "echo 'ssh-ed25519 AAAA…你的公钥' >> /root/.ssh/authorized_keys"
```

之后那台电脑 `ssh root@<VPS_IP>` 就能进。**每台电脑各一把**：以后哪台不用了，删掉它那一行即可，不影响别的电脑。

### ③ 新电脑只想先进一次：临时开密码入口

```powershell
# 开（有效期自己控制，办完就关）
ssh root@<VPS_IP> "printf 'PasswordAuthentication yes\nPermitRootLogin yes\n' > /etc/ssh/sshd_config.d/98-temp-password.conf && systemctl reload ssh"

# 关（务必执行）
ssh root@<VPS_IP> "rm -f /etc/ssh/sshd_config.d/98-temp-password.conf && systemctl reload ssh"
```

> **为什么必须叫 `98-`**：sshd 对同一配置项是**先读到的生效**，字典序 `98-…` 在 `99-lifediary-hardening.conf` 之前；写成 `99-` 会被 hardening 里的 `PasswordAuthentication no` 压住，等于没开。

root 密码用哪一份，见下一节。

### ④ 最兜底：阿里云控制台 VNC（不依赖 SSH、不依赖任何一台电脑）

阿里云控制台 → 实例 → **远程连接**（VNC / Workbench）→ 用 root 密码登录。这是唯一"钥匙全废也能进"的路。

root 密码（2026-11-14 换成的 28 位随机值）**存了两份**：

| 位置 | 权限 | 用途 |
|---|---|---|
| 本机 `C:\Users\<user>\.ssh\<redacted-root-password-file>.txt` | 仅当前 Windows 账户可读写 | 电脑能开机就能看到，VNC 登录用 |
| VPS `/root/.root-password-20261114` | `600 root:root` | SSH 进去后复核用 |

**为什么两边都要存**：如果哪天 `authorized_keys` 被写坏、所有密钥都进不去，VNC 登录本身也要密码——只存在 VPS 上就等于鸡生蛋，那才是真的进不去。

## 2. 连不上时，按这个顺序查（每步都有"该看到什么"）

### 第 1 层：SSH 都连不上

```powershell
Test-NetConnection -ComputerName <VPS_IP> -Port 22     # True 才说明端口可达
ssh -v root@<VPS_IP>                                    # 看卡在哪个阶段
```

| 现象 | 大概率原因 | 处置 |
|---|---|---|
| 端口 22 不通 | 阿里云安全组 / 实例关机 / ufw 被改 | 控制台查实例状态与安全组；VNC 登录后 `ufw status` |
| `Permission denied (publickey)` | 这台电脑的公钥没在 `authorized_keys` 里，或私钥不对 | 换一台能进的电脑补公钥；或走 ③ 临时密码 / ④ VNC |
| 能连但很慢、偶尔断 | 网络抖动（`ClientAlive` 每 120 秒探一次，4 分钟无响应会回收） | 正常；长期挂后台用 `tmux` |

如果怀疑被 fail2ban 封了（在能进的电脑上执行）：

```powershell
ssh root@<VPS_IP> "fail2ban-client status sshd; fail2ban-client set sshd unbanip <你的公网IP>"
```

### 第 2 层：SSH 能进，但中继服务不对

```bash
systemctl status lifediary-relay --no-pager
ss -tlnp | grep 8084
curl -s http://127.0.0.1:8084/healthz          # 应回 {"ok":true,...}
journalctl -u lifediary-relay -n 40 --no-pager
```

| 现象 | 处置 |
|---|---|
| `inactive (dead)` / `failed` | `systemctl restart lifediary-relay`；看 `journalctl -n 60`，`Restart=always` 已开、`RestartSec=2`，正常会自己回来 |
| 起不来且日志报 `EADDRINUSE` | 端口被别的进程占了：`ss -tlnp | grep 8084` 找到 pid，确认是谁 |
| 反复重启 | 看 `NRestarts`（`systemctl show lifediary-relay -p NRestarts`）；`MemoryMax=256M` 触顶会被杀，日志里会有 OOM |
| `/healthz` 通但名册不对 | 见第 3 层 |

### 第 3 层：中继在跑，电脑这端显示"未连接"

在**电脑**上（harness 端口 39847，需要 AGENT_TOKEN）：

```powershell
$h=@{Authorization="Bearer <AGENT_TOKEN>"}
(Invoke-WebRequest http://127.0.0.1:39847/api/v1/relay/status -Headers $h).Content
```

对照 `relay/status` 的字段：

| 字段 | 含义 |
|---|---|
| `connected` | 当前是否连上中继 |
| `configured` / `source` | 有没有客户端配置、配置来自 `env` 还是 `.data/relay-link.json` |
| `blockedByPid` | 同机另一个 harness 占着同一设备身份（会互相顶替，两个都"时通时断"） |
| `reconnects` | 累计重连次数 |
| `lastCloseCode` | 上次断开原因，**排障主要看这个** |
| `lastPongAt` | 最近一次心跳回包（客户端每 20 秒 ping 一次） |

关闭码语义（中继侧约定）：

| 码 | 含义 | 通常怎么办 |
|---|---|---|
| `1006` / `1001` | 中间网络掐断 / 对端走了 | 常见于本机重启 harness；能自己重连就不管 |
| `4400` | 协议版本不符 | 两端版本要一致 |
| `4401` | 令牌被撤销 | 中继名册里撤销了这台设备，重新签码 |
| `4402` | 握手超时 | 网络太差或中继过载 |
| `4409` | 同设备顶替 | 有两处用同一 `deviceId`，关掉多余那个（看 `blockedByPid`） |
| `1013` | 中继过载（背压） | 慢消费者，客户端退避重连 |

同时在中继上看对端有没有来：

```bash
journalctl -u lifediary-relay -n 30 --no-pager | grep -E "hello|bye|backpressure"
```

`hello … online=1` 表示这台电脑已登记；只有 `bye` 没有 `hello`，说明电脑那边没连上或刚被顶替。

### 第 4 层：手机连不上

```bash
TOKEN=$(cut -d= -f2- /etc/lifediary-relay.env)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8084/api/relay/devices
```

看手机是否在名册、`online` 是否为 `true`。手机侧常见问题：

- 手机只连中继（`http://<VPS_IP>:8084/api/v1`），**不直连电脑**；中继再把请求投给名册里的任务主机（`isHome=true`）。
- 名册里没有手机 → 加入码过期/被用过：电脑端「远程添加手机」重新出码。
- 名册里有但一直 `online=false` → 手机端网络到不了 VPS（换流量/换 WiFi 试；中继只放行 8084 一个端口）。

## 3. 服务本身怎么管

### 目录与关键文件

| 路径 | 说明 |
|---|---|
| `/opt/lifediary-relay/src/` | 中继源码（`index.ts` 入口、`server.ts` 路由与鉴权、`hub.ts` WS 路由、`store.ts` 名册） |
| `/opt/lifediary-relay/.data/relay-state.json` | 名册落点（设备与加入码**只存 sha256**），`600`、目录 `700` |
| `/etc/lifediary-relay.env` | 只放 `RELAY_OWNER_TOKEN`，`600 root:root`；**值不要在聊天/文档里贴** |
| `/etc/systemd/system/lifediary-relay.service` | unit（见下） |
| `/root/.root-password-20261114` | root 密码（救援用） |
| `/root/sshd_config.bak-20261114` | 加固前的 `sshd_config` |
| `/root/lifediary-relay.service.bak-20261114` | 加固前的 unit |
| `/opt/lifediary-relay/src/server.ts.bak-20261114-security` | 加固前的中继源码 |
| `/opt/lifediary-relay/src.bak-20261114/` | 更早的整目录备份 |

### unit 要点（`systemctl cat lifediary-relay`）

```ini
User=relay
Environment=RELAY_PORT=8084
EnvironmentFile=-/etc/lifediary-relay.env
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=always          # 崩了也起、正常退出也起
RestartSec=2
UMask=0077              # 服务写的状态文件默认 600（不加这条，store 重写会把权限冲回 644）
MemoryMax=256M          # 触顶会被杀，靠 Restart 自愈
# 另有 NoNewPrivileges / PrivateTmp / PrivateDevices / ProtectSystem=full / ProtectHome
# / ProtectKernelTunables / ProtectKernelModules / ProtectControlGroups / RestrictSUIDSGID
# / RestrictAddressFamilies / SystemCallArchitectures
```

日常操作：

```bash
systemctl restart lifediary-relay        # 重启（电脑端会 1006 后自动重连，约 8 秒）
systemctl reload-or-restart lifediary-relay
journalctl -u lifediary-relay -f         # 跟随日志
```

### 更新中继代码（必须两端一致）

改的是**仓库里的** `ts/apps/relay/src/server.ts`，再整份推到 VPS，别在 VPS 上直接手改：

```powershell
# 1) 本地跑测试（这个包没有 test 脚本，用 ts 根目录的 tsx 直接跑）
cd <repo>\ts\apps\relay
& ..\..\node_modules\.bin\tsx.cmd --test src/store.test.ts src/hub.test.ts
# 2) 备份现有文件
ssh root@<VPS_IP> "cp -p /opt/lifediary-relay/src/server.ts /opt/lifediary-relay/src/server.ts.bak-$(date +%Y%m%d)"
# 3) 上传
scp <repo>\ts\apps\relay\src\server.ts root@<VPS_IP>:/opt/lifediary-relay/src/server.ts
# 4) 重启并验证
ssh root@<VPS_IP> "systemctl restart lifediary-relay && sleep 3 && curl -s http://127.0.0.1:8084/healthz"
```

> 第 2 步的 `$(date …)` 在 PowerShell 的双引号里会被**本地**先展开；照抄没问题（本机日期和 VPS 同一时区），想更严谨就把整条用单引号传。

## 4. 当前安全配置快照（2026-11-15）

| 项 | 值 |
|---|---|
| `PasswordAuthentication` | **no** |
| `PermitRootLogin` | `without-password`（只认密钥） |
| `PubkeyAuthentication` | yes |
| `KbdInteractiveAuthentication` | no |
| `MaxAuthTries` / `LoginGraceTime` | 3 / 30s |
| `ClientAliveInterval` / `CountMax` | 120s / 2（半死连接 4 分钟内回收） |
| `X11Forwarding` | no |
| 生效配置文件 | `/etc/ssh/sshd_config.d/99-lifediary-hardening.conf`（原 `sshd_config` 第 12 行 `Include` 这个目录，先见优先） |
| ufw | 默认拒绝入站，放行 `22/tcp`、`8084/tcp`（v4+v6） |
| fail2ban | 运行中，jail `sshd`（当前封禁 0） |
| journald | `/etc/systemd/journald.conf.d/99-lifediary.conf`：`SystemMaxUse=200M`、`SystemMaxFileSize=50M` |

## 5. 中继名册现状

| 设备 | id | 平台 | 在线 | 备注 |
|---|---|---|---|---|
| 书房主机 | `<DEVICE_ID_A>` | win32 | ✅ | `isHome=true`（任务主机），就是你日常在用的这台电脑 |
| vivo手机 | `<DEVICE_ID_B>` | android | ❌ | 经中继加入过，当前不在线 |

电脑端（harness）对应配置在 `ts/apps/server/.env`：

```ini
RELAY_ENABLED=1
RELAY_URL=ws://<VPS_IP>:8084
RELAY_DEVICE_NAME=书房主机
RELAY_TOKEN=<这台电脑的设备令牌，别贴出去>
RELAY_OWNER_TOKEN=<管理令牌，别贴出去>
```

## 6. 明确没做 / 已知限制

- **8084 是明文 HTTP**。`Authorization: Bearer` 过公网可被嗅探，手机侧同样。要上 TLS 得先有域名（Let's Encrypt 不签 IP），并且 harness 客户端与手机端都要改信任链；自签反而逼客户端关校验，比明文更糟。目前按"先可用、后加密"处理。
- **22 端口对全网开放**（靠只认密钥 + fail2ban 兜底）。没做来源白名单：会挡住"人在外面应急"。
- 机器上的 `xray`、`magpie` 是别的服务，与本中继无关，不要顺手动。
- 中继只存路由元数据（设备、在场、主机位），不存会话正文。

## 7. 变更时间线

| 日期 | 事件 |
|---|---|
| 2026-11-05 | 中继上线：Node 20 + systemd，`8084` 同端口承载 REST 与 WS |
| 2026-11-14 | 手机经中继反代、扫码加入；`join-code` / `invoke` 一套落地 |
| 2026-11-14 晚 | **VPS 加固**：SSH 关密码只认密钥、root 密码换随机、unit 加系统面收窄、新增 `/healthz`、`www/` 缺失回 404、journal 限 200M、owner 令牌改常量时间比较（详见 `docs/变更记录/2026-11-14-中继VPS加固.md`） |
| 2026-11-15 | 补 `UMask=0077`（否则服务重写 `relay-state.json` 会把权限冲回 644）；本手册归档 |
