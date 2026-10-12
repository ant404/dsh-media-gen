# dsh-media-gen

在 DSH 会话中生成**图片**和**视频**的插件，全部走 **OpenAI 兼容接口**（`/images/generations`、`/images/edits`、`/videos/generations` 或 `/videos`），并复用 DSH 模型设置里已经配置好的 Provider / 模型 / API Key。

- 设置页**单独开一个「媒体生成」菜单**，分别配置：
  - 文生图模型（text-to-image）
  - 图生图模型（image-to-image / edit）
  - 视频生成模型（video）
  - 输出目录（默认 `media_gen`，相对路径基于当前工作区；也支持绝对路径）
- 生成的图片/视频**保存到磁盘**（默认 `<当前工作区>\media_gen`），同时在会话里返回内联预览/播放链接。
- Provider 直接从 DSH 的 `settings.yaml → llm-pi-ai.providers` 读取，与聊天模型共用同一套 baseURL / apiKeyEnv；浏览器永远接触不到 API Key。

## 安装

```sh
# 非桌面 profile：从 GitHub 安装
dsh plugin --profile web add github:ant404/dsh-media-gen

# 或本地目录安装（开发时）
dsh plugin --profile web add "D:/sysdir/Documents/deepseek-harness-workspace/dsh-media-gen"
```

桌面版（Electron）的 profile 由应用独占管理，`dsh plugin` 会拒绝写入（`profile "desktop" is managed exclusively by the Electron application`）。两种可行做法：

1. **应用内安装**：设置 → 插件页安装本地目录（走 `plugin_manager` 的 `install_bundle`）。
2. **手动等价步骤**：在 profile 的 `package.json` 里加依赖与 bundle 行，再装链接：

   ```jsonc
   // profiles/<name>/package.json
   "dependencies": {
     "dsh-media-gen": "link:D:/sysdir/Documents/deepseek-harness-workspace/dsh-media-gen"
   },
   "dsh": { "profile": { "bundles": [ /* … */ "dsh-media-gen" ] } }
   ```

   ```sh
   pnpm install --prefer-offline    # 在 profile 目录内执行，建立 node_modules 链接
   ```

安装后重启 DSH（HMR 只重组合已加载的 bundle，不会加载新包），进入 **设置 → 媒体生成**，为三种生成分别选择 Provider 和 Model，然后保存。

## 使用

在会话中直接说：

```text
生成一张 16:9 的雪山日出
```

```text
把这张图变成水彩画风格：C:\path\to\input.png
```

```text
生成一段 5 秒的赛博朋克城市夜景视频
```

插件提供的工具：

| 工具 | 说明 |
| --- | --- |
| `media_list_providers` | 列出 DSH 中可用的 OpenAI 兼容 Provider 及其模型 |
| `media_gen_image` | 文生图（`/images/generations`） |
| `media_edit_image` | 图生图/图片编辑（`/images/edits`，传本地路径或 http(s) URL） |
| `media_gen_video` | 视频生成（`/videos` 或 `/videos/generations`，自动轮询异步任务）；结果在聊天中以内嵌 `<video>` 播放，带下载链接 |

所有媒体生成工具**严格使用「设置 → 媒体生成」里配置的 Provider / Model**，不支持在工具调用里临时换模型；要换模型请到设置菜单修改。

## 图片交互

- 生成的图片在会话里以**小图**显示（最大约 280px），由 DSH 聊天自身的图片组件渲染。
- **左键点击图片**：DSH 原生的「查看大图」预览（点背景或按 `Esc` 关闭）。
- **右键点击图片**：弹出「引用」菜单；点击后会把该图片的**本地文件路径**插入到对话输入框，方便接着做图生图/图生视频。

> 图片在回复正文里以**工作区相对路径**书写（`![…](media_gen/xxx.png)`）。桌面版页面运行在 `dsh-app://app/` 协议下，聊天会把该路径解析为工作区文件并改写成同源的 `api/file?path=…` 路由；写成 `http://127.0.0.1:…/media-gen/raw/…` 属于跨源图片，会被拦截并显示「图片无法预览」。

## 配置项（也可写在 profile 的 cordis.patch.yml）

```yaml
- id: dsh-media-gen
  config:
    # 输出目录已固定为 <当前工作区>/media_gen，该配置项不再生效
    outputDir: media_gen
    imageProvider: agnes-ai
    imageModel: agnes-image-2.1-flash
    imageEditProvider: agnes-ai
    imageEditModel: agnes-image-2.1-flash
    videoProvider: agnes-ai
    videoModel: agnes-video-v2.0
    videoEndpoint: ''             # 留空自动 /videos/generations → /videos
    timeoutMs: 120000
    videoTimeoutMs: 600000
```

> Provider / Model 也可以直接在「设置 → 媒体生成」界面里选并保存，会写入当前 profile 的配置补丁，**热生效、无需重启**。

## 实现要点（面向 DSH 0.2.x）

| 环节 | 做法 |
| --- | --- |
| 可编辑字段 | Config 里标 `.volatile()`；运行时通过 `config.x.get()` 读实时值，保存后无需重载插件 |
| 设置页 | 插件自带页面（`client.js` + `/media-gen/*` 路由），用 `settings.configure({ auto: false })` 关掉 DSH 自动生成的表单 |
| 保存配置 | `configEditor.edit(entry, …)`：校验整份候选、保留 YAML 注释与 `!!js` 表达式、写入 profile 补丁并重新组合 |
| Provider 来源 | `configEditor.entries()` 找组合中的 `llm-pi-ai` 条目，读它的 `providers` |
| 凭据 | `ctx.credentials.resolve(apiKeyEnv)`，API Key 永不进入浏览器 |
| 图片显示 | 回复正文写工作区相对路径，交给 DSH 的图片组件与预览 |
| 视频显示 | 工具结果回传 `{"type":"video","src":…}`，由插件客户端把它替换成 `<video>` 播放器 |

## 视频接口兼容说明

OpenAI 官方与各家网关的视频接口并不完全统一。插件默认先请求 `POST {base}/videos`，404/405 再试 `POST {base}/videos/generations`；如果返回的是异步任务（`id` + `status`），会自动轮询 `/videos/{id}`、`/videos/generations/{id}`，以及 Agnes 风格 `agnesapi?video_id=`，直到完成。结果 URL 支持 `metadata.url` 等嵌套字段；若你的网关使用其他路径，可在设置里填 `videoEndpoint`。

## 安全说明

- `/media-gen/raw/*` 与配置接口都只允许 loopback（127.0.0.1/localhost）访问。
- 不在浏览器中输出 API Key；只回传 `hasKey` 布尔值。
- 原始文件保存在你配置的输出目录；插件会维护持久索引（`~/.dsh/storages/dsh-media-gen-index.json`），**重启后历史会话里的图片/视频链接仍可访问**。

## License

MIT