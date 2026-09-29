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

插件不从环境变量读取任何**凭据**（`OPENCODE_MODELS_PATH` / `XDG_CACHE_HOME` 仍会影响缓存路径，
见「工作原理」）。

## 安装

```sh
# 安装
opencode plugin add github:sailing3d/opencode-sailing3d-model-discovery
# 查看已安装的插件
opencode plugin list
# 更新到最新版本（改完插件后也用它生效）
opencode plugin update github:sailing3d/opencode-sailing3d-model-discovery
# 只改了配置没改插件时用这个
opencode reload
```

## 首次使用

装完插件**还不会有模型**——没有凭据时插件刻意不注册 provider（见「凭据」）。顺序是：

1. `opencode plugin add ...` 安装插件；
2. TUI 里 `/connect` → 选择 **Sailing3D Gateway** → 粘贴 key，
   或命令行 `opencode auth login sailing3d --method key`；
3. 模型选择器立刻出现 `sailing3d/...`，**不需要重启**（凭据事件触发重新发现）。

反过来，注销凭据后模型也会立即消失，这是预期行为而不是 bug。

## 手动刷新

除了自动触发（启动、凭据变更、每 6 小时），可以随时在 TUI 里跑一条斜杠命令：

```
/sailing3d-refresh
```

它立即重新请求网关的 `/v1/models`、重新发布 `sailing3d` provider，然后在会话里回一行结果：

```
[sailing3d-model-sync] refreshed 8 models from https://ai-api.sailing3d.cn/v1/models
```

- 凭据已失效时它同样执行清理，回一行 `no credential for Sailing3D Gateway; removed the provider…`。
- 发现请求失败时保留上一次的清单，并回 `refresh failed (…); kept the previous N models`。
- 它只跑一次发现，**不重新加载插件**，所以比 `opencode reload` / 重启 App 轻得多。

等价但更重的命令行方式是 `opencode reload`：它会重新执行所有插件的 `setup`（其中包含一次发现）。

## 凭据

插件按以下顺序解析用于「模型发现」的 key：

1. provider 配置里直接写的 `apiKey`（不是 `{env:...}` 占位符）。
2. 通过 `/connect` 为 **Sailing3D Gateway** 保存的凭据。

插件**不从环境变量读取凭据**：`SAILING3D_API_KEY` 既不是凭据来源，也不会被注册成 integration 的
`env` 方法，因此 `opencode auth list` 里不会再出现这一行。

两者都取不到时，插件不会再用旧清单兜底，而是**删除 `sailing3d` provider 并清空缓存的模型清单**，
模型选择器里的 Sailing3D 模型随之消失。之后用 `/connect` 连上（或写显式 `apiKey`）即可恢复，
不需要重启：插件监听凭据变更事件并立即重新发现。

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

### 从 0.3 升级

0.4 移除了环境变量支持，行为有几处变化：

| 0.3 | 0.4 |
| --- | --- |
| 优先读服务器进程里的 `SAILING3D_API_KEY` | **完全忽略**，即使变量仍然设置着 |
| 注册 `env` 方法，`auth list` 显示 `Sailing3D Gateway / SAILING3D_API_KEY / environment` | 只注册 `key` 方法，且启动时注销 0.3 遗留的 `env` 方法 |
| 配置里 `"providers": { "sailing3d": { "env": ["SAILING3D_API_KEY"] } }` 可配合环境变量使用 | 该写法不再参与模型发现，建议删掉并改用 `/connect` |
| 没有凭据时沿用上一次的缓存清单 | 没有凭据时**删除 provider 并清空缓存**，模型立即消失 |
| 凭据变化要等下次启动 / 6 小时刷新 | 监听 `credential.updated` 等事件，立刻生效 |

升级后建议检查一次：`opencode auth list` 里 Sailing3D Gateway 应显示 `stored`，
且没有以 `environment` 结尾的行。

## 工作原理

启动时插件请求网关的模型列表，并读取 OpenCode 缓存的 models.dev 快照
（`~/.cache/opencode/models.json`；兼容 `$XDG_CACHE_HOME` 与 `%USERPROFILE%`），然后合并进
`sailing3d` provider。它每 6 小时刷新一次，并在这几类事件后立即刷新：`models-dev.refreshed`
（重读缓存）、`credential.updated` / `credential.switched` / `integration.updated`；另外还有一条
手动入口 `/sailing3d-refresh`（见「手动刷新」）。定时刷新与事件触发都走同一个 `refresh()`，
启动时的 `setup` 用的是同一套发现逻辑。

最后这组凭据事件很关键：OpenCode 不会因为新连接而重新执行插件 `setup`，也不会像内置 provider
那样把插件发现的模型按凭据可用性自动挂载/卸载。所以 `/connect` 一个 Sailing3D key 之后，是这些
事件触发 `refresh()`，模型才会立即出现（而不是等到下次启动或 6 小时后）；注销时同理，会立即摘掉
provider 与模型。

「上一次成功的清单」只在**凭据仍然可用、但某次发现请求失败**时作为兜底。凭据本身消失时
（注销 `/connect` 且没有显式 `apiKey`），插件会**立刻**删除 `sailing3d` provider 并清空缓存清单
——在启动、`opencode reload`、凭据事件触发的刷新这三条路径上都成立。

模型清单的缓存路径按顺序取：`catalogFile` 选项 → `OPENCODE_MODELS_PATH` →
`~/.cache/opencode/models.json` → 该目录下最新的 `models*.json`。

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

## 排查

插件只打印带 `[sailing3d-model-sync]` 前缀的诊断信息，走的是 OpenCode server 的 stdout——
`opencode.log` 里未必能看到（那个文件主要是 server 自身的日志）。所以更可靠的做法是直接看
下面这些可观测事实：

| 现象 | 检查 / 结论 |
| --- | --- |
| 模型选择器里没有 `sailing3d/...` | ① `opencode plugin list` 确认插件已加载；② `opencode auth list` 应有 `Sailing3D Gateway … stored`——没有就是还没 `/connect`，连上后应立即出现，不用重启 |
| `auth list` 里出现以 `environment` 结尾的 Sailing3D 行 | 要么插件还是 0.3（`opencode plugin update`），要么配置里仍写着 `providers.sailing3d.env`——0.4 已不参与模型发现，建议删掉 |
| 改了配置没生效 | 只改配置 → `opencode reload`；改了插件 → `opencode plugin update` |
| 想立刻重新拉取模型清单 | TUI 里跑 `/sailing3d-refresh`（只做一次发现，不重载插件） |
| 上下文长度 / 价格是默认值 | `~/.cache/opencode/models.json` 的 mtime 超过 24 小时即过期，`catalogFallback`（默认开启）会请求 models.dev；离线时设 `catalogFallback: false` 并接受默认值 |
| 某个模型调用报 `model id does not exist` | 网关自身不一致：`/v1/models` 给出 `kimi-k3-256k`，聊天接口却要求 `k3`。插件原样透传 ID、不做猜测，属网关侧问题 |

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

改完代码用 `opencode reload` 重载即可（OpenCode 会监测插件文件变更并重新加载模块）；依赖或版本
有变动时再跑一次 `opencode plugin update "git+file:///…"` 重新安装。`opencode plugin list` 可以确认
生效的来源——注意它的 `VERSION` 列显示的是**已安装的 git 提交**（例如 `9c64cad`），包的语义版本
（当前 0.4.x）写在 `package.json` 里。
