# YanyuAd

Loon 插件 → Surge 模块的转换与订阅目录，静态站点，无 VPS、无数据库。

- 正式地址：https://ad.fakeyou.eu.org/（部署后启用）
- 数据来源：[Loon 插件仓库](https://loonlab.103516.xyz/Plugin/)（LoonLab，CC BY-NC-SA 4.0）
- 托管：GitHub 私有仓库 ＋ Cloudflare Pages
- 同步：北京时间 10:23 每日尝试，失败保留上一成功部署

## 重要限制

| 项 | 说明 |
|---|---|
| 转换 ≠ 可用 | `converted` 只表示配置语法在支持范围内转换成功，**没有在 Surge 实测功能** |
| 无法等价转换 | 含参数、新版 body/header 改写、cron/generic 任务等，明确标为“暂不支持”，不静默丢功能 |
| 脚本 | 保留原作者脚本地址，不下载执行；脚本是否兼容 Surge 需人工核对 |
| MITM | 涉及 HTTPS 解密需用户自备证书；模块使用 `%APPEND%`，不覆盖本地配置 |
| 版权 | 派生材料遵循 CC BY-NC-SA 4.0，仅非商业；原作者署名与来源保留在页面与模块注释 |

## 目录

| 路径 | 作用 |
|---|---|
| `public/` | 静态页面源码（index、style、app、sources、图标、`_headers`） |
| `public/licenses/LOONLAB.txt` | 来源仓库许可文本 |
| `scripts/convert.mjs` | 纯离线、失败即拒绝的 LPX→sgmodule 转换器 |
| `scripts/sync.mjs` | 抓取目录与插件、转换、生成 `dist/` |
| `scripts/check.mjs` | 产物完整性、计数、模块一致性校验 |
| `scripts/wait-for-deployment.mjs` | 部署后线上 `status.json` 校验 |
| `tests/convert.test.mjs` | 转换器单元测试 |

## 构建

```sh
npm test
node scripts/sync.mjs          # 本地构建，输出 dist/
node scripts/check.mjs
```

生产构建（Cloudflare Pages 使用）：

```sh
node --test tests/*.test.mjs && node scripts/sync.mjs --production && node scripts/check.mjs
```

## 部署

1. Cloudflare Pages 连接本仓库，生产分支 `main`，框架“无”，根目录 `/`，输出目录 `dist`，Node 22。
2. 环境变量：

   | 变量 | 值 |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `YANYUAD_BASELINE_URL` | `https://yanyuad.pages.dev/status.json` |
   | `YANYUAD_INITIAL_BUILD` | 正常 `0`；仅首次部署临时 `1`，成功后改回 `0` 并重建验证 |
   | `YANYUAD_SCHEDULER_ENABLED` | 定时链路验证通过后设 `true` |

3. 自定义域名 `ad.fakeyou.eu.org`，DNS CNAME 指向 `yanyuad.pages.dev`，不修改其他记录。
4. 仓库 Actions 变量：`YANYUAD_PUBLIC_BASE_URL=https://ad.fakeyou.eu.org`、`YANYUAD_ENABLED=true`。
5. 手动运行一次 `YanyuAd daily sync`，确认线上 `status.json` 的 `request_id` 与本次一致。

## 转换器支持范围

支持：基础规则（DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、IP-CIDR、IP-CIDR6、GEOIP）、旧式 URL rewrite、`reject*` 系列（映射 Map Local）、新版 request `reject*`/`redirect`、HTTP request/response 脚本声明、MITM 追加。

拒绝：`[Argument]`、脚本参数、`response.json.*`、body/header 改写、cron/generic/network-changed、外部策略与规则集、混淆的跨引擎正则、平台版本约束。

## 卸载

Cloudflare 删除 Pages 项目与 `ad` 解析；GitHub 删除仓库。来源站与本项目互相独立，删除本项目不影响上游。
