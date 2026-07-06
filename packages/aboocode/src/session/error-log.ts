import { GlobalBus } from "../bus/global"
import { Log } from "../util/log"
import { Session } from "."

export namespace SessionErrorLog {
  let started = false

  export function init() {
    if (started) return
    started = true
    // `Bus.subscribe` requires an active `Instance.provide` context (its subscription map is
    // keyed by `Instance.directory` via AsyncLocalStorage), but this bridge is wired at process
    // entry points, before any instance context exists. `GlobalBus` is a plain EventEmitter that
    // every `Bus.publish` call forwards onto regardless of instance context (see
    // `src/bus/index.ts`), so we listen there instead - the same pattern `src/index.ts` already
    // uses to forward events over RPC.
    GlobalBus.on("event", (event) => {
      if (event.payload?.type !== Session.Event.Error.type) return
      const { sessionID, error } = event.payload.properties as {
        sessionID?: string
        error: unknown
      }
      const name = (error as any)?.name as string | undefined
      const message = (error as any)?.data?.message ?? name ?? "session error"
      Log.recordError({
        source: "session.error",
        sessionID,
        category: name,
        message,
      })
    })
  }
}
