import { strict as assert } from "node:assert"
import plugin from "../index.ts"

let addedProviderID: string | undefined
let stored: unknown
let replacedModels: Array<Record<string, any>> = []
let updatedSettings: Record<string, unknown> = {}
let reloads = 0
const ids = [
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "gpt-6-luna",
  "kimi-for-coding",
  "kimi-k3-256k",
  "qwen3.8-flash",
]

const catalog = {
  deepseek: { models: {
    "deepseek-flash": { name: "DeepSeek V4.1 Flash", limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text", "image"], output: ["text"] } },
    "deepseek-v4-flash": { name: "DeepSeek V4 Flash", limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text", "image"], output: ["text"] } },
    "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text", "image"], output: ["text"] } },
  } },
  zhipuai: { models: {
    "glm-5.3": { name: "GLM-5.3", tool_call: true, limit: { context: 1_000_000, output: 131_072 }, modalities: { input: ["text"], output: ["text"] } },
    "glm-5.3-flash": { name: "GLM-5.3-Flash", tool_call: true, limit: { context: 1_000_000, output: 131_072 }, modalities: { input: ["text", "image", "video", "pdf"], output: ["text"] } },
  } },
  "kimi-code-plan-global": { models: {
    "kimi-for-coding": { name: "Kimi for Coding", tool_call: true, limit: { context: 1_048_576, output: 32_768 }, modalities: { input: ["text", "image", "video"], output: ["text"] } },
    "k3-256k": { name: "Kimi K3-256K", tool_call: true, limit: { context: 262_144, output: 131_072 }, modalities: { input: ["text", "image"], output: ["text"] } },
  } },
  openrouter: { models: {
    "openai/gpt-6-luna": { name: "GPT 6 Luna", tool_call: true, limit: { context: 1_050_000, output: 128_000 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } },
  } },
  "alibaba-cn": { models: {
    "qwen3.8-flash": { name: "Qwen3.8 Flash", tool_call: true, limit: { context: 1_000_000, output: 131_072 }, modalities: { input: ["text", "image", "video"], output: ["text"] } },
  } },
}

const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes("/v1/models")) {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${process.env.SAILING3D_API_KEY}`)
    return Response.json({ data: ids.map((id) => ({ id })) })
  }
  if (url === "https://models.dev/api.json") return Response.json(catalog)
  throw new Error(`Unexpected URL host: ${new URL(url).host}`)
}

const context = {
  provider: {
    transform: async (callback: (editor: any) => void) => {
      const configuredModel = {
        id: "deepseek-flash",
        name: "My DeepSeek alias",
        limit: { context: 12_000, output: 1_000 },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        compatibility: { reasoningField: "reasoning_content" },
        settings: { temperature: 0.2 },
      }
      callback({
        get: () => ({
          provider: { id: "sailing3d", settings: { customOption: true, apiKey: "{env:SAILING3D_API_KEY}" } },
          models: new Map([[configuredModel.id, configuredModel]]),
        }),
        add: (input: { info: { id: string } }) => { addedProviderID = input.info.id },
        update: (_id: string, mutate: (provider: any) => void) => {
          const provider = { name: "old name", activation: "enabled", package: "old", settings: { customOption: true, apiKey: "{env:SAILING3D_API_KEY}" } }
          mutate(provider)
          updatedSettings = provider.settings
        },
        remove: () => assert.fail("unexpected provider remove"),
        models: { set: (_id: string, models: Array<Record<string, any>>) => { replacedModels = models }, update: () => {}, remove: () => {} },
      })
    },
    reload: async () => { reloads++ },
  },
  storage: {
    get: async () => undefined,
    set: async (_key: string, value: unknown) => { stored = value },
    remove: async () => {},
    scan: async () => ({ entries: [], next: undefined }),
  },
} as any

process.env.SAILING3D_API_KEY ??= "test-only-sailing3d-key"
const cleanup = await plugin.setup(context)
assert.equal(addedProviderID, undefined)
assert.deepEqual(replacedModels.map(({ id }) => id), ids)
assert.equal(updatedSettings.apiKey, "{env:SAILING3D_API_KEY}")
assert.equal(updatedSettings.customOption, true)
assert.ok(replacedModels.every((model) => model.limit.context > 0 && model.limit.output > 0))
assert.ok(replacedModels.every((model) => model.capabilities.output.includes("text")))
const deepseek = replacedModels.find(({ id }) => id === "deepseek-flash")!
assert.equal(deepseek.name, "My DeepSeek alias")
assert.equal(deepseek.limit.context, 1_000_000)
assert.equal(deepseek.compatibility.reasoningField, "reasoning_content")
assert.deepEqual(deepseek.settings, { temperature: 0.2 })
const kimi = replacedModels.find(({ id }) => id === "kimi-k3-256k")!
assert.equal(kimi.limit.context, 262_144)
assert.deepEqual(kimi.capabilities.input, ["text", "image"])
assert.ok(stored)
assert.equal(reloads, 0)
await cleanup?.()
globalThis.fetch = originalFetch
console.log(JSON.stringify({
  provider: "sailing3d",
  modelCount: replacedModels.length,
  ids: replacedModels.map(({ id }) => id),
  reloads,
  cached: Boolean(stored),
}))
