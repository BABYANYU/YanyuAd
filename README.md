# YANYU AD

YANYU AD 将公开插件配置整理为 Surge 模块目录，提供浏览、筛选、搜索和一键安装；目录由静态网站发布并按日同步。

目录：[ad.fakeyou.eu.org](https://ad.fakeyou.eu.org/)

## 安装与订阅

1. 在 Surge 模块目录中按用途浏览，或搜索模块名称与描述。
2. 选择所需模块并点击“安装”，在 Surge 中确认添加。
3. 也可点击“复制链接”，再将模块 URL 添加到 Surge 的模块配置中。
4. 按模块注释配置参数；需要 HTTPS 解密的功能，请在 Surge 中配置 MITM 证书并覆盖相应域名。

模块是独立订阅项；更新由目录重新生成，之后在 Surge 中更新对应模块即可。

## 支持范围

转换器目前覆盖常见规则（域名、IP、UA、URL 正则及 AND／OR／NOT 组合）、URL 重写与重定向、请求／响应脚本声明、JSON jq 与正文改写、响应模拟、响应头改写、模块参数，以及以 `%APPEND%` 追加的 MITM 主机名。具体模块以转换结果和模块内说明为准，转换结果不等同于在 Surge 中的功能实测。

以下内容不会被擅自转换或启用：

- 转换器尚未实现等价处理的 DNS、Host、IP 回环等配置；
- 来源配置内停用的动作保持停用；
- 脚本本体。目录仅保留脚本地址，不下载、执行或改写脚本。

## 客户端版本

| 功能 | 最低 Surge 版本 |
|---|---|
| Map Local | iOS 5.9.1；macOS 5.5.1 |
| Body Rewrite | iOS 5.10.0；macOS 5.6.0 |
| jq Body Rewrite | iOS 5.14.0；macOS 5.9.0 |
| Header Rewrite | 上游未标注最低版本，旧版可能无法识别 |

只需使用模块实际包含的功能满足对应版本要求；客户端和模块注释中的具体说明优先。

## 许可与来源

本仓库中的转换器和网站代码依根目录 [`LICENSE`](LICENSE) 采用 MIT License。目录模块由上游 LoonLab 公开插件配置转换生成，保留模块内来源、作者及许可说明；上游内容按 CC BY-NC-SA 4.0 提供，许可文本见 [`public/licenses/UPSTREAM.txt`](public/licenses/UPSTREAM.txt)，说明见[许可页](https://ad.fakeyou.eu.org/licenses.html)。两类许可适用对象不同。

## 构建

需要 Node.js 22 或更高版本。无需额外运行时依赖；同步目录需要访问上游数据源。

```sh
npm test
npm run sync
npm run check
```

`npm run build` 会依次执行测试、同步和产物校验，并将发布文件生成到 `dist/`。
