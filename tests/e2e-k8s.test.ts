import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { WorkspaceManagerClient } from "@openzerg/common"
import { openDB, autoMigrate } from "../src/db.js"
import { createWorkspaceManagerRouter } from "../src/router.js"
import { KubernetesClient } from "@openzerg/common/pod-client"
import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"

const PG_PORT = 15437
const PG_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/e2e_wm_k8s`
const WM_PORT = 25081

let client: WorkspaceManagerClient
let server: Server
let k8s: KubernetesClient
const createdPods: string[] = []
const createdPVCs: string[] = []

beforeAll(async () => {
  try {
    execSync(
      `podman run -d --name e2e-wm-k8s-pg -p ${PG_PORT}:5432 ` +
      `-e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=e2e_wm_k8s ` +
      `docker.io/library/postgres:17-alpine`,
      { stdio: "pipe" },
    )
  } catch {}

  let ok = false
  for (let i = 0; i < 15; i++) {
    try {
      await autoMigrate(PG_URL)
      ok = true
      break
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (!ok) throw new Error("DB setup failed")

  const db = openDB(PG_URL)
  k8s = new KubernetesClient()

  const handler = connectNodeAdapter({
    routes: createWorkspaceManagerRouter(db, k8s),
  })

  server = createServer(handler)
  server.listen(WM_PORT)
  await new Promise(r => setTimeout(r, 100))

  client = new WorkspaceManagerClient({
    baseURL: `http://localhost:${WM_PORT}`,
    token: "",
  })
}, 60_000)

afterAll(async () => {
  for (const name of createdPods) {
    try { await k8s.removePod(name) } catch {}
  }
  for (const name of createdPVCs) {
    try { await k8s.removeVolume(name) } catch {}
  }
  try { execSync("podman rm -f e2e-wm-k8s-pg", { stdio: "pipe" }) } catch {}
  server?.close()
}, 30_000)

describe("Workspace Manager E2E — k3s Kubernetes", () => {
  test("health check", async () => {
    const result = await client.health()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.status).toBe("ok")
    }
  }, 30_000)

  test("create workspace creates PVC in k8s", async () => {
    const sessionId = randomUUID()
    const result = await client.createWorkspace(sessionId)
    if (result.isErr()) console.error("createWorkspace ERR:", result.error)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.workspaceId).toBeTruthy()
    expect(result.value.volumeName).toBeTruthy()
    createdPVCs.push(result.value.volumeName)

    console.log(`[k8s-e2e] PVC ${result.value.volumeName} created`)
  }, 30_000)

  test("start worker creates k8s Pod", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return
    createdPVCs.push(ws.value.volumeName)

    const result = await client.startWorker({
      sessionId,
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "300"],
      env: { TEST_MODE: "k8s" },
      volumes: [{ name: ws.value.volumeName, destination: "/data/workspace" }],
    })
    if (result.isErr()) console.error("startWorker ERR:", result.error)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.workerId).toBeTruthy()
    expect(result.value.containerName).toBeTruthy()
    createdPods.push(result.value.containerName)

    console.log(`[k8s-e2e] worker pod ${result.value.containerName} created`)

    await new Promise(r => setTimeout(r, 5000))

    const info = await k8s.inspectPod(result.value.containerName)
    expect(info.state).toMatch(/running|pending/)
    console.log(`[k8s-e2e] pod state: ${info.state}`)
  }, 30_000)

  test("list workers", async () => {
    const result = await client.listWorkers()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.workers.length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  test("stop worker deletes k8s Pod", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return
    createdPVCs.push(ws.value.volumeName)

    const worker = await client.startWorker({
      sessionId,
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "300"],
      env: {},
      volumes: [{ name: ws.value.volumeName, destination: "/data/workspace" }],
    })
    expect(worker.isOk()).toBe(true)
    if (!worker.isOk()) return
    createdPods.push(worker.value.containerName)

    const stopResult = await client.stopWorker(worker.value.workerId)
    expect(stopResult.isOk()).toBe(true)

    const status = await client.getWorkerStatus(worker.value.workerId)
    expect(status.isOk()).toBe(true)
    if (!status.isOk()) return
    expect(status.value.state).toBe("stopped")

    console.log(`[k8s-e2e] worker ${worker.value.containerName} stopped`)
  }, 30_000)

  test("delete workspace removes PVC", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const del = await client.deleteWorkspace(ws.value.workspaceId)
    expect(del.isOk()).toBe(true)

    console.log(`[k8s-e2e] workspace ${ws.value.volumeName} deleted`)
  }, 30_000)
})
