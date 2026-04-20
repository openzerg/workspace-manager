import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { WorkspaceManagerClient } from "@openzerg/common"
import { openDB, autoMigrate } from "../src/db.js"
import { createWorkspaceManagerRouter } from "../src/router.js"
import { PodmanPodClient } from "@openzerg/common/pod-client"
import type { PodClient } from "@openzerg/common/pod-client"
import { randomUUID } from "node:crypto"

const PG_PORT = 15434
const PG_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/e2e_wm`
const WM_PORT = 25080
const CONTAINER_URL = process.env.CONTAINER_URL || "http://127.0.0.1:8888"

let client: WorkspaceManagerClient
let server: Server
let podClient: PodClient
const createdContainers: string[] = []
const createdVolumes: string[] = []

beforeAll(async () => {
  let migrated = false
  for (let i = 0; i < 10; i++) {
    try { await autoMigrate(PG_URL); migrated = true; break } catch { await new Promise(r => setTimeout(r, 1000)) }
  }
  if (!migrated) throw new Error("autoMigrate failed after 10 retries")

  const db = openDB(PG_URL)
  podClient = new PodmanPodClient(CONTAINER_URL)

  const handler = connectNodeAdapter({
    routes: createWorkspaceManagerRouter(db, podClient),
  })

  server = createServer(handler)
  server.listen(WM_PORT)
  await new Promise(r => setTimeout(r, 100))

  client = new WorkspaceManagerClient({
    baseURL: `http://localhost:${WM_PORT}`,
    token: "",
  })
}, 30_000)

afterAll(async () => {
  for (const name of createdContainers) {
    try { await podClient.stopPod(name) } catch {}
    try { await podClient.removePod(name) } catch {}
  }
  for (const name of createdVolumes) {
    try { await podClient.removeVolume(name) } catch {}
  }
  server?.close()
}, 30_000)

describe("Workspace Manager E2E — Real Podman", () => {
  test("create workspace creates real Podman volume", async () => {
    const sessionId = randomUUID()
    const result = await client.createWorkspace(sessionId)
    if (result.isErr()) console.error("createWorkspace ERR:", result.error)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.workspaceId).toBeTruthy()
    expect(result.value.volumeName).toBeTruthy()
    createdVolumes.push(result.value.volumeName)

    console.log(`[e2e] volume ${result.value.volumeName} created`)

    const ws = await client.getWorkspace(result.value.workspaceId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return
    expect(ws.value.state).toBe("active")
  }, 30_000)

  test("start worker creates and starts real container", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    if (ws.isErr()) console.error("createWorkspace ERR:", ws.error)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return
    createdVolumes.push(ws.value.volumeName)

    const result = await client.startWorker({
      sessionId,
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "infinity"],
      env: { TEST_MODE: "e2e" },
      volumes: [{ name: ws.value.volumeName, destination: "/data/workspace" }],
    })
    if (result.isErr()) console.error("startWorker ERR:", result.error)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.workerId).toBeTruthy()
    expect(result.value.containerName).toBeTruthy()
    expect(result.value.secret).toBeTruthy()
    createdContainers.push(result.value.containerName)

    console.log(`[e2e] worker container ${result.value.containerName} started`)

    const info = await podClient.inspectPod(result.value.containerName)
    expect(info.state).toBe("running")
  }, 30_000)

  test("stop worker stops and removes real container", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return
    createdVolumes.push(ws.value.volumeName)

    const worker = await client.startWorker({
      sessionId,
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "infinity"],
      env: {},
      volumes: [{ name: ws.value.volumeName, destination: "/data/workspace" }],
    })
    if (worker.isErr()) console.error("startWorker ERR:", worker.error)
    expect(worker.isOk()).toBe(true)
    if (!worker.isOk()) return
    createdContainers.push(worker.value.containerName)

    const infoBefore = await podClient.inspectPod(worker.value.containerName)
    expect(infoBefore.state).toBe("running")

    const stopResult = await client.stopWorker(worker.value.workerId)
    expect(stopResult.isOk()).toBe(true)

    const status = await client.getWorkerStatus(worker.value.workerId)
    expect(status.isOk()).toBe(true)
    if (!status.isOk()) return
    expect(status.value.state).toBe("stopped")

    console.log(`[e2e] worker ${worker.value.containerName} stopped`)
  }, 30_000)

  test("delete workspace removes real Podman volume", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const del = await client.deleteWorkspace(ws.value.workspaceId)
    expect(del.isOk()).toBe(true)

    console.log(`[e2e] workspace ${ws.value.volumeName} deleted`)
  }, 30_000)

  test("full lifecycle: workspace → worker → stop → delete", async () => {
    const sessionId = randomUUID()

    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const worker = await client.startWorker({
      sessionId,
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "infinity"],
      env: { HELLO: "world" },
      volumes: [{ name: ws.value.volumeName, destination: "/data/workspace" }],
    })
    if (worker.isErr()) console.error("startWorker ERR:", worker.error)
    expect(worker.isOk()).toBe(true)
    if (!worker.isOk()) return
    createdContainers.push(worker.value.containerName)

    const info = await podClient.inspectPod(worker.value.containerName)
    expect(info.state).toBe("running")

    await client.stopWorker(worker.value.workerId)

    const status = await client.getWorkerStatus(worker.value.workerId)
    expect(status.isOk()).toBe(true)
    if (!status.isOk()) return
    expect(status.value.state).toBe("stopped")

    await client.deleteWorkspace(ws.value.workspaceId)

    console.log(`[e2e] full lifecycle complete for session ${sessionId}`)
  }, 30_000)
})
