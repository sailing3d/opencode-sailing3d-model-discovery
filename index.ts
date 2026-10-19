import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Agent, Model, Plugin, Provider, Skill } from "@opencode/plugin"

const providerID = Provider.ID.make("sailing3d")
// Provider integrations are referenced by id, never created implicitly: a plugin
// must register the integration and its credential methods itself, otherwise
// /connect and `opencode auth login` report "Integration not found".
const integrationID = "sailing3d"
const integrationName = "Sailing3D Gateway"
// 0.3.0 also declared an `env` credential method for this variable and read the
// variable directly. 0.4.0 dropped both: discovery only accepts a `/connect`
// credential or an explicit provider `apiKey`, so an environment variable alone
// can no longer keep the provider alive. The name is kept so the legacy method
// can be unregistered at startup, and as the provider's inert settings placeholder.
const LEGACY_API_KEY_ENV = "SAILING3D_API_KEY"
const cacheKey = "sailing3d-model-inventory-v1"

// Dev-KB capabilities (`@kb-agent` subagent, `dev-kb` skill, and `/kb-*` slash
// commands) are only exposed when the authenticated user's `/v1/models` list
// includes `dev-kb` (gated by `dev-group` membership on the gateway).
const KB_MODEL_ID = "dev-kb"
const KB_AGENT_ID = "kb-agent"
const KB_SKILL_ID = "dev-kb"
const KB_SYNTHETIC_DESCRIPTION = "Sailing3D Dev-KB"

const KB_SKILL_CONTENT = [
  "# Sailing3D 研发知识库 (Dev-KB) 技能指南",
  "",
  "当前账号已具备 `dev-kb` 研发知识库访问权限。当对话涉及以下场景时，请优先委派给 `@kb-agent` 子智能体（`kb-agent`）或提示用户使用 `/kb-*` 斜杠命令：",
  "",
  "## 1. 适用场景",
  "- 查询团队内部研发规范、系统架构、部署配置或历史排障经验",
  "- 读取或更新当前开发者的个人研发偏好（代码风格、常用环境等）",
  "- 将当前会话产出的架构方案、排障记录或配置规范沉淀到团队知识库",
  "",
  "## 2. 子智能体 `@kb-agent` 调用指令格式",
  "向 `kb-agent` 发送单次请求即可直接返回知识库处理结果：",
  "",
  "| 操作意图 | 发送给 `kb-agent` 的消息格式 |",
  "| --- | --- |",
  "| 检索知识库问答 | 直接发送具体技术问题（或 `/kb-ask <问题>`） |",
  "| 查看使用指南 | `/kb-help` |",
  "| 查看身份与个人偏好 | `/kb-whoami` 或 `/kb-pref` |",
  "| 新增/更新个人偏好 | `/kb-pref <偏好内容>`（清空发送 `/kb-pref clear`） |",
  "| 查看知识库文档目录 | `/kb-status` |",
  "| 新增知识库文档 | `/kb-add [分类] # 标题\\n正文内容`（可选分类：`架构与设计`、`部署与运维`、`接口与协议`、`踩坑与排障`、`编码与规范`） |",
  "| 追加内容到已有文档 | `/kb-append <doc_id或标题>\\n追加正文` |",
  "| 覆盖修订已有文档 | `/kb-edit <doc_id或标题>\\n完整新正文` |",
  "| 删除知识库文档 | `/kb-del <doc_id或标题>` |",
  "| 查看近期变更记录 | `/kb-history` |",
].join("\n")

// OpenCode does not re-run plugin setup when a credential is added or removed,
// and it does not gate plugin-discovered models on credential availability the
// way it does for its built-in providers. Without reacting to these events a
// `/connect` (or a logout) would only take effect on the next start/reload or
// the periodic refresh. `credential.updated` carries no integration id, so every
// credential change re-checks the gateway.
const REFRESH_EVENTS = new Set(["credential.updated", "credential.switched", "integration.updated", "models-dev.refreshed"])

const DEFAULT_BASE_URL = "https://ai-api.sailing3d.cn/v1"
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_CATALOG_FALLBACK_URL = "https://models.dev/api.json"
const DEFAULT_CONTEXT = 200_000
const DEFAULT_OUTPUT = 32_000
const DEFAULT_INPUT = ["text", "image"]

type PluginOptions = {
  /** Gateway base URL. Discovery defaults to `${baseURL}/models`. */
  baseURL?: string
  /** Full gateway models endpoint. Overrides the value derived from `baseURL`. */
  gatewayURL?: string
  /** Explicit path to OpenCode's models.dev cache file. Defaults to `~/.cache/opencode/models.json`. */
  catalogFile?: string
  /** Refresh interval in milliseconds. */
  refreshMs?: number
  /** Refresh interval in hours (convenience alias for `refreshMs`). */
  refreshHours?: number
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Set to false to skip models.dev metadata enrichment. */
  catalog?: boolean
  /**
   * Network fallback for the models.dev catalog. Enabled by default using
   * `https://models.dev/api.json`; a string sets a custom URL. The URL is only
   * fetched when the cache is missing, older than `catalogMaxAgeMs`, or lacks
   * metadata for a discovered model. Set `false` to stay strictly cache-only.
   */
  catalogFallback?: string | boolean
  /** Cache age in milliseconds after which `catalogFallback` is consulted. */
  catalogMaxAgeMs?: number
  /** Only keep discovered model ids matching one of these regular expressions. */
  includeModels?: string[]
  /** Drop discovered model ids matching any of these regular expressions. */
  excludeModels?: string[]
  /**
   * Generate per-model `variants` from the models.dev `reasoning_options` of
   * each model (for example `low`, `high`, `max`). Enabled by default; set
   * `false` to leave the inventory without generated variants.
   */
  catalogVariants?: boolean
  /**
   * Only emit these reasoning-effort values, in this order (for example
   * `["none", "low", "high"]`). Values the catalog offers but this list does
   * not mention are dropped, which is useful when the gateway silently ignores
   * an effort level.
   */
  variantEfforts?: string[]
}

type CatalogModel = {
  id?: string
  name?: string
  family?: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  structured_output?: boolean
  temperature?: boolean
  interleaved?: boolean | { field?: string }
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; input?: number; output?: number }
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  release_date?: string
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

type InventoryRecord = {
  provider: string
  model: CatalogModel
}

type ModelListResponse = {
  data?: Array<{ id?: string }>
}

type CatalogResponse = Record<string, { models?: Record<string, CatalogModel> }>

type SerializedModel = ReturnType<typeof makeModel>

// Provider IDs are only used to resolve models.dev's duplicate provider
// records. Gateway IDs remain unchanged in OpenCode's Sailing3D inventory.
const aliases: Record<string, { catalogID: string; preferredProviders: string[] }> = {
  "deepseek-flash": { catalogID: "deepseek-flash", preferredProviders: ["deepseek"] },
  "deepseek-v4-flash": { catalogID: "deepseek-v4-flash", preferredProviders: ["deepseek"] },
  "deepseek-v4.1-flash": { catalogID: "deepseek-v4.1-flash", preferredProviders: ["deepseek", "opencode-go"] },
  "glm-5.3": { catalogID: "glm-5.3", preferredProviders: ["zhipuai", "zai", "opencode-go"] },
  "glm-5.3-flash": { catalogID: "glm-5.3-flash", preferredProviders: ["zhipuai", "zai", "opencode-go"] },
  "kimi-for-coding": { catalogID: "kimi-for-coding", preferredProviders: ["kimi-code-plan-global", "kimi-code-plan-cn"] },
  // models.dev uses k3-256k; the gateway may expose kimi-k3-256k.
  "kimi-k3-256k": { catalogID: "k3-256k", preferredProviders: ["kimi-code-plan-global", "kimi-code-plan-cn"] },
  "k3-256k": { catalogID: "k3-256k", preferredProviders: ["kimi-code-plan-global", "kimi-code-plan-cn"] },
  // models.dev also exposes the 1M-context k3. Aliases cover the gateway's
  // kimi-prefixed names, so a rename to either form keeps resolving.
  "k3": { catalogID: "k3", preferredProviders: ["kimi-code-plan-global", "kimi-code-plan-cn"] },
  "kimi-k3": { catalogID: "k3", preferredProviders: ["kimi-code-plan-global", "kimi-code-plan-cn"] },
  "openai/gpt-6-luna": { catalogID: "openai/gpt-6-luna", preferredProviders: ["openrouter", "nano-gpt"] },
  "gpt-6-luna": { catalogID: "openai/gpt-6-luna", preferredProviders: ["openrouter", "nano-gpt"] },
  "qwen3.8-flash": { catalogID: "qwen3.8-flash", preferredProviders: ["alibaba-cn", "alibaba-token-plan-cn", "alibaba"] },
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function compileFilters(patterns: unknown): RegExp[] {
  if (!Array.isArray(patterns)) return []
  const compiled: RegExp[] = []
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern) continue
    try {
      compiled.push(new RegExp(pattern))
    } catch (error) {
      console.warn(`[sailing3d-model-sync] ignoring invalid model filter ${JSON.stringify(pattern)}: ${String(error)}`)
    }
  }
  return compiled
}

function keepModel(id: string, include: RegExp[], exclude: RegExp[]): boolean {
  if (exclude.some((pattern) => pattern.test(id))) return false
  if (include.length > 0 && !include.some((pattern) => pattern.test(id))) return false
  return true
}

type Variant = {
  id: string
  body: Record<string, unknown>
}

// Reasonable default order for the model picker. models.dev does not guarantee
// an order, and a stable one keeps the menu from moving between refreshes.
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

// models.dev describes reasoning control per model. The Sailing3D gateway is an
// OpenAI-compatible shim in front of several backends: it accepts
// `reasoning_effort` for graded thinking and `thinking: {type: "disabled"}` for
// a hard off. Descriptors that cannot be expressed as a request field
// (`budget_tokens`) are skipped rather than guessed at.
function catalogVariants(source: CatalogModel | undefined, allowlist: readonly string[] | undefined): Variant[] | undefined {
  const options = source?.reasoning_options
  if (!Array.isArray(options) || options.length === 0) return undefined

  const efforts: string[] = []
  let toggle = false
  for (const option of options) {
    if (option?.type === "toggle") toggle = true
    if (option?.type !== "effort" || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      if (typeof value === "string" && value && !efforts.includes(value)) efforts.push(value)
    }
  }

  const restricted = allowlist && allowlist.length > 0 ? allowlist : undefined
  const order = restricted ?? EFFORT_ORDER
  const rank = (value: string) => {
    const index = order.indexOf(value)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const selected = efforts.filter((value) => !restricted || restricted.includes(value)).sort((a, b) => rank(a) - rank(b))

  const variants: Variant[] = []
  // A model that can be toggled off but offers no explicit `none` effort gets a
  // dedicated off variant; `none` already covers it when present. An explicit
  // allowlist has to mention `off` for that variant to appear.
  if (toggle && !selected.includes("none") && (!restricted || restricted.includes("off"))) {
    variants.push({ id: "off", body: { thinking: { type: "disabled" } } })
  }
  for (const effort of selected) variants.push({ id: effort, body: { reasoning_effort: effort } })
  return variants.length > 0 ? variants : undefined
}

function makeModel(gatewayID: string, entry?: InventoryRecord, variants?: Variant[]): Model.Info {
  const source = entry?.model
  const model = Model.Info.default(providerID, Model.ID.make(gatewayID))
  const result: any = {
    ...model,
    name: source?.name ?? gatewayID,
    limit: {
      context: source?.limit?.context ?? DEFAULT_CONTEXT,
      output: source?.limit?.output ?? DEFAULT_OUTPUT,
    },
    capabilities: {
      tools: source?.tool_call ?? true,
      input: source?.modalities?.input ?? DEFAULT_INPUT,
      output: source?.modalities?.output ?? ["text"],
    },
  }
  if (source?.limit?.input !== undefined) result.limit.input = source.limit.input
  if (source?.family) result.family = source.family
  if (source?.release_date) {
    const released = Date.parse(source.release_date)
    if (!Number.isNaN(released)) result.time = { ...(result.time ?? { released: 0 }), released }
  }
  if (source?.cost) {
    result.cost = [
      {
        input: source.cost.input ?? 0,
        output: source.cost.output ?? 0,
        cache: { read: source.cost.cache_read ?? 0, write: source.cost.cache_write ?? 0 },
      },
    ]
  }
  if (source?.interleaved && typeof source.interleaved === "object" && source.interleaved.field) {
    result.compatibility = { ...(result.compatibility ?? { reasoningField: "" }), reasoningField: source.interleaved.field }
  }
  if (variants && variants.length > 0) result.variants = variants
  return result
}

// Config-defined models that discovery does not return are kept so user
// overrides are never silently dropped.
function mergeConfiguredModels(
  discovered: SerializedModel[],
  configured: ReadonlyMap<string, Record<string, unknown>>,
): SerializedModel[] {
  const discoveredIDs = new Set<string>(discovered.map((model) => model.id))
  const extras = [...configured.entries()]
    .filter(([id]) => !discoveredIDs.has(id))
    .map(([, model]) => model as unknown as SerializedModel)
  return [...preserveConfiguredOverrides(discovered, configured), ...extras]
}

function preserveConfiguredOverrides(
  discovered: SerializedModel[],
  configured: ReadonlyMap<string, Record<string, unknown>>,
): SerializedModel[] {
  return discovered.map((model) => {
    const previous = configured.get(model.id)
    if (!previous) return model

    const merged = { ...model } as Record<string, unknown>
    for (const field of ["settings", "headers", "body", "compatibility", "variants", "cost"]) {
      if (previous[field] !== undefined) merged[field] = previous[field]
    }
    if (previous.enabled === false) merged.enabled = false
    if (typeof previous.name === "string" && previous.name !== previous.id) merged.name = previous.name
    return merged as SerializedModel
  })
}

const builtinModels: Record<string, InventoryRecord> = {
  [KB_MODEL_ID]: {
    provider: "sailing3d",
    model: {
      id: KB_MODEL_ID,
      name: "Dev-KB (研发知识库)",
      family: "dev-kb",
      tool_call: false,
      reasoning: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 128_000, output: 16_384 },
    },
  },
}

function resolveCatalogModel(gatewayID: string, catalog: CatalogResponse): InventoryRecord | undefined {
  if (builtinModels[gatewayID]) return builtinModels[gatewayID]
  const alias = aliases[gatewayID]
  const targetID = alias?.catalogID ?? gatewayID
  const matches: InventoryRecord[] = []

  for (const [provider, data] of Object.entries(catalog)) {
    const model = data?.models?.[targetID]
    if (model) matches.push({ provider, model })
  }
  if (matches.length === 0) return undefined

  const preferred = alias?.preferredProviders ?? []
  matches.sort((a, b) => {
    const ai = preferred.indexOf(a.provider)
    const bi = preferred.indexOf(b.provider)
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
  })

  const distinctSpecs = new Set(
    matches.map(({ model }) =>
      JSON.stringify({
        limit: model.limit,
        modalities: model.modalities,
      }),
    ),
  )
  if (distinctSpecs.size > 1) {
    console.warn(`[sailing3d-model-sync] models.dev has conflicting records for ${gatewayID}; selected ${matches[0].provider}`)
  }
  return matches[0]
}

async function requestJSON<T>(url: string, headers: HeadersInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  return (await response.json()) as T
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

async function callDevKb(input: {
  apiKey: string
  baseURL: string
  timeoutMs: number
  text: string
}): Promise<string> {
  const url = `${input.baseURL.replace(/\/+$/, "")}/chat/completions`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: KB_MODEL_ID,
      stream: false,
      messages: [{ role: "user", content: input.text }],
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  const data = (await response.json()) as ChatCompletionResponse
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error(data.error?.message ?? "empty response from dev-kb")
  return content
}

function cacheDirectory(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), ".cache")
  return join(base, "opencode")
}

function defaultCatalogFile(): string {
  return join(cacheDirectory(), "models.json")
}

async function newestCatalogFile(): Promise<string | undefined> {
  try {
    const directory = cacheDirectory()
    const names = (await readdir(directory)).filter((name) => /^models(-.+)?\.json$/.test(name))
    if (names.length === 0) return undefined
    const entries = await Promise.all(
      names.map(async (name) => ({ path: join(directory, name), mtime: (await stat(join(directory, name))).mtimeMs })),
    )
    entries.sort((a, b) => b.mtime - a.mtime)
    return entries[0]?.path
  } catch {
    return undefined
  }
}

// OpenCode maintains the models.dev snapshot under its cache directory. Reading
// that file avoids a network request and keeps metadata identical to what
// OpenCode itself uses.
async function readCatalogCache(
  file: string | undefined,
): Promise<{ catalog: CatalogResponse; mtimeMs: number } | undefined> {
  const candidates: Array<string | undefined> = []
  if (file) {
    candidates.push(file)
  } else {
    const explicit = process.env.OPENCODE_MODELS_PATH
    if (explicit) candidates.push(explicit)
    candidates.push(defaultCatalogFile())
    candidates.push(await newestCatalogFile())
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const text = await readFile(candidate, "utf8")
      const parsed = JSON.parse(text) as CatalogResponse
      if (parsed && typeof parsed === "object") {
        const mtimeMs = (await stat(candidate)).mtimeMs
        return { catalog: parsed, mtimeMs }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

async function fetchCatalog(url: string, timeoutMs: number): Promise<CatalogResponse> {
  return requestJSON<CatalogResponse>(url, { Accept: "application/json" }, timeoutMs)
}

function resolveCatalogFallback(value: unknown): string | undefined {
  // Enabled by default; `false` opts out to stay strictly cache-only.
  if (value === false) return undefined
  if (value === true || value === undefined) return DEFAULT_CATALOG_FALLBACK_URL
  return stringOption(value) ?? DEFAULT_CATALOG_FALLBACK_URL
}

async function discover(input: {
  apiKey: string
  gatewayURL: string
  catalogFile: string | undefined
  catalogFallbackURL: string | undefined
  catalogMaxAgeMs: number
  timeoutMs: number
  catalog: boolean
  include: RegExp[]
  exclude: RegExp[]
  variants: boolean
  variantEfforts: readonly string[] | undefined
}): Promise<SerializedModel[]> {
  const gateway = await requestJSON<ModelListResponse>(
    input.gatewayURL,
    { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
    input.timeoutMs,
  )

  const ids = [...new Set((gateway.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)))]
    .filter((id) => keepModel(id, input.include, input.exclude))
    .sort()

  if (ids.length === 0) {
    throw new Error("Sailing3D returned an empty model inventory after filtering")
  }

  let catalog: CatalogResponse = {}
  if (input.catalog) {
    const cached = await readCatalogCache(input.catalogFile)
    if (cached) catalog = cached.catalog

    const missingBefore = ids.filter((id) => !resolveCatalogModel(id, catalog))
    const stale = !cached || Date.now() - cached.mtimeMs > input.catalogMaxAgeMs
    if (input.catalogFallbackURL && (!cached || stale || missingBefore.length > 0)) {
      try {
        catalog = await fetchCatalog(input.catalogFallbackURL, input.timeoutMs)
        console.info(
          `[sailing3d-model-sync] refreshed models.dev metadata from ${input.catalogFallbackURL} (cache ${
            !cached ? "missing" : stale ? "stale" : "incomplete"
          })`,
        )
      } catch (error) {
        console.warn(`[sailing3d-model-sync] models.dev fallback fetch failed: ${String(error)}`)
      }
    }

    if (Object.keys(catalog).length === 0) {
      console.warn(
        `[sailing3d-model-sync] no models.dev cache at ${input.catalogFile ?? defaultCatalogFile()}; using OpenCode fallback metadata`,
      )
    }
  }

  return ids.map((id) => {
    const match = resolveCatalogModel(id, catalog)
    if (!match) console.warn(`[sailing3d-model-sync] no models.dev metadata for ${id}; using OpenCode fallback limits`)
    return makeModel(id, match, input.variants ? catalogVariants(match?.model, input.variantEfforts) : undefined)
  })
}

// Credentials are never read from the process environment: only an explicit
// provider `apiKey` or a credential saved through `/connect` are accepted.
async function resolveApiKey(ctx: { provider: any; integration: any }): Promise<string | undefined> {
  // 1. Explicit provider key that is not an `{env:...}` placeholder.
  try {
    const { data } = await ctx.provider.get({ providerID })
    const configured = (data?.settings as Record<string, unknown> | undefined)?.apiKey
    if (typeof configured === "string" && configured && !/^\{env:/i.test(configured)) return configured
  } catch (error) {
    console.warn(`[sailing3d-model-sync] could not read provider settings: ${String(error)}`)
  }

  // 2. Credential saved through /connect.
  try {
    const connection = await ctx.integration.connection.active(integrationID)
    if (connection) {
      const credential = await ctx.integration.connection.resolve(connection)
      if (credential?.type === "key" && credential.key) return credential.key
      if (credential?.type === "oauth" && credential.access) return credential.access
    }
  } catch (error) {
    console.warn(`[sailing3d-model-sync] could not resolve the /connect credential: ${String(error)}`)
  }

  return undefined
}

// OpenCode resolves a provider's credentials through the integration named by
// its `integrationID`, but binding that id only creates a reference. The
// integration and its methods have to be registered by a plugin, and it is
// runtime-scoped, so it is re-registered on every start.
async function registerIntegration(ctx: { integration: { transform: (callback: (editor: any) => void) => Promise<unknown> } }): Promise<void> {
  await ctx.integration.transform((editor: any) => {
    editor.update(integrationID, (integration: any) => {
      integration.name = integrationName
    })
    // Interactive `/connect` entry: pastes a key that OpenCode stores for us.
    editor.method.update({
      integrationID,
      method: { type: "key", label: "Sailing3D API key" },
    })
    // 0.3.0 advertised an env method. Drop it so a leftover environment
    // variable can never show up as a connection for this integration.
    try {
      editor.method.remove(integrationID, { type: "env", names: [LEGACY_API_KEY_ENV] })
    } catch {
      // Older builds may not expose method.remove, or nothing is left to remove.
    }
  })
}

// Logging out has to be observable: the provider registry is only rebuilt from
// the plugin on start/reload, so the last inventory must not be served from
// cache after the credential is gone.
async function clearCache(ctx: { storage: { remove: (key: string) => Promise<void> } }): Promise<void> {
  try {
    await ctx.storage.remove(cacheKey)
  } catch (error) {
    console.warn(`[sailing3d-model-sync] could not clear the cached inventory: ${String(error)}`)
  }
}

export default Plugin.define({
  id: "sailing3d-model-sync",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as PluginOptions
    const baseURL = stringOption(options.baseURL) ?? DEFAULT_BASE_URL
    const gatewayURL = stringOption(options.gatewayURL) ?? `${baseURL.replace(/\/+$/, "")}/models`
    const catalogFile = stringOption(options.catalogFile)
    const catalogFallbackURL = resolveCatalogFallback(options.catalogFallback)
    const catalogMaxAgeMs = numberOption(options.catalogMaxAgeMs) ?? DEFAULT_CATALOG_MAX_AGE_MS
    const refreshMs =
      numberOption(options.refreshMs) ??
      (numberOption(options.refreshHours) !== undefined ? (numberOption(options.refreshHours) as number) * 60 * 60 * 1000 : DEFAULT_REFRESH_MS)
    const timeoutMs = numberOption(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS
    const useCatalog = options.catalog !== false
    const include = compileFilters(options.includeModels)
    const exclude = compileFilters(options.excludeModels)
    const useCatalogVariants = options.catalogVariants !== false
    const variantEfforts = Array.isArray(options.variantEfforts)
      ? options.variantEfforts.filter((value): value is string => typeof value === "string" && Boolean(value))
      : undefined
    const discoverModels = (apiKey: string) =>
      discover({
        apiKey,
        gatewayURL,
        catalogFile,
        catalogFallbackURL,
        catalogMaxAgeMs,
        timeoutMs,
        catalog: useCatalog,
        include,
        exclude,
        variants: useCatalogVariants,
        variantEfforts,
      })

    try {
      await registerIntegration(ctx)
    } catch (error) {
      console.warn(`[sailing3d-model-sync] could not register the ${integrationName} integration: ${String(error)}`)
    }

    const apiKey = await resolveApiKey(ctx)

    const persist = async (inventory: SerializedModel[]) => {
      try {
        await ctx.storage.set(cacheKey, inventory as never)
      } catch (error) {
        console.warn(`[sailing3d-model-sync] could not persist inventory cache: ${String(error)}`)
      }
    }

    const providerInfo = {
      ...Provider.Info.empty(providerID),
      name: integrationName,
      activation: "enabled" as const,
      package: "@opencode/ai/providers/openai-compatible",
      integrationID: integrationID as never,
      settings: {
        baseURL,
        // Keep the secret out of the provider registry and API responses. This
        // placeholder is not substituted for plugin-provided settings, so real
        // requests authenticate through the integration registered above.
        apiKey: `{env:${LEGACY_API_KEY_ENV}}`,
      },
    }

    let models: SerializedModel[] = []
    let configuredOverrides = new Map<string, Record<string, unknown>>()
    // Whether the provider belongs in the registry at all. It stays false while
    // no credential is available, so logging out removes the provider instead of
    // resurrecting the last cached inventory.
    let enabled = false

    if (apiKey) {
      enabled = true
      try {
        models = await discoverModels(apiKey)
      } catch (error) {
        console.warn(`[sailing3d-model-sync] initial discovery failed; using cached inventory if available: ${String(error)}`)
        const cached = await ctx.storage.get(cacheKey)
        if (Array.isArray(cached)) models = cached as SerializedModel[]
      }
    }

    await ctx.provider.transform((editor) => {
      if (!enabled) {
        // No credential: drop the provider instead of serving stale models.
        if (editor.get("sailing3d")) editor.remove("sailing3d")
        return
      }
      const existing = editor.get("sailing3d")
      if (existing) {
        configuredOverrides = new Map(
          [...existing.models].map(([id, model]) => [id, model as unknown as Record<string, unknown>]),
        )
        models = mergeConfiguredModels(models, configuredOverrides)
        editor.update("sailing3d", (provider) => {
          provider.name = providerInfo.name
          provider.activation = providerInfo.activation
          provider.package = providerInfo.package
          provider.integrationID = providerInfo.integrationID
          provider.settings = { ...provider.settings, ...providerInfo.settings }
        })
        editor.models.set("sailing3d", models)
      } else {
        editor.add({ info: providerInfo, models })
      }
    })

    if (enabled) {
      console.info(`[sailing3d-model-sync] initialized with ${models.length} models`)
      if (models.length > 0) await persist(models)
    } else {
      await clearCache(ctx)
      console.warn(
        `[sailing3d-model-sync] no credential for "${integrationName}"; removed the provider and cached inventory. Run /connect for "${integrationName}" to enable discovery`,
      )
    }

    const isKbEnabled = (): boolean => enabled && models.some((model) => model.id === KB_MODEL_ID)

    const reloadDomains = async (): Promise<void> => {
      await ctx.provider.reload()
      try {
        await ctx.agent?.reload()
      } catch (error) {
        console.warn(`[sailing3d-model-sync] could not reload agents: ${String(error)}`)
      }
      try {
        await ctx.skill?.reload()
      } catch (error) {
        console.warn(`[sailing3d-model-sync] could not reload skills: ${String(error)}`)
      }
      try {
        await ctx.command?.reload()
      } catch (error) {
        console.warn(`[sailing3d-model-sync] could not reload commands: ${String(error)}`)
      }
    }

    let refreshing = false
    let pending = false
    // Returns a one-line summary so both the event path and the manual
    // `/sailing3d-refresh` command can report what happened.
    const refresh = async (): Promise<string> => {
      if (refreshing) {
        pending = true
        return "another refresh is already running; queued a follow-up"
      }
      refreshing = true
      const started = Date.now()
      const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
      try {
        const key = await resolveApiKey(ctx)
        if (!key) {
          enabled = false
          models = []
          await clearCache(ctx)
          await reloadDomains()
          const message = `no credential for ${integrationName}; removed the provider and cleared the cached inventory`
          console.warn(`[sailing3d-model-sync] ${message}`)
          return message
        }
        const latest = mergeConfiguredModels(await discoverModels(key), configuredOverrides)
        models = latest
        enabled = true
        await reloadDomains()
        await persist(latest)
        console.info(`[sailing3d-model-sync] refreshed ${latest.length} models`)
        return `refreshed ${latest.length} models from ${gatewayURL} in ${elapsed()}`
      } catch (error) {
        const detail = String(error)
        console.warn(`[sailing3d-model-sync] refresh failed; retaining last successful inventory: ${detail}`)
        return `refresh failed (${detail}); kept the previous ${models.length} models (after ${elapsed()})`
      } finally {
        refreshing = false
        if (pending) {
          pending = false
          void refresh()
        }
      }
    }

    // Expose `@kb-agent` subagent and `dev-kb` skill only when the active
    // credential belongs to `dev-group` (so `/v1/models` returns `dev-kb`).
    try {
      await ctx.agent?.transform((editor) => {
        if (!isKbEnabled()) {
          if (editor.get(KB_AGENT_ID)) editor.remove(KB_AGENT_ID)
          return
        }
        editor.update(KB_AGENT_ID, (agent) => {
          agent.name = Agent.Name.make(KB_AGENT_ID)
          agent.description =
            "Sailing3D 研发知识库（Dev-KB）专职子智能体：负责检索团队规范与架构经验、沉淀文档（/kb-add、/kb-append）、管理个人研发偏好（/kb-pref）及查看知识库目录（/kb-status、/kb-help）。"
          agent.mode = "subagent"
          agent.hidden = false
          agent.model = {
            providerID,
            id: Model.ID.make(KB_MODEL_ID),
          }
          agent.system =
            "你是研发团队开发知识库（Dev-KB）专职助手。请直接将用户的查询问题或 /kb-* 指令原样提交并输出知识库网关返回的内容，不要调用任何本地工具。"
          agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
        })
      })
    } catch (error) {
      console.warn(`[sailing3d-model-sync] could not register @${KB_AGENT_ID}: ${String(error)}`)
    }

    try {
      await ctx.skill?.transform((editor) => {
        if (!isKbEnabled()) {
          if (editor.get(KB_SKILL_ID)) editor.remove(KB_SKILL_ID)
          return
        }
        const skillInfo: Skill.Info = {
          id: Skill.ID.make(KB_SKILL_ID),
          name: Skill.Name.make(KB_SKILL_ID),
          description:
            "Sailing3D 研发知识库（Dev-KB）检索、文档沉淀与个人研发偏好管理技能。当需要查询团队规范/架构文档、沉淀项目经验或设置个人研发偏好时使用。",
          autoinvoke: true,
          path: join(cacheDirectory(), "skills", KB_SKILL_ID, "SKILL.md") as Skill.Info["path"],
          content: KB_SKILL_CONTENT,
        }
        if (editor.get(KB_SKILL_ID)) {
          editor.update(KB_SKILL_ID, (skill) => {
            skill.name = skillInfo.name
            skill.description = skillInfo.description
            skill.autoinvoke = skillInfo.autoinvoke
            skill.path = skillInfo.path
            skill.content = skillInfo.content
          })
        } else {
          editor.add(skillInfo)
        }
      })
    } catch (error) {
      console.warn(`[sailing3d-model-sync] could not register ${KB_SKILL_ID} skill: ${String(error)}`)
    }

    const runKbCommand = async (sessionID: string, rawText: string) => {
      try {
        const key = await resolveApiKey(ctx)
        if (!key) {
          await ctx.session.synthetic({
            sessionID: sessionID as never,
            text: `[dev-kb] 未找到有效的 ${integrationName} 凭据，请先执行 /connect。`,
            description: KB_SYNTHETIC_DESCRIPTION,
            resume: false,
          })
          return
        }
        const reply = await callDevKb({ apiKey: key, baseURL, timeoutMs, text: rawText })
        await ctx.session.synthetic({
          sessionID: sessionID as never,
          text: reply,
          description: KB_SYNTHETIC_DESCRIPTION,
          resume: false,
        })
      } catch (error) {
        try {
          await ctx.session.synthetic({
            sessionID: sessionID as never,
            text: `[dev-kb] 调用研发知识库失败: ${String(error)}`,
            description: KB_SYNTHETIC_DESCRIPTION,
            resume: false,
          })
        } catch (inner) {
          console.warn(`[sailing3d-model-sync] could not report dev-kb command error: ${String(inner)}`)
        }
      }
    }

    // Manual entry point for when the automatic triggers are not enough
    // (a gateway-side rename, a fix that needs an immediate re-check, ...),
    // plus `/kb-*` commands when the user's group exposes `dev-kb`.
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "sailing3d-refresh",
          description: "Re-query the Sailing3D gateway and update the sailing3d model list",
          execute: async (input) => {
            const summary = await refresh()
            try {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `[sailing3d-model-sync] ${summary}`,
                description: "Sailing3D model sync",
                resume: false,
              })
            } catch (error) {
              console.warn(`[sailing3d-model-sync] could not report the refresh: ${String(error)}`)
            }
          },
        })

        if (!isKbEnabled()) return

        const kbCommands: Array<{ name: string; description: string; format: (arg: string) => string }> = [
          {
            name: "kb-help",
            description: "查看 Sailing3D 研发知识库 (Dev-KB) 使用指南与快捷指令",
            format: () => "/kb-help",
          },
          {
            name: "kb-status",
            description: "查看 Sailing3D 研发知识库 (Dev-KB) 文档目录与状态",
            format: () => "/kb-status",
          },
          {
            name: "kb-whoami",
            description: "查看当前账号在研发知识库中的身份与个人偏好",
            format: () => "/kb-whoami",
          },
          {
            name: "kb-pref",
            description: "查看或更新个人研发偏好（用法：/kb-pref [偏好内容 | clear]）",
            format: (arg) => (arg ? `/kb-pref ${arg}` : "/kb-pref"),
          },
          {
            name: "kb-ask",
            description: "检索 Sailing3D 研发知识库（用法：/kb-ask <问题>）",
            format: (arg) => (arg ? `/kb-ask ${arg}` : "/kb-help"),
          },
          {
            name: "kb-add",
            description: "向 Sailing3D 研发知识库新增文档（用法：/kb-add [分类] # 标题\\n正文）",
            format: (arg) => (arg ? `/kb-add ${arg}` : "/kb-help"),
          },
          {
            name: "kb-append",
            description: "向 Sailing3D 研发知识库已有文档追加内容（用法：/kb-append <doc_id或标题>\\n内容）",
            format: (arg) => (arg ? `/kb-append ${arg}` : "/kb-help"),
          },
          {
            name: "kb-history",
            description: "查看 Sailing3D 研发知识库近期变更记录",
            format: (arg) => (arg ? `/kb-history ${arg}` : "/kb-history"),
          },
        ]

        for (const cmd of kbCommands) {
          editor.add({
            name: cmd.name,
            description: cmd.description,
            execute: async (input) => {
              const arg = (input.prompt?.text ?? "").trim()
              await runKbCommand(input.sessionID, cmd.format(arg))
            },
          })
        }
      })
    } catch (error) {
      console.warn(`[sailing3d-model-sync] could not register commands: ${String(error)}`)
    }

    const timer = setInterval(() => void refresh(), refreshMs)
    // Coalesce bursts (a /connect emits several credential events) and re-read
    // the models.dev cache as soon as OpenCode refreshes it instead of waiting
    // for the next scheduled interval.
    let debounce: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (debounce) return
      debounce = setTimeout(() => {
        debounce = undefined
        void refresh()
      }, 250)
    }
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!REFRESH_EVENTS.has(event.type)) continue
          if (event.type === "models-dev.refreshed" && !useCatalog) continue
          scheduleRefresh()
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`[sailing3d-model-sync] event subscription stopped: ${String(error)}`)
        }
      }
    })()
    return () => {
      clearInterval(timer)
      if (debounce) clearTimeout(debounce)
      controller.abort()
    }
  },
})
