# OpenCode Sailing3D 模型发现插件

一个 OpenCode v2 插件：从 Sailing3D New API 网关发现模型 ID，并用 OpenCode 已缓存的
[models.dev](https://models.dev) 快照补充上下文长度、模态、价格和 family 等元数据。
插件不依赖 LLM，也不会修改 OpenCode 配置文件。

## 环境要求

- OpenCode v2.0.14 或更高
- 本地校验需要 Node.js 22+
- Sailing3D API Key，来源二选一：
  - 通过 `/connect` 保存的 **Sailing3D Gateway** 账号（推荐）
  - provider 配置里显式写的 `apiKey`

插件不读取任何环境变量（见下方「凭据」）。

## 安装

```sh
opencode plugin add github:sailing3d/opencode-sailing3d-model-discovery
opencode plugin list
```

## 凭据

插件按以下顺序解析用于「模型发现」的 key：

1. provider 配置里直接写的 `apiKey`（不是 `{env:...}` 占位符）。
2. 通过 `/connect` 为 **Sailing3D Gateway** 保存的凭据。

插件**不读取环境变量**：`SAILING3D_API_KEY` 既不是凭据来源，也不会被注册成 integration 的
`env` 方法，因此 `opencode auth list` 里不会再出现这一行。

两者都取不到时，插件不会再用旧清单兜底，而是**删除 `sailing3d` provider 并清空缓存的模型清单**，
模型选择器里的 Sailing3D 模型随之消失。之后用 `/connect` 连上（或写显式 `apiKey`）并运行
`opencode reload` 即可恢复。

### `/connect` 与 integration 注册

插件用 `@opencode/ai/providers/openai-compatible` 注册 `sailing3d` provider。OpenCode 只按
provider 的 `integrationID` **引用**凭据来源，integration 本身不会自动存在，所以插件在启动时用
`ctx.integration.transform` 注册 `sailing3d`（显示名 **Sailing3D Gateway**），只声明一种方法：

- `key`：在 TUI 里 `/connect` → 选择 **Sailing3D Gateway** 并粘贴密钥；也可用
  `opencode auth login sailing3d --method key`。凭据由 OpenCode 存进凭据库（SQLite），不写进配置。

启动时插件还会调用 `method.remove` 注销 0.3.0 遗留的 `env` 方法，避免残留的环境变量在
`opencode auth list` 里显示成一个连接。

注册是运行期行为，每次启动重新注册，不会改写配置文件。

provider 设置里保留 `{env:SAILING3D_API_KEY}` 占位符：OpenCode 不会对插件注入的 provider 设置做
`{env:...}` 替换，真实认证来自上面的 integration。若不想使用 `/connect`，可以在配置里显式提供：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "sailing3d": { "settings": { "apiKey": "sk-..." } }
  }
}
```

## 工作原理

启动时插件请求网关的模型列表，并读取 OpenCode 缓存的 models.dev 快照
（`~/.cache/opencode/models.json`；兼容 `$XDG_CACHE_HOME` 与 `%USERPROFILE%`），然后合并进
`sailing3d` provider。它每 6 小时刷新一次，并在每次刷新以及 OpenCode 发布
`models-dev.refreshed` 事件后立即重读缓存。

「上一次成功的清单」只在**凭据仍然可用、但某次发现请求失败**时作为兜底。凭据本身消失时
（注销 `/connect` 且没有显式 `apiKey`），插件会在启动、`opencode reload` 或下一次刷新时
删除 `sailing3d` provider 并清空缓存清单。

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

冒烟测试使用固定 fixture，不会请求网关。插件只从 OpenCode 凭据存储或显式 provider 配置读取
凭据，从不打印或持久化它。

### 本地测试

OpenCode 不会为「裸本地目录」加载的插件注入 `@opencode/plugin`，因此本地检出必须作为包安装：

```sh
opencode plugin add "git+file:///absolute/path/to/opencode-sailing3d-model-discovery"
opencode reload
```
