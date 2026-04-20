import { createServer } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { autoMigrate, openDB } from "./db.js"
import { PodmanPodClient } from "@openzerg/common/pod-client"
import { createWorkspaceManagerRouter } from "./router.js"

async function main() {
  const databaseURL = process.env.DATABASE_URL
  if (!databaseURL) {
    console.error("[workspace-manager] DATABASE_URL is required")
    process.exit(1)
  }

  const containerUrl = process.env.CONTAINER_URL || process.env.PODMAN_SOCKET

  await autoMigrate(databaseURL)

  const db = openDB(databaseURL)
  const client = new PodmanPodClient(containerUrl)
  const router = createWorkspaceManagerRouter(db, client)

  const server = createServer(connectNodeAdapter({ routes: router }))

  const port = 25020
  server.listen(port, () => {
    console.log(`[workspace-manager] listening on :${port}`)
  })
}

main().catch(err => {
  console.error("[workspace-manager] fatal", err)
  process.exit(1)
})
