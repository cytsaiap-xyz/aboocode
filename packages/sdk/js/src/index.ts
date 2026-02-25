export * from "./client.js"
export * from "./server.js"

import { createAboocodeClient } from "./client.js"
import { createAboocodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createAboocode(options?: ServerOptions) {
  const server = await createAboocodeServer({
    ...options,
  })

  const client = createAboocodeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
