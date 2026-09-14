# dsh-monitor-card

DSH Web GUI 常驻悬浮系统状态卡（右下角、可拖拽、右下角拉角可手动调宽高、跨刷新记忆位置与尺寸；footer 蓝点单击隐藏、白圈单击恢复）。一屏摘要：

- **GPU（每卡）**：温度 / 利用率 / 显存（MiB 带单位，与 nvidia-smi 同口径，如 `19439/20480 MiB`；不显示显卡型号，悬停行名可见全名 tooltip；功耗收集，`showPower: true` 才展示）
- **主机**：CPU 占用 / 内存 / load1
- **引擎（SGLang）**：tok/s / KV 水位 / 排队 / 在跑

数据通路 = 宿主 web server 同源路由 `GET /dsh-monitor-card/status`（:3080，**不新增端口**）；
客户端是手写零构建 CJS bundle（`shell.overlay` 槽）。宿主半唯一外部依赖 `@deepseek-ai/schemastery`（钉 3.18.2，与宿主同树同版本）。

**适配宿主**：DSH `v0.1.5-rc.2`（2026-09-14 实测）；Node `^22.19 || >=24`（与 [dsh-plugin-guide](https://github.com/PerryLink/dsh-plugin-guide) 基线一致）。小版本升级（尤其 0.1.5 正式版）未验证——升级宿主前请先在新版本上以 `--dump-config` 确认插件行无 FAILED、`shell.overlay` 槽仍在。

## 安装

```bash
# git 通道（推荐，直接装本仓库 tag / main）
dsh plugin --profile web add github:Neo-113/dsh-monitor-card#v0.2.7

# tarball 通道（本地 tgz：本仓库 pnpm pack，或从 Releases 下载）
dsh plugin --profile web add file:<tgz 所在本地路径>/dsh-monitor-card-0.2.7.tgz
```

（npm 通道：本包未发布 npm，不适用。）

- git 通道需能访问 github.com（经受控网络需配代理；`dsh plugin add` 透传 pnpm + git clone）。
- 装不上 / 依赖未自愈（指南 #13）：到 profile 目录手工 `pnpm install` 再重试。
- 装完需**重启 dsh web** 才生效（bundle 启动时装载）。

## 配置

编辑 profile 的 `cordis.patch.yml` 中 `id: dsh-monitor-card` 行的 `config`。
**整行替换、非深合并**：覆写时必须重述全部键。

| 键 | 默认 | 说明 |
|---|---|---|
| `pollMs` | `1000` | 前端轮询间隔（≥500），亦随响应 `config` 下发 |
| `showPower` | `false` | 是否展示功耗列 |
| `engineUrl` | `http://127.0.0.1:30000/metrics` | SGLang /metrics 地址（30000 为 SGLang 默认端口；引擎端口不同改此项） |
| `smiPath` | `nvidia-smi` | smi 可执行文件名/路径 |

配置写错 → 插件行启动即 FAILED 并带字段路径（Cordis `resolveConfig` 自动校验 `Config`）。

## 验证

```bash
curl -s localhost:3080/dsh-monitor-card/status
```

- `GET` 200 + JSON；`HEAD` 200 无 body；`POST/PUT` 405 + `allow`。
- 人工比对：GPU 温度 ±2°C、显存与 nvidia-smi 同值（同为 MiB，允许采样时差几十 MiB）；`host` 与 `top` 同量级；引擎与引擎自身 `/metrics` 手算一致。
- 前端：卡片默认右下角、无标题行；拖动刷新后位置仍在；双击复位位置与尺寸；右下角拉角（出现双箭头处）拖拉即可调宽高（最小 280×112，刷新后仍在；右下角 12px 为原生拉区，此区内按下不触发移动）；切会话/开侧卡不丢、不挡点击；窄卡下行内放不下的值会折到下一行，不截断；footer 行 `dsh-monitor-card` 前的蓝色圆点单击隐藏整卡（原地留一个白色小圆圈），单击白圈恢复，隐藏状态跨刷新记忆、隐藏期间暂停轮询。
- 故障注入：停 sglang → 10s 内引擎行灰置"引擎离线"，其余行正常；恢复后自动回绿。
- 安全面：`ss -ltnp` 前后 diff 无新增监听端口。

## 卸载

```bash
dsh plugin --profile web remove dsh-monitor-card
```

（或手工：删 profile `package.json` 的 file: 行 + `dsh.profile.bundles` 行，`pnpm install`，重启。）

## 排障

| 现象 | 处置 |
|---|---|
| 无悬浮卡 | 浏览器 console 看 shell overlay 相关日志；`dsh --profile web --dump-config` 确认插件行非 FAILED |
| 路由 404 | 未安装或装后未重启 dsh web |
| GPU 行"不可用" | `smiPath` 不可用/驱动异常；熔断后 5min 自动再探 |
| 引擎"离线" | 引擎端口（默认 30000）未运行或 /metrics 不可达；其余行不受影响 |
| 卡片被遮挡 / 层级异常 | 检查 overlay 层 `z-index` 抬升逻辑（`client/client.js` §2 注释） |

## 已知边界

- 路由与 GUI 同信任域、无独立鉴权（与 dsh-gpu-pulse 同口径，README 明示；如需收紧可加 session cookie 校验，默认不做）。
- 引擎端点挂起时单帧最迟 `轮询间隔 + 1.5s`（引擎超时上限）；客户端保留最后一帧、>30s 标"数据过期"。
- 指标映射针对本 build（sglang 0.5.x，指标带 `sglang:` 前缀）——映射出处见 `index.js` 头部注释；sglang 大版本升级后需按注释口径复抓一次。
