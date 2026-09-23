# OpenCode Sailing3D Model Discovery

An OpenCode v2 plugin that discovers model IDs from the Sailing3D New API
gateway and enriches them with context limits and modalities from models.dev.
It runs without an LLM and does not edit OpenCode configuration files.

## Requirements

- OpenCode v2.0.14 or later
- Node.js 22+ for the local checks
- `SAILING3D_API_KEY` available to the OpenCode server process

The plugin requests `https://ai-api.sailing3d.cn/v1/models` and
`https://models.dev/api.json` at startup, then refreshes every six hours. It
keeps the last successful inventory if a later refresh fails. The gateway's
model ID remains the OpenCode model ID; a small explicit alias map connects
gateway names to models.dev slugs such as `k3-256k`.

models.dev can contain different records for the same model from different
providers. The plugin uses a deterministic provider preference for known
models and emits a warning when records conflict. If metadata is missing, it
uses OpenCode's documented fallback assumptions and logs that fact.

## Install from this private repository

Clone the repository on the device used for testing, then install its local
development dependencies:

```sh
git clone https://github.com/sailing3d/opencode-sailing3d-model-discovery.git
cd opencode-sailing3d-model-discovery
npm ci
```

Use a separate HOME/config directory and `--standalone` to test without
connecting to the existing shared OpenCode service or changing its config.
Create `$TEST_HOME/.config/opencode/opencode.jsonc` with the cloned repository
path as a plugin:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-sailing3d-model-discovery"]
}
```

Start OpenCode v2 with the isolated directories and the API key in the
standalone server's environment:

```sh
HOME="$TEST_HOME" \
XDG_CONFIG_HOME="$TEST_HOME/.config" \
SAILING3D_API_KEY="$SAILING3D_API_KEY" \
opencode --standalone
```

Set `TEST_HOME` to a disposable directory and replace the plugin path with the
clone's absolute path. Do not put the API key in the JSONC file. The plugin
registers the provider using the `{env:SAILING3D_API_KEY}` placeholder, not the
secret value.

## Development checks

```sh
npm run check
npm test
```

The smoke test uses fixture responses and does not call the gateway. The plugin
itself reads the API key only from the server process environment and never
prints or persists it.
