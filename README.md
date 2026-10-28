# dsh-qq-session-bridge

将 QQ 私聊和群聊接入 DeepSeek Harness（DSH）原生会话的 DSHA 插件。每个私聊或群对应独立的 DSH 会话和工作区；模型、会话历史、记忆及工具由 DSH 和已安装的插件管理。

本版本仍在开发和验证中：已在 DSHA 设备安装并确认桥接 API 注册，但手机面板、真实 QQ 收发及完整功能尚未验收。开发机检查与隔离运行时测试不代表目标设备已验证。

## 安装

在 DSHA 的插件页面选择“从链接安装”，输入 `https://github.com/Firefly1007/dsh-qq-session-bridge` 并按界面提示安装，然后重启 Web。也可导入自行构建的插件包。首次启动时插件会下载 QQ 和 NapCat，需保持网络可用。

安装完成后，在插件设置中配置 QQ 连接和所需语音服务。

## 功能

- 自动准备并管理 Linux arm64 QQ、NapCat 和 OneBot；支持正向 WebSocket 与 webhook 接收。
- 每个 QQ 会话映射到 DSH 原生会话，群内通过 @ 或回复触发；可设置用户、群和超级管理员名单。
- `/new` 使用 DSH 原生上下文压缩，`/stop` 请求停止当前任务；运行中的补充消息使用原生引导。
- bot 模式限制主 Agent 的本地能力；可由可信的管理员消息授权委派子 Agent。
- 提供 QQ 文字、语音、文件发送和本轮 QQ 文件附件读取工具；语音使用火山引擎豆包 API。
- 私聊可主动发言，也可以指定允许主动发言的群；保留空闲冷却和告别暂停。

设置页提供默认模型、允许名单、语音及连接设置。QQ 登录在手机浏览器中打开 NapCat WebUI 扫码。新会话使用所选默认模型，已有会话沿用 DSH 当前模型。

## 数据与配置

新版数据保存在 `$DSH_HOME/qq-session-bridge`；未设置 `DSH_HOME` 时保存在 `~/.dsh/qq-session-bridge`。QQ 工作区位于 DSH 默认工作区旁的 `QQ` 目录，按私聊或群聊隔离。新版使用独立配置和数据，不读取或迁移旧版插件配置、密钥或会话。

豆包 API Key 在插件设置页填写，语音识别需开通 `volc.seedasr.auc`。OneBot access token 与 NapCat WebUI 管理 Token 用于不同用途。请勿将密钥写入仓库或聊天记录。

## 开发与验证

主要入口为 `lib/index-native.js` 和 `lib/client-native.js`；`cordis.patch.yml` 注册的插件 ID 为 `dsh-qq-session-bridge`。运行 `node --test tests/*.test.js` 可执行本地测试；平台专属检查应在 Linux 和目标 DSHA 设备分别验证。`npm run pack:dsha` 构建本地安装包，打包前需准备 `vendor/runtime/packages.json` 指定的系统依赖。

## 来源和许可

本项目从此前的 [Firefly1007/dsh-napcat-bot-linux](https://github.com/Firefly1007/dsh-napcat-bot-linux) DSHA 移植继续开发。该移植的上游是 [9178159/dsh-napcat-bot](https://github.com/9178159/dsh-napcat-bot/tree/26d747f22eb4e16905b806a6bb3f23a791fed09b)，固定基线为 2.8.0、提交 `26d747f22eb4e16905b806a6bb3f23a791fed09b`。项目保留上游 MIT 许可；NapCat、QQ 和豆包客户端等第三方资产分别遵循各自许可。
