import { strict as assert } from "node:assert"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"
import tuiPlugin from "../tui.ts"

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
  storageRemovals: number
  replacedModels: Array<Record<string, any>>
  addedModels: Array<Record<string, any>>
  updatedProvider: Record<string, any> | undefined
  addedProviderID: string | undefined
  removedProviders: string[]
  reloads: number
  integration: Record<string, any> | undefined
  integrationMethods: Array<Record<string, any>>
  removedMethods: Array<{ integrationID: string; method: Record<string, any> }>
  commands: Array<{ name: string; description?: string; execute: (input: any) => Promise<void> }>
  synthetic: Array<Record<string, any>>
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
  emitEvents?: string[]
  eventDelayMs?: number
  configuredOnly?: Record<string, Record<string, any>>
  failIntegrationRegistration?: boolean
} = {}) {
  const state: FakeState = {
    authHeader: undefined,
    stored: undefined,
    storageRemovals: 0,
    replacedModels: [],
    addedModels: [],
    updatedProvider: undefined,
    addedProviderID: undefined,
    removedProviders: [],
    reloads: 0,
    integration: undefined,
    integrationMethods: [],
    removedMethods: [],
    commands: [],
    synthetic: [],
  }

  const removedProviders = new Set<string>()
  const transforms: Array<(editor: any) => void> = []

  const makeEditor = () => ({
    get: (providerID: string) =>
      removedProviders.has(providerID)
        ? undefined
        : {
            provider: { id: "sailing3d", settings: { customOption: true, apiKey: "{env:SAILING3D_API_KEY}" } },
            models: new Map([[configuredModel.id, configuredModel], ...Object.entries(options.configuredOnly ?? {})]),
          },
    add: (input: { info: { id: string }; models: Array<Record<string, any>> }) => {
      state.addedProviderID = input.info.id
      state.addedModels = input.models
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
    remove: (providerID: string) => {
      removedProviders.add(providerID)
      state.removedProviders.push(providerID)
    },
    models: {
      set: (_id: string, models: Array<Record<string, any>>) => {
        state.replacedModels = models
      },
      update: () => {},
      remove: () => {},
    },
  })

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
        transforms.push(callback)
        callback(makeEditor())
      },
      reload: async () => {
        state.reloads++
        // The real host re-applies every registered transform on reload.
        for (const callback of transforms) callback(makeEditor())
      },
    },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        if (options.failIntegrationRegistration) throw new Error("integration transform unavailable")
        callback({
          list: () => [],
          get: () => undefined,
          update: (id: string, mutate: (integration: Record<string, any>) => void) => {
            const integration: Record<string, any> = { id, name: undefined }
            mutate(integration)
            state.integration = integration
          },
          remove: () => assert.fail("unexpected integration remove"),
          method: {
            list: () => [],
            update: (registration: Record<string, any>) => {
              state.integrationMethods.push(registration.method)
            },
            remove: (integrationID: string, method: Record<string, any>) => {
              state.removedMethods.push({ integrationID, method })
            },
          },
        })
      },
      connection: {
        active: async () => (options.connectKey ? { type: "credential", id: "cred_test", label: "Sailing3D Gateway", method: "key" } : undefined),
        resolve: async () => (options.connectKey ? { type: "key", key: options.connectKey } : undefined),
      },
    },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          add: (definition: { name: string; description?: string; execute: (input: any) => Promise<void> }) => {
            state.commands.push(definition)
          },
        })
      },
      list: async () => ({ data: state.commands.map(({ name, description }) => ({ name, description })) }),
      reload: async () => {},
    },
    session: {
      synthetic: async (input: Record<string, any>) => {
        state.synthetic.push(input)
      },
    },
    event: {
      subscribe: (opts?: { signal?: AbortSignal }) => {
        const signal = opts?.signal
        return (async function* () {
          for (const type of options.emitEvents ?? []) {
            await new Promise((resolve) => setTimeout(resolve, options.eventDelayMs ?? 0))
            yield { type }
          }
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
      remove: async () => {
        state.storageRemovals++
      },
      scan: async () => ({ entries: [], next: undefined }),
    },
  } as any

  return { context, state }
}

// 1. An explicit provider key wins over /connect, and SAILING3D_API_KEY in the
//    process environment is ignored entirely.
process.env.SAILING3D_API_KEY = "env-key"
{
  const { context, state } = createContext({ connectKey: "connect-key", configuredApiKey: "literal-key" })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, "Bearer literal-key")
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
  // Only the /connect key method is registered; the env method is not.
  assert.equal(state.integration?.id, "sailing3d")
  assert.equal(state.integration?.name, "Sailing3D Gateway")
  assert.deepEqual(state.integrationMethods, [{ type: "key", label: "Sailing3D API key" }])
  assert.deepEqual(state.removedMethods, [
    { integrationID: "sailing3d", method: { type: "env", names: ["SAILING3D_API_KEY"] } },
  ])
  await cleanup?.()
}

// 2. Falls back to the /connect credential when no explicit provider key exists.
{
  delete process.env.SAILING3D_API_KEY
  const { context, state } = createContext({ connectKey: "connect-key" })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, "Bearer connect-key")
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  await cleanup?.()
}

// 3. Logging out removes the provider and drops the cached inventory; an
//    environment variable alone is not a credential anymore.
{
  process.env.SAILING3D_API_KEY = "env-key"
  lastAuth = undefined
  const cached = [{ id: "from-cache", name: "From Cache", limit: { context: 1, output: 1 }, capabilities: { tools: true, input: ["text"], output: ["text"] } }]
  const { context, state } = createContext({ cached })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, undefined, "an env var must not trigger discovery")
  assert.deepEqual(state.removedProviders, ["sailing3d"])
  assert.equal(state.storageRemovals, 1)
  assert.equal(state.addedProviderID, undefined)
  assert.equal(state.stored, undefined)
  assert.deepEqual(state.replacedModels, [])
  delete process.env.SAILING3D_API_KEY
  await cleanup?.()
}

// 4. Model filters and catalog opt-out options are honoured.
{
  const { context, state } = createContext({ options: { includeModels: ["^glm-5"], catalog: false }, connectKey: "connect-key" })
  const cleanup = await plugin.setup(context)
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ["glm-5.3", "glm-5.3-flash", "deepseek-flash"])
  assert.equal(state.replacedModels[0].limit.context, 200_000)
  await cleanup?.()
}

// 5. A missing models.dev cache stays offline when catalogFallback is disabled.
{
  const { context, state } = createContext({
    options: { catalogFile: join(catalogDir, "missing.json"), catalogFallback: false },
    connectKey: "connect-key",
  })
  const cleanup = await plugin.setup(context)
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  assert.equal(state.replacedModels[0].limit.context, 200_000)
  assert.equal(state.replacedModels[0].limit.output, 32_000)
  assert.ok(state.replacedModels[0].capabilities.input.includes("image"))
  await cleanup?.()
}

// 6. A models-dev.refreshed event triggers an immediate refresh.
{
  const { context, state } = createContext({ emitEvents: ["models-dev.refreshed"], connectKey: "connect-key" })
  const cleanup = await plugin.setup(context)
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(state.reloads >= 1, "expected a provider reload after models-dev.refreshed")
  await cleanup?.()
}

// 7. Config-only models are preserved when discovery does not return them.
{
  const retired = {
    id: "retired-model",
    name: "Retired Model",
    limit: { context: 4096, output: 1024 },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
  }
  const { context, state } = createContext({ configuredOnly: { "retired-model": retired }, connectKey: "connect-key" })
  const cleanup = await plugin.setup(context)
  const kept = state.replacedModels.find(({ id }) => id === "retired-model")
  assert.ok(kept, "expected the config-only model to be preserved")
  assert.equal(kept.name, "Retired Model")
  assert.equal(kept.limit.context, 4096)
  assert.deepEqual(state.replacedModels.filter(({ id }) => id !== "retired-model").map(({ id }) => id), ids)
  await cleanup?.()
}

// 8. catalogFallback is on by default and fetches models.dev when the cache is missing.
{
  const before = remoteCatalogFetches
  const { context, state } = createContext({
    options: { catalogFile: join(catalogDir, "missing-fallback.json") },
    connectKey: "connect-key",
  })
  const cleanup = await plugin.setup(context)
  assert.equal(remoteCatalogFetches, before + 1)
  const glm = state.replacedModels.find(({ id }) => id === "glm-5.3")!
  assert.equal(glm.cost[0].output, 2)
  assert.equal(glm.family, "glm")
  await cleanup?.()
}

// 9. A failing integration registration never breaks discovery.
{
  const { context, state } = createContext({ connectKey: "connect-key", failIntegrationRegistration: true })
  const cleanup = await plugin.setup(context)
  assert.equal(lastAuth, "Bearer connect-key")
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  assert.equal(state.integration, undefined)
  await cleanup?.()
}

// 10. A refresh that finds no credential tears the provider down again.
{
  const options = { connectKey: "connect-key" as string | undefined, emitEvents: ["credential.updated"], eventDelayMs: 30 }
  const { context, state } = createContext(options)
  const cleanup = await plugin.setup(context)
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ids)
  assert.deepEqual(state.removedProviders, [])
  // Log out while the plugin is still running.
  options.connectKey = undefined
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(state.removedProviders, ["sailing3d"])
  assert.ok(state.reloads >= 1, "expected a provider reload after the credential disappeared")
  assert.ok(state.storageRemovals >= 1, "expected the cached inventory to be cleared")
  await cleanup?.()
}

// 11. Discovery failures with a live credential still fall back to the cache.
{
  const cached = [
    { id: "from-cache", name: "From Cache", limit: { context: 1, output: 1 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
  ]
  const { context, state } = createContext({ connectKey: "connect-key", cached, options: { catalog: false } })
  const failing = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).includes("/v1/models")) throw new Error("network down")
    return failing(input)
  }
  const cleanup = await plugin.setup(context)
  globalThis.fetch = failing
  assert.deepEqual(state.replacedModels.map(({ id }) => id), ["from-cache", "deepseek-flash"])
  assert.deepEqual(state.removedProviders, [])
  await cleanup?.()
}

// 12. Connecting while the plugin runs (/connect -> credential.updated) exposes
//     models without a restart, matching the built-in providers.
{
  const options = { connectKey: undefined as string | undefined, emitEvents: ["credential.updated"], eventDelayMs: 30 }
  const { context, state } = createContext(options)
  const cleanup = await plugin.setup(context)
  // No credential yet: provider absent.
  assert.deepEqual(state.removedProviders, ["sailing3d"])
  assert.deepEqual(state.replacedModels, [])
  assert.equal(state.addedProviderID, undefined)
  // The user pastes a key through /connect.
  options.connectKey = "connect-key"
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(state.addedProviderID, "sailing3d")
  assert.deepEqual(state.addedModels.map(({ id }) => id), ids)
  assert.ok(state.stored, "expected the inventory to be persisted after connecting")
  assert.ok(state.reloads >= 1, "expected a provider reload after connecting")
  await cleanup?.()
}

// 13. /sailing3d-refresh re-queries the gateway on demand and reports back into
//     the session.
{
  const { context, state } = createContext({ connectKey: "connect-key", options: { catalog: false } })
  const cleanup = await plugin.setup(context)
  const command = state.commands.find(({ name }) => name === "sailing3d-refresh")
  assert.ok(command, "expected the manual refresh command to be registered")
  assert.ok(command.description, "the command needs a description for the palette")
  const reloadsBefore = state.reloads
  lastAuth = undefined
  await command.execute({ sessionID: "ses_test" })
  assert.equal(lastAuth, "Bearer connect-key", "the command must re-query the gateway")
  assert.ok(state.reloads > reloadsBefore, "the command must republish the provider")
  assert.deepEqual(state.synthetic.length, 1)
  assert.match(state.synthetic[0].text, /refreshed \d+ models/)
  assert.equal(state.synthetic[0].sessionID, "ses_test")
  assert.equal(state.synthetic[0].resume, false)
  await cleanup?.()
}
// 14. The TUI companion turns the refresh summary into a toast, and only that.
{
  let handler: ((event: any) => void) | undefined
  const toasts: Array<Record<string, any>> = []
  const cleanup = await tuiPlugin.setup({
    data: {
      on: (type: string, next: (event: any) => void) => {
        assert.equal(type, "session.inbox.enqueued")
        handler = next
        return () => {
          handler = undefined
        }
      },
    },
    ui: { toast: { show: (options: Record<string, any>) => toasts.push(options) } },
  } as any)
  assert.ok(handler, "expected the TUI plugin to subscribe")

  const enqueue = (item: Record<string, any>) => handler!({ data: { sessionID: "ses_test", inboxID: "inbox_1", item } })

  // Unrelated inbox traffic never toasts.
  enqueue({ type: "user", payload: { text: "hello" } })
  enqueue({ type: "synthetic", payload: { text: "The server restarted", description: "Continuing after restart" } })
  enqueue({ type: "synthetic", payload: { text: "[sailing3d-model-sync] quiet", description: "something else" } })
  assert.equal(toasts.length, 0, "only our own summaries may toast")

  enqueue({
    type: "synthetic",
    payload: { text: "[sailing3d-model-sync] refreshed 8 models from https://ai-api.sailing3d.cn/v1/models in 1.4s", description: "Sailing3D model sync" },
  })
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].variant, "success")
  assert.equal(toasts[0].title, "Sailing3D model sync")
  assert.match(toasts[0].message, /^refreshed 8 models from https:\/\/ai-api\.sailing3d\.cn\/v1\/models/)
  assert.ok(!toasts[0].message.includes("[sailing3d-model-sync]"), "the prefix belongs to the transcript line")

  enqueue({
    type: "synthetic",
    payload: { text: "[sailing3d-model-sync] refresh failed (HTTP 500); kept the previous 8 models (after 1.2s)", description: "Sailing3D model sync" },
  })
  assert.equal(toasts[1].variant, "error")

  enqueue({
    type: "synthetic",
    payload: { text: "[sailing3d-model-sync] no credential for Sailing3D Gateway; removed the provider and cleared the cached inventory", description: "Sailing3D model sync" },
  })
  assert.equal(toasts[2].variant, "warning")

  await cleanup?.()
  assert.equal(handler, undefined, "cleanup must unsubscribe")
}

globalThis.fetch = originalFetch
await rm(catalogDir, { recursive: true, force: true })
console.log(
  JSON.stringify({
    provider: "sailing3d",
    scenarios: 14,
    modelCount: ids.length,
  }),
)
