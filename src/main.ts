import { createServer } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { createGelClient } from "@openzerg/common/gel"
import { PodmanPodClient } from "@openzerg/common/pod-client"
import { createWorkspaceManagerRouter } from "./router.js"

async function main() {
  const dsn = process.env.GEL_DSN ?? "gel://admin@uz-gel/main?tls_security=insecure"
  const containerUrl = process.env.CONTAINER_URL || process.env.PODMAN_SOCKET

  const gel = createGelClient(dsn)
  const client = new PodmanPodClient(containerUrl)
  const router = createWorkspaceManagerRouter(gel, client)

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
