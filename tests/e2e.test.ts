import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { WorkspaceManagerClient } from "@openzerg/common"
import { PodmanCompose, waitForPort } from "../../openzerg/e2e/compose-helper.js"
import { openDB, autoMigrate } from "../src/db.js"
import { createWorkspaceManagerRouter } from "../src/router.js"
import type { PodClient } from "@openzerg/common/pod-client"
import { randomUUID } from "node:crypto"

const PG_PORT = 15434
const PG_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/e2e_wm`
const WM_PORT = 25079

const compose = new PodmanCompose({
  projectName: "wm",
  composeFile: import.meta.dir + "/compose.yaml",
})

let client: WorkspaceManagerClient
let server: Server

function createMockPodClient(): PodClient {
  const volumes = new Set<string>()
  const pods = new Map<string, { name: string; state: string }>()

  return {
    createPod: async (spec) => {
      const id = randomUUID()
      pods.set(spec.name, { name: spec.name, state: "created" })
      return id
    },
    startPod: async (nameOrId: string) => {
      const p = pods.get(nameOrId)
      if (p) p.state = "running"
    },
    stopPod: async (nameOrId: string) => {
      const p = pods.get(nameOrId)
      if (p) p.state = "stopped"
    },
    removePod: async (nameOrId: string) => {
      pods.delete(nameOrId)
    },
    inspectPod: async (nameOrId: string) => {
      const p = pods.get(nameOrId)
      return {
        id: nameOrId,
        name: nameOrId,
        state: p?.state ?? "unknown",
        containers: [],
      }
    },
    listPods: async () => [],
    createVolume: async (name: string) => { volumes.add(name) },
    removeVolume: async (name: string) => { volumes.delete(name) },
  }
}

beforeAll(async () => {
  await compose.up(["postgres"])
  await waitForPort(PG_PORT, 30_000)

  let migrated = false
  for (let i = 0; i < 10; i++) {
    try { await autoMigrate(PG_URL); migrated = true; break } catch { await new Promise(r => setTimeout(r, 1000)) }
  }
  if (!migrated) throw new Error("autoMigrate failed after 10 retries")

  const db = openDB(PG_URL)
  const podman = createMockPodClient()

  const handler = connectNodeAdapter({
    routes: createWorkspaceManagerRouter(db, podman),
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
  server?.close()
  await compose.down()
})

describe("Workspace Manager E2E", () => {
  test("health check", async () => {
    const result = await client.health()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.status).toBe("ok")
    }
  })

  test("create and list workspaces", async () => {
    const sessionId = randomUUID()
    const created = await client.createWorkspace(sessionId)
    expect(created.isOk()).toBe(true)
    if (!created.isOk()) return
    expect(created.value.workspaceId).toBeTruthy()
    expect(created.value.volumeName).toBeTruthy()

    const listResult = await client.listWorkspaces()
    expect(listResult.isOk()).toBe(true)
    if (!listResult.isOk()) return
    expect(listResult.value.workspaces.length).toBeGreaterThanOrEqual(1)

    const ws = listResult.value.workspaces.find(w => w.workspaceId === created.value.workspaceId)
    expect(ws).toBeDefined()
    expect(ws!.createdBySessionId).toBe(sessionId)
  })

  test("get workspace by ID", async () => {
    const sessionId = randomUUID()
    const created = await client.createWorkspace(sessionId)
    expect(created.isOk()).toBe(true)
    if (!created.isOk()) return

    const getResult = await client.getWorkspace(created.value.workspaceId)
    expect(getResult.isOk()).toBe(true)
    if (!getResult.isOk()) return
    expect(getResult.value.workspaceId).toBe(created.value.workspaceId)
    expect(getResult.value.state).toBe("active")
  })

  test("delete workspace", async () => {
    const sessionId = randomUUID()
    const created = await client.createWorkspace(sessionId)
    expect(created.isOk()).toBe(true)
    if (!created.isOk()) return

    const delResult = await client.deleteWorkspace(created.value.workspaceId)
    expect(delResult.isOk()).toBe(true)

    const listResult = await client.listWorkspaces()
    expect(listResult.isOk()).toBe(true)
    if (!listResult.isOk()) return
    const found = listResult.value.workspaces.find(w => w.workspaceId === created.value.workspaceId)
    expect(found).toBeUndefined()
  })

  test("start and list workers", async () => {
    const sessionId = randomUUID()
    const wsResult = await client.createWorkspace(sessionId)
    expect(wsResult.isOk()).toBe(true)
    if (!wsResult.isOk()) return

    const workerResult = await client.startWorker({
      sessionId,
      image: "localhost/openzerg/worker:latest",
      env: { TEST: "true" },
      volumes: [{ name: wsResult.value.volumeName, destination: "/data/workspace" }],
    })
    expect(workerResult.isOk()).toBe(true)
    if (!workerResult.isOk()) return
    expect(workerResult.value.workerId).toBeTruthy()
    expect(workerResult.value.containerName).toBeTruthy()
    expect(workerResult.value.secret).toBeTruthy()

    const listResult = await client.listWorkers()
    expect(listResult.isOk()).toBe(true)
    if (!listResult.isOk()) return
    expect(listResult.value.workers.length).toBeGreaterThanOrEqual(1)

    const w = listResult.value.workers.find(wk => wk.workerId === workerResult.value.workerId)
    expect(w).toBeDefined()
    expect(w!.state).toBe("running")
  })

  test("stop worker", async () => {
    const sessionId = randomUUID()
    const wsResult = await client.createWorkspace(sessionId)
    expect(wsResult.isOk()).toBe(true)
    if (!wsResult.isOk()) return

    const workerResult = await client.startWorker({
      sessionId,
      image: "localhost/openzerg/worker:latest",
      env: {},
      volumes: [{ name: wsResult.value.volumeName, destination: "/data/workspace" }],
    })
    expect(workerResult.isOk()).toBe(true)
    if (!workerResult.isOk()) return

    const stopResult = await client.stopWorker(workerResult.value.workerId)
    expect(stopResult.isOk()).toBe(true)

    const statusResult = await client.getWorkerStatus(workerResult.value.workerId)
    expect(statusResult.isOk()).toBe(true)
    if (!statusResult.isOk()) return
    expect(statusResult.value.state).toBe("stopped")
  })

  test("full workspace + worker lifecycle", async () => {
    const sessionId = randomUUID()

    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const worker = await client.startWorker({
      sessionId,
      image: "localhost/openzerg/worker:latest",
      env: {},
      volumes: [{ name: ws.value.volumeName, destination: "/data/workspace" }],
    })
    expect(worker.isOk()).toBe(true)
    if (!worker.isOk()) return

    await client.stopWorker(worker.value.workerId)
    await client.deleteWorkspace(ws.value.workspaceId)

    const list = await client.listWorkspaces()
    expect(list.isOk()).toBe(true)
    if (!list.isOk()) return
    const found = list.value.workspaces.find(w => w.workspaceId === ws.value.workspaceId)
    expect(found).toBeUndefined()
  })

  test("ensureWorkspaceWorker creates new worker for workspace", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const result = await client.ensureWorkspaceWorker({
      workspaceId: ws.value.workspaceId,
      image: "localhost/openzerg/worker:latest",
      env: { TEST: "ensure" },
    })
    expect(result.isOk()).toBe(true)
    if (!result.isErr()) {
      expect(result.value.workerId).toBeTruthy()
      expect(result.value.containerName).toBeTruthy()
      expect(result.value.secret).toBeTruthy()
      expect(result.value.volumeName).toBe(ws.value.volumeName)
    }

    const workers = await client.listWorkers()
    expect(workers.isOk()).toBe(true)
    if (!workers.isOk()) return
    const w = workers.value.workers.find(wk => wk.workspaceId === ws.value.workspaceId)
    expect(w).toBeDefined()
    expect(w!.state).toBe("running")
  })

  test("ensureWorkspaceWorker is idempotent — returns existing worker", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const first = await client.ensureWorkspaceWorker({
      workspaceId: ws.value.workspaceId,
      image: "localhost/openzerg/worker:latest",
    })
    expect(first.isOk()).toBe(true)
    if (!first.isOk()) return

    const second = await client.ensureWorkspaceWorker({
      workspaceId: ws.value.workspaceId,
      image: "localhost/openzerg/worker:latest",
    })
    expect(second.isOk()).toBe(true)
    if (!second.isOk()) return

    expect(second.value.workerId).toBe(first.value.workerId)
    expect(second.value.containerName).toBe(first.value.containerName)
    expect(second.value.secret).toBe(first.value.secret)

    const workers = await client.listWorkers()
    expect(workers.isOk()).toBe(true)
    if (!workers.isOk()) return
    const matching = workers.value.workers.filter(wk => wk.workspaceId === ws.value.workspaceId && wk.state === "running")
    expect(matching.length).toBe(1)
  })

  test("updateWorkspaceConfig updates skillSlugs and nixPkgs", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const updateResult = await client.updateWorkspaceConfig({
      workspaceId: ws.value.workspaceId,
      skillSlugs: JSON.stringify(["python-helper", "web-scraper"]),
      nixPkgs: JSON.stringify(["python3", "nodejs"]),
    })
    expect(updateResult.isOk()).toBe(true)

    const fetched = await client.getWorkspace(ws.value.workspaceId)
    expect(fetched.isOk()).toBe(true)
    if (!fetched.isOk()) return
    expect(fetched.value.skillSlugs).toBe(JSON.stringify(["python-helper", "web-scraper"]))
    expect(fetched.value.nixPkgs).toBe(JSON.stringify(["python3", "nodejs"]))
  })

  test("deleteWorkspace stops and removes associated worker", async () => {
    const sessionId = randomUUID()
    const ws = await client.createWorkspace(sessionId)
    expect(ws.isOk()).toBe(true)
    if (!ws.isOk()) return

    const worker = await client.ensureWorkspaceWorker({
      workspaceId: ws.value.workspaceId,
      image: "localhost/openzerg/worker:latest",
    })
    expect(worker.isOk()).toBe(true)
    if (!worker.isOk()) return

    const delResult = await client.deleteWorkspace(ws.value.workspaceId)
    expect(delResult.isOk()).toBe(true)

    const statusResult = await client.getWorkerStatus(worker.value.workerId)
    expect(statusResult.isOk()).toBe(true)
    if (!statusResult.isOk()) return
    expect(statusResult.value.state).toBe("stopped")
  })
})
