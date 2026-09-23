import { strict as assert } from "node:assert"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"

const ids = [
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "gpt-6-luna",
  "k3",
  "kimi-for-coding",
  "kimi-k3",
  "kimi-k3-256k",
  "qwen3.8-flash",
]

const catalog = {
  deepseek: {
    models: {
      "deepseek-flash": { name: "DeepSeek V4.1 Flash", limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text", "image"], output: ["text"] } },
      "deepseek-v4-flash": { name: "DeepSeek V4 Flash", limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text", "image"], output: ["text"] } },
      "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text", "image"], output: ["text"] } },
    },
  },
  zhipuai: {
    models: {
      "glm-5.3": {
        name: "GLM-5.3",
        family: "glm",
        tool_call: true,
        release_date: "2025-06-01T00:00:00Z",
        interleaved: { field: "reasoning_content" },
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
        limit: { context: 1_000_000, output: 131_072 },
        modalities: { input: ["text"], output: ["text"] },
      },
      "glm-5.3-flash": { name: "GLM-5.3-Flash", tool_call: true, limit: { context: 1_000_000, output: 131_072 }, modalities: { input: ["text", "image", "video", "pdf"], output: ["text"] } },
    },
  },
  "kimi-code-plan-global": {
    models: {
      "kimi-for-coding": { name: "Kimi for Coding", tool_call: true, limit: { context: 1_048_576, output: 32_768 }, modalities: { input: ["text", "image", "video"], output: ["text"] } },
      "k3-256k": { name: "Kimi K3-256K", tool_call: true, limit: { context: 262_144, output: 131_072 }, modalities: { input: ["text", "image"], output: ["text"] } },
      "k3": { name: "Kimi K3", family: "kimi", tool_call: true, release_date: "2025-04-01T00:00:00Z", cost: { input: 0.5, output: 1.5, cache_read: 0.05, cache_write: 0 }, limit: { context: 1_048_576, output: 131_072 }, modalities: { input: ["text", "image"], output: ["text"] } },
    },
  },
  openrouter: {
    models: {
      "openai/gpt-6-luna": { name: "GPT 6 Luna", tool_call: true, limit: { context: 1_050_000, output: 128_000 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } },
    },
  },
  "alibaba-cn": {
    models: {
      "qwen3.8-flash": { name: "Qwen3.8 Flash", tool_call: true, limit: { context: 1_000_000, output: 131_072 }, modalities: { input: ["text", "image", "video"], output: ["text"] } },
    },
  },
}

type FakeState = {
  authHeader: string | undefined
  stored: unknown
  replacedModels: Array<Record<string, any>>
  updatedProvider: Record<string, any> | undefined
  addedProviderID: string | undefined
  reloads: number
}

const originalFetch = globalThis.fetch
let lastAuth: string | undefined
let remoteCatalogFetches = 0

globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes("/v1/models")) {
    lastAuth = new Headers(init?.headers).get("authorization") ?? undefined
    return Response.json({ data: ids.map((id) => ({ id })) })
  }
  if (url === "https://models.dev/api.json") {
    remoteCatalogFetches++
    return Response.json(catalog)
  }
  throw new Error(`Unexpected URL: ${url}`)
}

// The plugin reads OpenCode's models.dev cache from disk instead of the network.
const catalogDir = await mkdtemp(join(tmpdir(), "sailing3d-catalog-"))
const catalogFile = join(catalogDir, "models.json")
await writeFile(catalogFile, JSON.stringify(catalog), "utf8")

function createContext(options: {
  options?: Record<string, unknown>
  connectKey?: string
  configuredApiKey?: string
  cached?: unknown
  emitRefreshed?: boolean
  configuredOnly?: Record<string, Record<string, any>>
} = {}) {
  const state: FakeState = {
    authHeader: undefined,
    stored: undefined,
    replacedModels: [],
    updatedProvider: undefined,
    addedProviderID: undefined,
    reloads: 0,
  }

  const configuredModel = {
    id: "deepseek-flash",
    name: "My DeepSeek alias",
    limit: { context: 12_000, output: 1_000 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    compatibility: { reasoningField: "reasoning_content" },
    settings: { temperature: 0.2 },
  }

  const context = {
    options: { catalogFile, ...(options.options ?? {}) },
    provider: {
      get: async () => ({ data: { settings: options.configuredApiKey ? { apiKey: options.configuredApiKey } : {} } }),
      transform: async (callback: (editor: any) => void) => {
        callback({
          get: () => ({
            provider: { id: "sailing3d", settings: { customOption: true, apiKey: "{env:SAILING3D_API_KEY}" } },
            models: new Map([[configuredModel.id, configuredModel], ...Object.entries(options.configuredOnly ?? {})]),
          }),
          add: (input: { info: { id: string } }) => {
            state.addedProviderID = input.info.id
          },
          update: (_id: string, mutate: (provider: any) => void) => {
            const provider: Record<string, any> = {
              name: "old name",
              activation: "enabled",
              package: "old",
              settings: { customOption: true, apiKey: "{env:SAILING3D_API_KEY}" },
            }
            mutate(provider)
            state.updatedProvider = provider
          },
          remove: () => assert.fail("unexpected provider remove"),
          models: {
            set: (_id: string, models: Array<Record<string, any>>) => {
              state.replacedModels = models
            },
            update: () => {},
            remove: () => {},
          },
        })
      },
      reload: async () => {
        state.reloads++
      },
    },
    integration: {
      connection: {
        active: async () => (options.connectKey ? { type: "credential", id: "cred_test", label: "Sailing3D Gateway", method: "key" } : undefined),
        resolve: async () => (options.connectKey ? { type: "key", key: options.connectKey } : undefined),
      },
    },
    event: {
      subscribe: (opts?: { signal?: AbortSignal }) => {
        const signal = opts?.signal
        return (async function* () {
          if (options.emitRefreshed) yield { type: "models-dev.refreshed" }
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) return resolve()
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })()
      },
    },
    storage: {
      get: async () => options.cached,
      set: async (_key: string, value: unknown) => {
        state.stored = value
      },
      remove: async () => {},
      scan: async () => ({ entries: [], next: undefined }),
    },
  } as any

  return { context, state }
}

// 1. Environment variable is the primary credential.
process.env.SAILING3D_API_KEY = "env-key"
{
  const { context, state } = createContext({ connectKey: "connect-key", configuredApiKey: "literal-key" })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, "Bearer env-key")
  assert.equal(state.addedProviderID, undefined)
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  assert.equal(state.updatedProvider?.integrationID, "sailing3d")
  assert.equal(state.updatedProvider?.settings.apiKey, "{env:SAILING3D_API_KEY}")
  assert.equal(state.updatedProvider?.settings.customOption, true)
  assert.ok(state.replacedModels.every((model) => model.limit.context > 0 && model.limit.output > 0))
  assert.ok(state.replacedModels.every((model) => model.capabilities.output.includes("text")))
  const deepseek = state.replacedModels.find(({ id }) => id === "deepseek-flash")!
  assert.equal(deepseek.name, "My DeepSeek alias")
  assert.equal(deepseek.limit.context, 1_000_000)
  assert.equal(deepseek.compatibility.reasoningField, "reasoning_content")
  assert.deepEqual(deepseek.settings, { temperature: 0.2 })
  const kimi = state.replacedModels.find(({ id }) => id === "kimi-k3-256k")!
  assert.equal(kimi.limit.context, 262_144)
  assert.deepEqual(kimi.capabilities.input, ["text", "image"])
  const glm = state.replacedModels.find(({ id }) => id === "glm-5.3")!
  assert.equal(glm.family, "glm")
  assert.equal(glm.time.released, Date.parse("2025-06-01T00:00:00Z"))
  assert.equal(glm.cost[0].output, 2)
  assert.equal(glm.cost[0].cache.read, 0.1)
  assert.equal(glm.compatibility.reasoningField, "reasoning_content")
  const k3 = state.replacedModels.find(({ id }) => id === "k3")!
  assert.equal(k3.limit.context, 1_048_576)
  assert.equal(k3.family, "kimi")
  assert.equal(k3.cost[0].output, 1.5)
  const kimiK3 = state.replacedModels.find(({ id }) => id === "kimi-k3")!
  assert.equal(kimiK3.limit.context, 1_048_576)
  assert.equal(kimiK3.cost[0].cache.read, 0.05)
  assert.ok(state.stored)
  assert.equal(state.reloads, 0)
  await cleanup?.()
}

// 2. Falls back to the /connect credential when the environment variable is absent.
{
  delete process.env.SAILING3D_API_KEY
  const { context, state } = createContext({ connectKey: "connect-key" })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, "Bearer connect-key")
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  await cleanup?.()
}

// 3. Falls back to an explicit provider API key before /connect.
{
  delete process.env.SAILING3D_API_KEY
  const { context, state } = createContext({ connectKey: "connect-key", configuredApiKey: "literal-key" })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, "Bearer literal-key")
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  await cleanup?.()
}

// 4. Without any credential it does not throw and reuses the cached inventory.
{
  delete process.env.SAILING3D_API_KEY
  lastAuth = undefined
  const cached = [{ id: "from-cache", name: "From Cache", limit: { context: 1, output: 1 }, capabilities: { tools: true, input: ["text"], output: ["text"] } }]
  const { context, state } = createContext({ cached })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, undefined)
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ["from-cache", "deepseek-flash"])
  await cleanup?.()
}

// 5. Model filters and catalog opt-out options are honoured.
{
  process.env.SAILING3D_API_KEY = "env-key"
  const { context, state } = createContext({ options: { includeModels: ["^glm-5"], catalog: false } })
  const cleanup = await plugin.setup(context)
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ["glm-5.3", "glm-5.3-flash", "deepseek-flash"])
  assert.equal(state.replacedModels[0].limit.context, 200_000)
  await cleanup?.()
}

// 6. A missing models.dev cache stays offline when catalogFallback is disabled.
{
  process.env.SAILING3D_API_KEY = "env-key"
  const { context, state } = createContext({
    options: { catalogFile: join(catalogDir, "missing.json"), catalogFallback: false },
  })
  const cleanup = await plugin.setup(context)
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  assert.equal(state.replacedModels[0].limit.context, 200_000)
  assert.equal(state.replacedModels[0].limit.output, 32_000)
  assert.ok(state.replacedModels[0].capabilities.input.includes("image"))
  await cleanup?.()
}

// 7. A models-dev.refreshed event triggers an immediate refresh.
{
  process.env.SAILING3D_API_KEY = "env-key"
  const { context, state } = createContext({ emitRefreshed: true })
  const cleanup = await plugin.setup(context)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(state.reloads >= 1, "expected a provider reload after models-dev.refreshed")
  await cleanup?.()
}

// 8. Config-only models are preserved when discovery does not return them.
{
  process.env.SAILING3D_API_KEY = "env-key"
  const retired = {
    id: "retired-model",
    name: "Retired Model",
    limit: { context: 4096, output: 1024 },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
  }
  const { context, state } = createContext({ configuredOnly: { "retired-model": retired } })
  const cleanup = await plugin.setup(context)
  const kept = state.replacedModels.find(({ id }) => id === "retired-model")
  assert.ok(kept, "expected the config-only model to be preserved")
  assert.equal(kept.name, "Retired Model")
  assert.equal(kept.limit.context, 4096)
  assert.deepEqual(state.replacedModels.filter(({ id }) => id !== "retired-model").map(({ id }) => id), ids)
  await cleanup?.()
}

// 9. catalogFallback is on by default and fetches models.dev when the cache is missing.
{
  process.env.SAILING3D_API_KEY = "env-key"
  const before = remoteCatalogFetches
  const { context, state } = createContext({
    options: { catalogFile: join(catalogDir, "missing-fallback.json") },
  })
  const cleanup = await plugin.setup(context)
  assert.equal(remoteCatalogFetches, before + 1)
  const glm = state.replacedModels.find(({ id }) => id === "glm-5.3")!
  assert.equal(glm.cost[0].output, 2)
  assert.equal(glm.family, "glm")
  await cleanup?.()
}

globalThis.fetch = originalFetch
await rm(catalogDir, { recursive: true, force: true })
console.log(
  JSON.stringify({
    provider: "sailing3d",
    scenarios: 9,
    modelCount: ids.length,
  }),
)
