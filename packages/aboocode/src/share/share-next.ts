import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ulid } from "ulid"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Database, eq } from "@/storage/db"
import { SessionShareTable } from "./share.sql"
import { Log } from "@/util/log"
import type * as SDK from "@aboocode/sdk/v2"

export namespace ShareNext {
  const log = Log.create({ service: "share-next" })

  export async function url() {
    return Config.get().then((x) => x.enterprise?.url ?? "https://opncd.ai")
  }

  const disabled = process.env["ABOOCODE_DISABLE_SHARE"] === "true" || process.env["ABOOCODE_DISABLE_SHARE"] === "1"

  export async function init() {
    if (disabled) return
    Bus.subscribe(Session.Event.Updated, async (evt) => {
      try {
        await sync(evt.properties.info.id, [
          {
            type: "session",
            data: evt.properties.info,
          },
        ])
      } catch (e) {
        log.error("share sync failed", { error: e })
      }
    })
    Bus.subscribe(MessageV2.Event.Updated, async (evt) => {
      try {
        await sync(evt.properties.info.sessionID, [
          {
            type: "message",
            data: evt.properties.info,
          },
        ])
        if (evt.properties.info.role === "user") {
          await sync(evt.properties.info.sessionID, [
            {
              type: "model",
              data: [
                await Provider.getModel(evt.properties.info.model.providerID, evt.properties.info.model.modelID).then(
                  (m) => m,
                ),
              ],
            },
          ])
        }
      } catch (e) {
        log.error("share sync failed", { error: e })
      }
    })
    Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      try {
        await sync(evt.properties.part.sessionID, [
          {
            type: "part",
            data: evt.properties.part,
          },
        ])
      } catch (e) {
        log.error("share sync failed", { error: e })
      }
    })
    Bus.subscribe(Session.Event.Diff, async (evt) => {
      try {
        await sync(evt.properties.sessionID, [
          {
            type: "session_diff",
            data: evt.properties.diff,
          },
        ])
      } catch (e) {
        log.error("share sync failed", { error: e })
      }
    })
  }

  export async function create(sessionID: string) {
    if (disabled) return { id: "", url: "", secret: "" }
    log.info("creating share", { sessionID })
    const response = await fetch(`${await url()}/api/share`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionID: sessionID }),
    })
    if (!response.ok) {
      throw new Error(`Failed to create share: ${response.status}`)
    }
    const result = (await response.json()) as { id: string; url: string; secret: string }
    Database.use((db) =>
      db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run(),
    )
    fullSync(sessionID)
    return result
  }

  function get(sessionID: string) {
    const row = Database.use((db) =>
      db.select().from(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).get(),
    )
    if (!row) return
    return { id: row.id, secret: row.secret, url: row.url }
  }

  type Data =
    | {
        type: "session"
        data: SDK.Session
      }
    | {
        type: "message"
        data: SDK.Message
      }
    | {
        type: "part"
        data: SDK.Part
      }
    | {
        type: "session_diff"
        data: SDK.FileDiff[]
      }
    | {
        type: "model"
        data: SDK.Model[]
      }

  function dataKey(item: Data): string {
    switch (item.type) {
      case "session":
        return "session"
      case "message":
        return `message/${(item.data as SDK.Message).id}`
      case "part":
        return `part/${(item.data as SDK.Part).messageID}/${(item.data as SDK.Part).id}`
      case "session_diff":
        return "session_diff"
      case "model":
        return "model"
    }
  }

  const queue = new Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>()
  async function sync(sessionID: string, data: Data[]) {
    if (disabled) return
    const existing = queue.get(sessionID)
    if (existing) {
      for (const item of data) {
        existing.data.set(dataKey(item), item)
      }
      return
    }

    const dataMap = new Map<string, Data>()
    for (const item of data) {
      dataMap.set(dataKey(item), item)
    }

    const timeout = setTimeout(async () => {
      const queued = queue.get(sessionID)
      if (!queued) return
      const share = get(sessionID)
      if (!share) {
        queue.delete(sessionID)
        return
      }

      try {
        const response = await fetch(`${await url()}/api/share/${share.id}/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            secret: share.secret,
            data: Array.from(queued.data.values()),
          }),
        })
        if (!response.ok) {
          log.error("share sync request failed", { status: response.status, shareID: share.id })
          return // keep queue entry for next attempt
        }
        queue.delete(sessionID)
      } catch (e) {
        log.error("share sync fetch error", { error: e, shareID: share.id })
        // keep queue entry so data is not lost
      }
    }, 1000)
    queue.set(sessionID, { timeout, data: dataMap })
  }

  export async function remove(sessionID: string) {
    if (disabled) return
    log.info("removing share", { sessionID })
    const share = get(sessionID)
    if (!share) return
    const response = await fetch(`${await url()}/api/share/${share.id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        secret: share.secret,
      }),
    })
    if (!response.ok) {
      log.error("share remove request failed", { status: response.status, shareID: share.id })
      throw new Error(`Failed to remove share: ${response.status}`)
    }
    Database.use((db) => db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run())
  }

  async function fullSync(sessionID: string) {
    log.info("full sync", { sessionID })
    const session = await Session.get(sessionID)
    const diffs = await Session.diff(sessionID)
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    const models = await Promise.all(
      messages
        .filter((m) => m.info.role === "user")
        .map((m) => (m.info as SDK.UserMessage).model)
        .map((m) => Provider.getModel(m.providerID, m.modelID).then((m) => m)),
    )
    await sync(sessionID, [
      {
        type: "session",
        data: session,
      },
      ...messages.map((x) => ({
        type: "message" as const,
        data: x.info,
      })),
      ...messages.flatMap((x) => x.parts.map((y) => ({ type: "part" as const, data: y }))),
      {
        type: "session_diff",
        data: diffs,
      },
      {
        type: "model",
        data: models,
      },
    ])
  }
}
