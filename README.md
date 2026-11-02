# YanyuAd

Surge 模块目录：把公开插件配置转换为 Surge 模块，静态站每天同步一次。

- 站点：https://ad.fakeyou.eu.org/
- 托管：Cloudflare Pages（项目 `yanyuad`）＋ 私有 GitHub 仓库
- 数据：外部插件目录，抓取时必须带客户端 UA，否则返回跳转页
- 不依赖 VPS、数据库或常驻进程

## 一、安装流程

### 1. 前置

| 项 | 要求 |
|---|---|
| 账号 | Cloudflare（Free 即可）、GitHub |
| 仓库 | 本仓库，生产分支 `main` |
| 运行环境 | Cloudflare 构建使用 Node 22；无需本地安装 |

### 2. 创建 Pages 项目

1. Cloudflare 控制台 → Workers & Pages → 创建 → Pages → 连接到 Git。
2. 选择本仓库，生产分支 `main`。
3. 构建配置：

| 项 | 值 |
|---|---|
| 框架预设 | 无 |
| 根目录 | `/` |
| 构建命令 | `node --test tests/*.test.mjs && node scripts/sync.mjs --production && node scripts/check.mjs` |
| 输出目录 | `dist` |

4. 环境变量（Production）：

| 变量 | 值 | 说明 |
|---|---|---|
| `NODE_VERSION` | `22` | 构建运行时 |
| `YANYUAD_BASELINE_URL` | `https://yanyuad.pages.dev/status.json` | 上一次成功部署的基线 |
| `YANYUAD_INITIAL_BUILD` | 正常 `0` | **仅首次部署**临时设 `1`，成功后立即改回 `0` 并重建验证 |
| `YANYUAD_SCHEDULER_ENABLED` | `true` | 关闭后 `status.json` 会标记未启用 |

### 3. 绑定域名

1. Pages 项目 → 自定义域 → 添加 `ad.fakeyou.eu.org`。
2. DNS：`ad` → CNAME → `yanyuad.pages.dev`，开启代理。
3. 等待证书签发，确认 `https://ad.fakeyou.eu.org/` 返回 200。

### 4. 仓库变量（供每日同步使用）

GitHub → Settings → Secrets and variables → Actions → Variables：

| 变量 | 值 |
|---|---|
| `YANYUAD_PUBLIC_BASE_URL` | `https://ad.fakeyou.eu.org` |
| `YANYUAD_ENABLED` | `true`（首次部署成功后再开） |

### 5. 验收

| 检查 | 预期 |
|---|---|
| 首页 | 显示模块列表与数量 |
| `/status.json` | `total` 与页面数量一致，`scheduler_enabled` 为 true |
| 任一模块 | `/modules/xxx.sgmodule` 返回文本，含 `#!name=` |
| 自动更新 | Actions 手动运行一次 `YanyuAd daily sync`，确认 success 且线上 `request_id` 与本次一致 |

## 二、注意事项

### 转换范围

| 已支持 | 说明 |
|---|---|
| 规则 | 域名、IP、UA、URL 正则、AND／OR／NOT 组合 |
| 重写 | URL 重写、重定向、请求与响应脚本声明 |
| 响应处理 | JSON jq 改写、字段删除／替换、正文正则替换、响应模拟、响应头改写 |
| 模块参数 | 原插件开关与下拉项转为 Surge `#!arguments` |
| HTTPS 解密 | MITM 主机名以 `%APPEND%` 追加，不覆盖本地配置 |

| 明确不支持 | 原因 |
|---|---|
| 仅含 DNS／Host／IP 回环配置的插件 | 当前转换器尚未实现这些设置的等价转换，不会强行发布；Surge 本身支持部分 General / Host / IP Rewrite 配置 |
| 上游已注释停用的动作 | 保持停用，不会擅自启用 |
| 脚本本体 | 只保留脚本地址，不下载、不执行、不改写脚本内容 |

### 会失败的边界

| 情况 | 处理 |
|---|---|
| 源站不可达、返回跳转页 | 该条标记为不可用，**不发布** |
| 失败条数超过总数 10% | 整次构建失败，保留上一成功部署 |
| 源目录或可发布模块数量比上次减少超过 10% | 构建失败，避免源目录缩水或转换退化导致批量下架 |
| 生产基线缺失、无效或可发布模块不足 | 构建失败；首次初始化例外仅限真实首次部署 |

### 版本依赖

| 能力 | 最低版本 |
|---|---|
| Map Local | iOS 5.9.1+ / macOS 5.5.1+ |
| Body Rewrite | iOS 5.10.0+ / macOS 5.6.0+ |
| jq Body Rewrite | iOS 5.14.0+ / macOS 5.9.0+ |
| Header Rewrite | 官方未标注，旧版可能不识别 |

### 其他

| 项 | 说明 |
|---|---|
| 缓存 | 脚本与样式使用内容哈希文件名；`index.html` 不缓存，避免旧包导致白屏 |
| 抓取 UA | 源站对普通浏览器 UA 返回跳转，必须使用客户端 UA |
| 许可 | 上游内容带 CC BY-NC-SA 4.0 条款。本站为个人非商业用途；公开传播前应自行评估署名与转载要求 |
| 安全 | 不采集账号、密钥；页面不加载第三方脚本 |

## 三、后期维护

### 日常

| 目的 | 操作 | 成功标准 |
|---|---|---|
| 自动更新 | 每日 10:23 定时运行 | Actions success，线上 `request_id` 与运行一致 |
| 手动更新 | Actions → `YanyuAd daily sync` → Run workflow | 同上 |
| 暂停同步 | 仓库变量 `YANYUAD_ENABLED=false` | 站点保留最后一次成功版本 |
| 恢复同步 | 变量改回 `true`，手动运行一次 | 核对 `request_id` |

### 修改内容

| 目标 | 文件 |
|---|---|
| 页面结构 | `public/index.html` |
| 视觉样式 | `public/style.css` |
| 列表、搜索、安装按钮 | `public/app.js` |
| 许可页 | `public/licenses.html`、`public/licenses/UPSTREAM.txt` |
| 转换规则 | `scripts/convert.mjs` |
| 抓取、转换、产出 | `scripts/sync.mjs` |
| 产物校验 | `scripts/check.mjs`（模块、图标和前端内容哈希及目录引用） |
| 发布保护、下载边界、输出清理 | `scripts/pipeline.mjs` |
| 部署后校验 | `scripts/wait-for-deployment.mjs` |
| 测试 | `tests/convert.test.mjs`、`tests/pipeline.test.mjs`、`tests/ui.test.mjs` |

改完必须本地通过：`npm test` → `node scripts/sync.mjs` → `node scripts/check.mjs`，再推送 `main`。

### 故障排查

| 现象 | 排查 |
|---|---|
| 页面空白 | 查看 `/` 是否正确引用 `/assets/app.<hash>.js`；强刷或清缓存 |
| 列表加载失败 | `/data/catalog.json` 是否 200；构建日志是否 `CHECK_FAILED` |
| 构建失败 | 多为源站异常或失败率超阈值；修复源站问题后重跑，不要用 `YANYUAD_INITIAL_BUILD=1` 绕过 |
| 模块 404 | 该模块本次未转换成功；查看 `status.json` 的 `skipped` 数量 |
| 安装后无效 | 依赖 Body/Header Rewrite 的模块需要较新 Surge；被拦截内容需开启 MITM |

### 回滚与卸载

| 操作 | 方法 |
|---|---|
| 回滚 | Cloudflare Pages → Deployments → 选择上一成功部署 → Rollback，并回退源码 |
| 暂停 | `YANYUAD_ENABLED=false` |
| 卸载 | 删除 Pages 项目、`ad` 解析与仓库；站点不写入其他系统 |

## 四、给 Codex 的入口

| 顺序 | 文件 |
|---|---|
| 1 | 本 README（安装、注意、维护） |
| 2 | `scripts/convert.mjs` 顶部注释与 `tests/convert.test.mjs` |
| 3 | `scripts/sync.mjs`（抓取 UA、失败阈值、产物结构） |
| 4 | `scripts/check.mjs`（不通过即构建失败） |

约束：不要放宽校验去强行发布；不要执行外部脚本；不要提交 `dist/`、密钥或账号信息。

## 五、维护记录（2026-11-02）

- 修复源数量与可发布模块数量的基线比较：分别使用上次 `upstream_total` 与 `total`，减少超过 10% 时阻止发布；不允许在缺少基线配置时静默执行生产构建。
- 先校验 `.staging/` 再替换 `dist/`，替换失败自动恢复旧目录；中断后可从 `.dist-previous/` 恢复。上述目录都只用于本项目生成产物，禁止作为个人数据存储目录。不要手动删除暂存旧产物来绕过校验失败。
- 统一模块分段校验，支持仅含 Body/Header Rewrite 的合法模块，拒绝仅有 MITM 的空动作模块；增加模块、图标、前端内容哈希及路径检查，保留 `404.html` 检查。新增 `module_sha256` / `icon_sha256` 是目录的向后兼容字段，不改变模块订阅路径。
- 下载只接受无凭据 HTTPS，拒绝重定向和超限流；上游脚本本体仍不下载、不执行。源抓取或转换失败原因写入构建日志，图标缺失不影响模块转换。
- 修复非法端口范围、错误源 IP/CIDR 及数值溢出，保留官方支持的端口比较表达式。语法参考：[Surge 源地址与端口规则](https://manual.nssurge.com/rules/source-and-port.html)。
- 模块注释补回原作者署名；页面视觉设计保持。修复复制失败仍提示成功、无图标时请求 `/null`、详情弹窗缺少可访问标题。
- 70 项测试通过，含真实同步脚本的断网、源目录减少、转换结果减少、基线缺失、产物损坏和目录切换失败测试。按生产基线完整构建通过：136 个源插件、134 个模块、134 个图标。134 个模块订阅路径全部保留，首次优化构建中除补回作者注释外与优化前逐字节一致；后续同时纠正未转换 General 配置的注释说明。另 2 项因转换器尚未覆盖对应 DNS/IP 设置而继续跳过，不代表 Surge 模块不支持这些段。
- 本轮验证不等于手机 Surge 导入和第三方脚本运行实测；原有版本限制、未等价转换说明及外部脚本兼容性仍适用。未新增依赖、CF 项目、数据库或 VPS 服务。

转换范围说明参考 [Surge 官方模块文档](https://manual.nssurge.com/profile/module.html)：模块支持部分 General / Host / IP Rewrite 设置；本转换器当前仅以注释保留这些上游设置，未实现等价处理前不自动启用。

## 六、界面维护（2026-11-02）

- 按已确认效果图，浅色纯文字品牌、左侧用途分类、右侧双列开放列表；1180px以下列表单列，860px以下分类改为手机原生下拉，640px以下操作放在每行文字下方。
- 每页8个模块，分类/搜索/排序改变时返回第1页。两个会员标签仅在展示层合并为“会员相关”，保留原始标签和模块内容。分类按钮、手机选择和上下方向键/Home/End同步。
- 右上角改为“关于”，使用与YanyuRule截图一致的紧凑居中弹窗：YanyuAd、Surge模块目录、YANYU署名、指定Telegram按钮和网站设计版权。第三方许可保留在原licenses.html中，通过关于弹窗的文字入口访问；作者注释及UPSTREAM.txt不删除。
- 同步时间完整年份与北京时间放title提示，status.json明确标记scheduler_enabled=true才显示“每日同步”；状态文件失败不阻断模块目录。
- 保留原有搜索、排序、复制、Surge安装与模块详情。保持静态站，无新依赖、VPS服务、CF项目或Functions。
- 当前78项测试通过，包括分页、类别去重、桌面/手机筛选、搜索与排序重置、复制安装链接、关于弹窗开关、状态获取失败和文本注入回归。内置浏览器连接不可用，未声明完成真实浏览器截图/手机触控验收。
