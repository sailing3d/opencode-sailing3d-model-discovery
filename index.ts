import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Model, Plugin, Provider } from "@opencode/plugin"

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

function makeModel(gatewayID: string, entry?: InventoryRecord): Model.Info {
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

function resolveCatalogModel(gatewayID: string, catalog: CatalogResponse): InventoryRecord | undefined {
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
    return makeModel(id, match)
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
        models = await discover({ apiKey, gatewayURL, catalogFile, catalogFallbackURL, catalogMaxAgeMs, timeoutMs, catalog: useCatalog, include, exclude })
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

    let refreshing = false
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const key = await resolveApiKey(ctx)
        if (!key) {
          enabled = false
          models = []
          await clearCache(ctx)
          await ctx.provider.reload()
          console.warn("[sailing3d-model-sync] refresh found no credential; removed the provider and cached inventory")
          return
        }
        const latest = mergeConfiguredModels(
          await discover({ apiKey: key, gatewayURL, catalogFile, catalogFallbackURL, catalogMaxAgeMs, timeoutMs, catalog: useCatalog, include, exclude }),
          configuredOverrides,
        )
        models = latest
        enabled = true
        await ctx.provider.reload()
        await persist(latest)
        console.info(`[sailing3d-model-sync] refreshed ${latest.length} models`)
      } catch (error) {
        console.warn(`[sailing3d-model-sync] refresh failed; retaining last successful inventory: ${String(error)}`)
      } finally {
        refreshing = false
      }
    }

    const timer = setInterval(() => void refresh(), refreshMs)
    // Re-read the models.dev cache as soon as OpenCode refreshes it instead of
    // waiting for the next scheduled interval.
    const controller = new AbortController()
    if (useCatalog) {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type === "models-dev.refreshed") void refresh()
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.warn(`[sailing3d-model-sync] models.dev refresh subscription stopped: ${String(error)}`)
          }
        }
      })()
    }
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  },
})
