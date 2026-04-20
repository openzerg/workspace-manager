import type { DB } from "../db.js"
import type { PodClient, HostMount } from "@openzerg/common/pod-client"
import { randomUUID } from "node:crypto"

const now = () => BigInt(Date.now())

function shortId(): string {
  return randomUUID().split("-")[0]
}

function parseJsonArray(val: string): string[] {
  try { return JSON.parse(val) } catch { return [] }
}

export function createWorkerHandlers(db: DB, podClient: PodClient) {
  return {
    async startWorker(req: {
      sessionId: string
      image: string
      env: { [key: string]: string }
      volumes: Array<{ name: string; destination: string }>
      command?: string[]
    }) {
      const id = randomUUID()
      const podName = `worker-${shortId()}`
      const secret = randomUUID()
      const ts = now()

      const workspaceRoot = req.volumes.length > 0 ? req.volumes[0].destination : "/data/workspace"

      const podId = await podClient.createPod({
        name: podName,
        labels: { "managed-by": "wm" },
        containers: [{
          name: podName,
          image: req.image,
          command: req.command,
          env: { WORKER_SECRET: secret, ...req.env },
          volumeMounts: req.volumes.map(v => ({ name: v.name, destination: v.destination })),
        }],
      })
      await podClient.startPod(podName)

      await db.insertInto("wm_workers").values({
        id,
        sessionId: req.sessionId,
        containerName: podName,
        image: req.image,
        state: "running",
        podmanId: podId,
        secret,
        workspaceRoot,
        filesystemUrl: "",
        executionUrl: "",
        workspaceId: "",
        createdAt: ts,
        updatedAt: ts,
      }).execute()

      return { workerId: id, containerName: podName, secret }
    },

    async stopWorker(req: { workerId: string }) {
      const row = await db.selectFrom("wm_workers")
        .selectAll()
        .where("id", "=", req.workerId)
        .executeTakeFirstOrThrow(() => new Error(`worker ${req.workerId} not found`))

      try { await podClient.stopPod(row.containerName) } catch {}
      try { await podClient.removePod(row.containerName) } catch {}

      await db.updateTable("wm_workers")
        .set({ state: "stopped", updatedAt: now() })
        .where("id", "=", req.workerId)
        .execute()

      return {}
    },

    async getWorkerStatus(req: { workerId: string }) {
      const row = await db.selectFrom("wm_workers")
        .selectAll()
        .where("id", "=", req.workerId)
        .executeTakeFirstOrThrow(() => new Error(`worker ${req.workerId} not found`))
      return { state: row.state, containerId: row.podmanId }
    },

    async listWorkers(_req: unknown) {
      const rows = await db.selectFrom("wm_workers")
        .selectAll()
        .orderBy("createdAt", "desc")
        .execute()
      const workers = rows.map(r => ({
        workerId: r.id,
        sessionId: r.sessionId,
        containerName: r.containerName,
        image: r.image,
        state: r.state,
        podmanId: r.podmanId,
        secret: r.secret,
        workspaceRoot: r.workspaceRoot,
        filesystemUrl: r.filesystemUrl,
        executionUrl: r.executionUrl,
        createdAt: r.createdAt,
        workspaceId: r.workspaceId,
      }))
      return { workers }
    },

    async ensureWorkspaceWorker(req: {
      workspaceId: string
      image: string
      env: { [key: string]: string }
    }) {
      const ws = await db.selectFrom("wm_workspaces")
        .selectAll()
        .where("id", "=", req.workspaceId)
        .executeTakeFirstOrThrow(() => new Error(`workspace ${req.workspaceId} not found`))

      const existing = await db.selectFrom("wm_workers")
        .selectAll()
        .where("workspaceId", "=", req.workspaceId)
        .where("state", "=", "running")
        .executeTakeFirst()

      if (existing) {
        return {
          workerId: existing.id,
          containerName: existing.containerName,
          secret: existing.secret,
          volumeName: ws.volumeName,
        }
      }

      const id = randomUUID()
      const podName = `worker-${shortId()}`
      const secret = randomUUID()
      const ts = now()

      const skillSlugs = parseJsonArray(ws.skillSlugs)
      const hostMounts: HostMount[] = skillSlugs.map(slug => ({
        hostPath: `/var/lib/openzerg/skills/${slug}`,
        containerPath: `/skills/${slug}`,
        readOnly: true,
      }))

      const podId = await podClient.createPod({
        name: podName,
        labels: { "managed-by": "wm", "workspace-id": req.workspaceId },
        containers: [{
          name: podName,
          image: req.image,
          env: { WORKER_SECRET: secret, ...req.env },
          volumeMounts: [{ name: ws.volumeName, destination: "/data/workspace" }],
        }],
        hostMounts: hostMounts.length > 0 ? hostMounts : undefined,
      })
      await podClient.startPod(podName)

      await db.insertInto("wm_workers").values({
        id,
        sessionId: ws.createdBySessionId,
        containerName: podName,
        image: req.image,
        state: "running",
        podmanId: podId,
        secret,
        workspaceRoot: "/data/workspace",
        filesystemUrl: "",
        executionUrl: "",
        workspaceId: req.workspaceId,
        createdAt: ts,
        updatedAt: ts,
      }).execute()

      await db.updateTable("wm_workspaces")
        .set({ workerPodName: podName, updatedAt: now() })
        .where("id", "=", req.workspaceId)
        .execute()

      return { workerId: id, containerName: podName, secret, volumeName: ws.volumeName }
    },

    async updateWorkspaceConfig(req: {
      workspaceId: string
      skillSlugs: string
      nixPkgs: string
    }) {
      await db.selectFrom("wm_workspaces")
        .selectAll()
        .where("id", "=", req.workspaceId)
        .executeTakeFirstOrThrow(() => new Error(`workspace ${req.workspaceId} not found`))

      await db.updateTable("wm_workspaces")
        .set({
          skillSlugs: req.skillSlugs,
          nixPkgs: req.nixPkgs,
          updatedAt: now(),
        })
        .where("id", "=", req.workspaceId)
        .execute()

      return {}
    },
  }
}
