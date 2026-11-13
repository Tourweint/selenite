# lifediary-relay（中继节点）

哑中继：WS 设备转发 + REST 反向代理 + 名册 / 加入码 / 配对。不解析业务语义、不改写正文；
配对码与设备令牌只存 sha256，日志不含 payload。

```
手机 ──→ 中继（VPS） ──→ 电脑（harness，任务主机）
              ↑ 两端都主动连中继；中继持固定公网地址
```

## 部署（推荐：VPS + Node 20 + systemd）

前提：一台公网 VPS，放行 TCP 端口（默认 `8084`，WS 与 HTTP 同端口，只放行这一个就够）。

1. 服务器装 Node 20 与 pnpm（`corepack enable`）。
2. 把仓库的 `ts/` 工作区传上去（至少 `packages/shared`、`apps/relay`、`pnpm-lock.yaml`、
   `packages/shared` 的源码要齐——relay 依赖 `@lifediary/shared`），然后 `pnpm install --frozen-lockfile`。
3. 环境变量（systemd `Environment=` 或 `EnvironmentFile=`）：

   | 变量 | 默认 | 说明 |
   | --- | --- | --- |
   | `RELAY_PORT` | `8084` | 监听端口 |
   | `RELAY_STORE_PATH` | `.data/relay-state.json` | 名册落点（码与令牌只存 sha256） |
   | `RELAY_OWNER_TOKEN` | 空（仅 loopback 可管理） | **公网部署必配**：签发加入码 / 撤销设备 / 设主机位都要它 |
   | `RELAY_CODE_TTL_SECONDS` | `300` | 配对码有效期 |
   | `RELAY_MAX_DEVICES` | `32` | 设备上限 |
   | `RELAY_MOBILE_PROXY_ENABLED` | 开 | `off` = 手机反代与扫码加入整体 404 |

4. systemd 单元示例（路径按实际仓库落点调整）：

   ```ini
   [Unit]
   Description=lifediary relay
   After=network-online.target

   [Service]
   WorkingDirectory=/opt/lifediary/ts
   Environment=RELAY_PORT=8084
   Environment=RELAY_STORE_PATH=/var/lib/lifediary-relay/state.json
   Environment=RELAY_OWNER_TOKEN=<随机长串>
   ExecStart=/usr/bin/pnpm --filter @lifediary/relay start
   Restart=always
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```

5. 探活：`curl http://127.0.0.1:8084/api/relay/info`（免鉴权，不含密钥，
   返回 `{name, protocolVersion, pairing, onlineDevices}`）。

## 两端怎么挂上来

**电脑（harness，任务主机）**——`.env`：

```ini
RELAY_ENABLED=1
RELAY_URL=ws://<vps-ip>:8084
RELAY_TOKEN=<中继签发的 deviceToken>
RELAY_DEVICE_NAME=书房主机
```

`RELAY_TOKEN` 的来历（在中继所在机器上执行，owner 令牌内网直通或带 `RELAY_OWNER_TOKEN`）：

```bash
# 1. 签一枚加入码
curl -s -X POST http://127.0.0.1:8084/api/relay/pair/code
# 2. 用码换设备令牌（deviceToken 只回这一次，立刻抄下来）
curl -s -X POST http://127.0.0.1:8084/api/relay/join \
  -H 'content-type: application/json' \
  -d '{"joinCode":"<上一步的 code>","deviceName":"书房主机","platform":"desktop"}'
```

填好后重启 harness；连上后中继把它记为名册设备，`/api/relay/home-device` 可把它设为任务主机。

**手机**——不用任何手工配置：电脑 web 端 `设置 → 连接 → 经中继添加设备` 出二维码，
手机 App 扫码即加入（拿自己的 deviceToken，之后走中继；换 WiFi / 用流量都能连）。

## 日常运维

- 名册 / 设备列表：`GET /api/relay/devices`；改名 / 撤销 / 设主机位见 `src/server.ts` 路由表。
- 加错或换机：撤销旧设备（令牌立即失效 + 踢下线），重新出码。
- 名册文件可随迁移搬迁（只存 sha256，不含明文凭据）。
