# OpenCode Sailing3D 模型发现插件

一个 OpenCode v2 插件：从 Sailing3D New API 网关发现模型 ID，并用 OpenCode 已缓存的
[models.dev](https://models.dev) 快照补充上下文长度、模态、价格和 family 等元数据。
插件不依赖 LLM，也不会修改 OpenCode 配置文件。

## 环境要求

- OpenCode v2.0.14 或更高
- 本地校验需要 Node.js 22+
- OpenCode 服务器进程可用的 Sailing3D API Key，来源二选一：
  - 环境变量 `SAILING3D_API_KEY`
  - 通过 `/connect` 保存的 **Sailing3D Gateway** 账号

## 安装

```sh
opencode plugin add github:sailing3d/opencode-sailing3d-model-discovery
opencode plugin list
```

## 凭据

插件按以下顺序解析用于「模型发现」的 key：

1. OpenCode 服务器环境里的 `SAILING3D_API_KEY`（优先）。
2. provider 配置里直接写的 `apiKey`。
3. 通过 `/connect` 为 **Sailing3D Gateway** 保存的凭据。

都取不到时插件不会失败：会沿用缓存里上一次成功的模型清单，并提示如何连接。

插件用 `@opencode/ai/providers/openai-compatible` 注册 `sailing3d` provider，并把它的
`integrationID` 绑定到 `sailing3d`，因此由 `/connect` 管理保存的账号。密钥不会写入配置；
provider 设置里保留 `{env:SAILING3D_API_KEY}` 占位符。

## 工作原理

启动时插件请求网关的模型列表，并读取 OpenCode 缓存的 models.dev 快照
（`~/.cache/opencode/models.json`；兼容 `$XDG_CACHE_HOME` 与 `%USERPROFILE%`），然后合并进
`sailing3d` provider。它每 6 小时刷新一次，并在每次刷新以及 OpenCode 发布
`models-dev.refreshed` 事件后立即重读缓存；若后续刷新失败则保留上一次成功的清单。

该缓存由 OpenCode 自行维护。`catalogFallback` **默认开启**：插件只在缓存缺失、过期、或缺少
某个已发现模型的元数据时，才去请求 `https://models.dev/api.json`；设
`catalogFallback: false` 可完全离线（此时退回 OpenCode 的文档默认值：tools 开启、text+image
输入、200k 上下文、32k 输出）。发现结果里没有、但配置中显式定义的模型会被保留。网关的模型
ID 就是 OpenCode 的模型 ID；一个小型显式别名表把网关名称映射到 models.dev 的 slug（例如
`k3-256k`）。

同一个模型在 models.dev 里可能来自不同 provider 且记录不同。插件对已知模型使用确定的
provider 优先级，并在记录冲突时告警。缺少元数据时使用 OpenCode 的文档默认假设，并记录这一事实。

## 选项

在 `opencode.json(c)` 中用对象形式传入选项：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:sailing3d/opencode-sailing3d-model-discovery",
      "options": {
        "refreshHours": 6,
        "catalog": true,
        "timeoutMs": 15000,
        "includeModels": ["^glm-"],
        "excludeModels": ["-preview$"],
        // 默认开启；设 false 可完全离线
        "catalogFallback": true
      }
    }
  ]
}
```

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseURL` | `string` | `https://ai-api.sailing3d.cn/v1` | 网关基础 URL。 |
| `gatewayURL` | `string` | `${baseURL}/models` | 完整的网关模型列表端点。 |
| `catalogFile` | `string` | `~/.cache/opencode/models.json` | OpenCode 的 models.dev 缓存路径。 |
| `catalogFallback` | `boolean \| string` | `true` | 缓存缺失、过期或不完整时请求 models.dev（默认开启）。设 `false` 则仅用缓存、完全离线；字符串可指定自定义 URL。 |
| `catalogMaxAgeMs` | `number` | `86400000` | 超过该缓存年龄后才会启用 `catalogFallback`。 |
| `refreshMs` | `number` | `21600000` | 刷新间隔（毫秒）。 |
| `refreshHours` | `number` | `6` | 刷新间隔（小时）。 |
| `timeoutMs` | `number` | `15000` | 单次请求超时。 |
| `catalog` | `boolean` | `true` | 设为 `false` 可跳过 models.dev 元数据补充。 |
| `includeModels` | `string[]` | `[]` | 只保留匹配任一正则的模型 id。 |
| `excludeModels` | `string[]` | `[]` | 丢弃匹配任一正则的模型 id。 |

## 开发校验

```sh
npm ci
npm run check
npm test
```

冒烟测试使用固定 fixture，不会请求网关。插件只在服务器环境或 OpenCode 凭据存储中读取凭据，
从不打印或持久化它。

### 本地测试

OpenCode 不会为「裸本地目录」加载的插件注入 `@opencode/plugin`，因此本地检出必须作为包安装：

```sh
opencode plugin add "git+file:///absolute/path/to/opencode-sailing3d-model-discovery"
opencode reload
```
