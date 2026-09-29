import type { Plugin } from "@opencode/plugin/tui"

// The server side reports every refresh result as a *synthetic message*, because
// a slash command's `execute` cannot return output to the client. That line is
// easy to miss in the transcript, so this TUI-side companion turns exactly those
// messages into a toast - the one feedback channel a user cannot miss.
//
// The definition is exported as a plain object instead of `Plugin.define({...})`:
// a *value* import of `@opencode/plugin/tui` would drag in `solid-js`, an
// optional peer dependency that is not installed next to this plugin, and the
// whole TUI module would then fail to load. `Plugin.define` only returns its
// argument, so behaviour is identical. Nothing here may break the interface:
// every step is guarded, and a failed registration only means the transcript
// line is the sole feedback again.
const DESCRIPTION = "Sailing3D model sync"
const PREFIX = "[sailing3d-model-sync] "

function variantFor(summary: string): "success" | "warning" | "error" {
  if (/refresh failed/i.test(summary)) return "error"
  if (/no credential/i.test(summary)) return "warning"
  return "success"
}

const definition: Plugin.Definition = {
  id: "sailing3d-model-sync-tui",
  async setup(ctx) {
    let off: (() => void) | undefined
    try {
      off = ctx.data.on("session.inbox.enqueued", (event) => {
        try {
          const item = event.data.item
          if (item.type !== "synthetic") return
          if (item.payload.description !== DESCRIPTION) return
          const raw = item.payload.text
          const summary = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw
          if (!summary) return
          ctx.ui.toast.show({ title: DESCRIPTION, message: summary, variant: variantFor(summary) })
        } catch {
          // A notification must never break the TUI.
        }
      })
    } catch (error) {
      console.warn(`[sailing3d-model-sync] could not register the refresh toast: ${String(error)}`)
    }
    return () => {
      try {
        off?.()
      } catch {
        // Already detached.
      }
    }
  },
}

export default definition
