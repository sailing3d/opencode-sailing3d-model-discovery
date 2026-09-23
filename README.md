# OpenCode Sailing3D Model Discovery

An OpenCode v2 plugin that discovers model IDs from the Sailing3D New API gateway
and enriches them with context limits, modalities, cost, and family metadata from
the [models.dev](https://models.dev) snapshot that OpenCode already keeps in its
cache. It runs without an LLM and does not edit OpenCode configuration files.

## Requirements

- OpenCode v2.0.14 or later
- Node.js 22+ for the local checks
- A Sailing3D API key available to the OpenCode server, through either:
  - the `SAILING3D_API_KEY` environment variable, or
  - a **Sailing3D Gateway** account saved with `/connect`

## Install

```sh
opencode plugin add github:sailing3d/opencode-sailing3d-model-discovery
opencode plugin list
```

## Credentials

The plugin resolves the discovery key in this order:

1. `SAILING3D_API_KEY` in the OpenCode server environment (primary).
2. A literal `apiKey` in the configured provider settings.
3. The credential saved through `/connect` for **Sailing3D Gateway**.

If none is available the plugin does not fail: it keeps the last successful
inventory from its cache and logs how to connect.

The plugin registers the `sailing3d` provider with the
`@opencode/ai/providers/openai-compatible` package and binds its `integrationID`
to `sailing3d`, so `/connect` manages the saved account. The secret is never
written to configuration; the provider setting keeps the
`{env:SAILING3D_API_KEY}` placeholder.

## What it does

At startup the plugin requests the gateway model list and reads OpenCode's cached
models.dev snapshot (`~/.cache/opencode/models.json`; `$XDG_CACHE_HOME` and
`%USERPROFILE%` are honoured), then merges the results into the `sailing3d`
provider. It refreshes every six hours, re-reads the cache on each refresh and
immediately after OpenCode publishes its `models-dev.refreshed` event, and keeps
the last successful inventory if a later refresh fails. OpenCode maintains
that cache itself, so by default the plugin performs no additional models.dev
request; if the cache is missing it falls back to OpenCode's documented defaults
(tools on, text and image input, 200k context, 32k output). Set `catalogFallback`
to let the plugin fetch models.dev when the cache is missing, stale, or lacks
metadata for a discovered model. Explicitly configured models that discovery does
not return are preserved. The gateway's model ID remains the OpenCode model ID; a
small explicit alias map connects gateway names to models.dev slugs such as
`k3-256k`.

models.dev can contain different records for the same model from different
providers. The plugin uses a deterministic provider preference for known models
and emits a warning when records conflict. If metadata is missing, it uses
OpenCode's documented fallback assumptions and logs that fact.

## Options

Pass options with the object form in `opencode.json(c)`:

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
        "excludeModels": ["-preview$"]
      }
    }
  ]
}
```

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `baseURL` | `string` | `https://ai-api.sailing3d.cn/v1` | Gateway base URL. |
| `gatewayURL` | `string` | `${baseURL}/models` | Full gateway models endpoint. |
| `catalogFile` | `string` | `~/.cache/opencode/models.json` | Path to OpenCode's models.dev cache. |
| `catalogFallback` | `boolean \| string` | unset (cache only) | Fetch models.dev when the cache is missing, stale, or incomplete. `true` uses `https://models.dev/api.json`. |
| `catalogMaxAgeMs` | `number` | `86400000` | Cache age after which `catalogFallback` is consulted. |
| `refreshMs` | `number` | `21600000` | Refresh interval in milliseconds. |
| `refreshHours` | `number` | `6` | Refresh interval in hours. |
| `timeoutMs` | `number` | `15000` | Per-request timeout. |
| `catalog` | `boolean` | `true` | Set `false` to skip models.dev enrichment. |
| `includeModels` | `string[]` | `[]` | Keep only ids matching one of these regular expressions. |
| `excludeModels` | `string[]` | `[]` | Drop ids matching any of these regular expressions. |

## Development checks

```sh
npm ci
npm run check
npm test
```

The smoke test uses fixture responses and does not call the gateway. The plugin
itself reads the credential only from the server environment or OpenCode's
credential store and never prints or persists it.

### Testing locally

OpenCode does not inject `@opencode/plugin` into plugins loaded from a bare local
directory, so a local checkout must be installed as a package:

```sh
opencode plugin add "git+file:///absolute/path/to/opencode-sailing3d-model-discovery"
opencode reload
```
