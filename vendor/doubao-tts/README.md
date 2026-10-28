# 豆包语音官方脚本与依赖

直接复用 [字节跳动 agentkit-samples 的语音合成脚本](https://github.com/bytedance/agentkit-samples/tree/33fbf1f0c30eb351608f64f95cafb0dda627eb31/skills/byted-text-to-speech)，
固定提交见 `UPSTREAM.json`。官方版权与 Apache-2.0 许可证保留在脚本头、`LICENSE` 和 `NOTICE`。

`scripts/text_to_speech.py` 使用用户指定的官方 V3 HTTP Chunked 接口、`X-Api-Key` 鉴权和 `httpx`：
`https://openspeech.bytedance.com/api/v3/tts/unidirectional`。
在官方脚本上仅修改端点及逐行 JSON 解析，并补充 JSON/base64 及音频大小校验；
修改声明已写入脚本与来源文件。请求、认证头、httpx 流式传输和逐片音频解码继续使用官方实现。
按接口文档处理 `code=0` 音频响应，也兼容详细文档中的 `code=20000000` 结束包；
完整读取 HTTP 响应后才输出音频，传输中断由 httpx 报错处理，不返回已经收到的残缺片段。

需要 guest 提供 **Python 3.10 或更新版本**。`python/` 随包包含所需的 7 个纯 Python 包，
不需要全局 pip、在线安装或 arm64 编译：`httpx`、`httpcore`、`h11`、`anyio`、
`certifi`、`idna`、`typing_extensions`。
精确版本、wheel 来源及 SHA256 见 `python-dependencies.json`；
各包的完整许可位于相应 `*.dist-info/licenses/`，分发时保留这些文件。

Node 适配层只管理子进程、30 秒超时中止、取消与临时 MP3 文件：

- API Key 只写入该子进程的 `MODEL_SPEECH_API_KEY` 环境，未放入命令行或临时文件。
- 固定官方域名，隔离 `PYTHONPATH`，清空通用脚本的其他宿主鉴权入口；不自动创建密钥。
- 配置使用 `ttsDoubaoApiKey` / `ttsDoubaoResourceId`，音色复用 `ttsVoice` / `ttsVoicePool`。
  默认资源为 `seed-tts-2.0`，音色必须与资源对应，且已由账号开通授权。
- 返回音频仍转为 base64 交给既有 NapCat `record` 发送链路；失败只降级为文字，临时文件随即清理。
- 禁用插件时调用 `tts.dispose()`，中止本实例的进行中请求并禁止再次启动。
  超时或取消先发出终止信号，收到进程 `close` 后才结束请求与删除临时文件；
  若系统拒绝终止，则保留临时目录等待进程实际退出，不提前删除仍可能写入的文件。

官方接口与音色依据：
[V3 HTTP/SSE 文档](https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3?lang=zh)、
[语音 API Key](https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=en)、
[音色列表](https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh)。

复用选型：检查的官方 `@volcengine/openapi@1.36.2` 为 AK/SK 管理面 SDK，未提供本接口；
社区 `volcengine-tts@1.0.10` 仍使用 V1 WebSocket。这里采用有明确官方来源的 Python 实现，
没有自行实现 HTTP 客户端。

验证入口：`node --test tests/tts-volcengine.test.js`；
`python3 -B tests/tts-volcengine-script.test.py`（测试自动加载随包依赖，使用本地 MockTransport，不请求云端）。
尚未使用真实 API Key 验证账号授权、云端合成音质或 NapCat 真正发送。
