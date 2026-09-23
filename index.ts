import { Model, Plugin, Provider } from "@opencode/plugin"

const providerID = Provider.ID.make("sailing3d")
const gatewayURL = "https://ai-api.sailing3d.cn/v1/models"
const catalogURL = "https://models.dev/api.json"
const refreshMs = 6 * 60 * 60 * 1000
const cacheKey = "sailing3d-model-inventory-v1"

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

// Provider IDs are only used to resolve models.dev's duplicate provider records.
// Gateway IDs remain unchanged in OpenCode's Sailing3D inventory.
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
  "openai/gpt-6-luna": { catalogID: "openai/gpt-6-luna", preferredProviders: ["openrouter", "nano-gpt"] },
  "gpt-6-luna": { catalogID: "openai/gpt-6-luna", preferredProviders: ["openrouter", "nano-gpt"] },
  "qwen3.8-flash": { catalogID: "qwen3.8-flash", preferredProviders: ["alibaba-cn", "alibaba-token-plan-cn", "alibaba"] },
}

function makeModel(gatewayID: string, entry?: InventoryRecord) {
  const source = entry?.model
  const model = Model.Info.default(providerID, Model.ID.make(gatewayID))
  const result = {
    ...model,
    name: source?.name ?? gatewayID,
    limit: {
      context: source?.limit?.context ?? 200_000,
      output: source?.limit?.output ?? 32_000,
    },
    capabilities: {
      tools: source?.tool_call ?? true,
      input: source?.modalities?.input ?? ["text", "image"],
      output: source?.modalities?.output ?? ["text"],
    },
  } as ReturnType<typeof Model.Info.default> & {
    limit: { context: number; input?: number; output: number }
    compatibility?: { reasoningField: string }
  }
  if (source?.limit?.input !== undefined) result.limit.input = source.limit.input
  if (source?.interleaved && typeof source.interleaved === "object" && source.interleaved.field) {
    result.compatibility = { reasoningField: source.interleaved.field }
  }
  return result
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

  const distinctSpecs = new Set(matches.map(({ model }) => JSON.stringify({
    limit: model.limit,
    modalities: model.modalities,
  })))
  if (distinctSpecs.size > 1) {
    console.warn(`[sailing3d-model-sync] models.dev has conflicting records for ${gatewayID}; selected ${matches[0].provider}`)
  }
  return matches[0]
}

async function requestJSON<T>(url: string, headers: HeadersInit = {}): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  return (await response.json()) as T
}

async function discover(apiKey: string): Promise<SerializedModel[]> {
  const [gateway, catalog] = await Promise.all([
    requestJSON<ModelListResponse>(gatewayURL, { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }),
    requestJSON<CatalogResponse>(catalogURL, { Accept: "application/json" }),
  ])

  const ids = [...new Set((gateway.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)))].sort()
  if (ids.length === 0) throw new Error("Sailing3D returned an empty model inventory")

  return ids.map((id) => {
    const match = resolveCatalogModel(id, catalog)
    if (!match) console.warn(`[sailing3d-model-sync] no models.dev metadata for ${id}; using OpenCode fallback limits`)
    return makeModel(id, match)
  })
}

export default Plugin.define({
  id: "sailing3d-model-sync",
  async setup(ctx) {
    const apiKey = process.env.SAILING3D_API_KEY
    if (!apiKey) throw new Error("SAILING3D_API_KEY must be available to the OpenCode server process")

    const providerInfo = {
      ...Provider.Info.empty(providerID),
      name: "Sailing3D Gateway",
      activation: "enabled" as const,
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: "https://ai-api.sailing3d.cn/v1",
        // Keep the secret out of the provider registry and API responses.
        apiKey: "{env:SAILING3D_API_KEY}",
      },
    }

    let models: SerializedModel[] = []
    let configuredOverrides = new Map<string, Record<string, unknown>>()
    try {
      models = await discover(apiKey)
    } catch (error) {
      console.warn(`[sailing3d-model-sync] initial discovery failed: ${String(error)}`)
      const cached = await ctx.storage.get(cacheKey)
      if (Array.isArray(cached)) models = cached as SerializedModel[]
    }

    await ctx.provider.transform((editor) => {
      const existing = editor.get("sailing3d")
      if (existing) {
        configuredOverrides = new Map(
          [...existing.models].map(([id, model]) => [id, model as unknown as Record<string, unknown>]),
        )
        models = preserveConfiguredOverrides(models, configuredOverrides)
        editor.update("sailing3d", (provider) => {
          provider.name = providerInfo.name
          provider.activation = providerInfo.activation
          provider.package = providerInfo.package
          provider.settings = { ...provider.settings, ...providerInfo.settings }
        })
        editor.models.set("sailing3d", models)
      } else {
        editor.add({ info: providerInfo, models })
      }
    })
    console.info(`[sailing3d-model-sync] initialized with ${models.length} models`)

    let refreshing = false
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const latest = preserveConfiguredOverrides(await discover(apiKey), configuredOverrides)
        models = latest
        await ctx.provider.reload()
        try {
          await ctx.storage.set(cacheKey, latest as never)
        } catch (error) {
          console.warn(`[sailing3d-model-sync] could not persist inventory cache: ${String(error)}`)
        }
        console.info(`[sailing3d-model-sync] refreshed ${latest.length} models`)
      } catch (error) {
        console.warn(`[sailing3d-model-sync] refresh failed; retaining last successful inventory: ${String(error)}`)
      } finally {
        refreshing = false
      }
    }

    if (models.length > 0) {
      try {
        await ctx.storage.set(cacheKey, models as never)
      } catch (error) {
        console.warn(`[sailing3d-model-sync] could not persist inventory cache: ${String(error)}`)
      }
    }
    const timer = setInterval(() => void refresh(), refreshMs)
    return () => clearInterval(timer)
  },
})
