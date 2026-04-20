import type { DB } from "../db.js"
import type { PodClient } from "@openzerg/pod-client"
import { randomUUID } from "node:crypto"

const now = () => BigInt(Date.now())

function shortId(): string {
  return randomUUID().split("-")[0]
}

export function createWorkspaceHandlers(db: DB, podClient: PodClient) {
  return {
    async createWorkspace(req: { sessionId: string }) {
      const id = randomUUID()
      const volumeName = `ws-${shortId()}`
      await podClient.createVolume(volumeName)
      const ts = now()
      await db.insertInto("wm_workspaces").values({
        id,
        volumeName,
        state: "active",
        createdBySessionId: req.sessionId,
        workerPodName: "",
        skillSlugs: "[]",
        nixPkgs: "[]",
        createdAt: ts,
        updatedAt: ts,
      }).execute()
      return { workspaceId: id, volumeName }
    },

    async listWorkspaces(_req: unknown) {
      const rows = await db.selectFrom("wm_workspaces")
        .selectAll()
        .orderBy("createdAt", "desc")
        .execute()
      const workspaces = rows.map(r => ({
        workspaceId: r.id,
        volumeName: r.volumeName,
        state: r.state,
        createdBySessionId: r.createdBySessionId,
        createdAt: r.createdAt,
        workerPodName: r.workerPodName,
        skillSlugs: r.skillSlugs,
        nixPkgs: r.nixPkgs,
      }))
      return { workspaces }
    },

    async getWorkspace(req: { workspaceId: string }) {
      const row = await db.selectFrom("wm_workspaces")
        .selectAll()
        .where("id", "=", req.workspaceId)
        .executeTakeFirstOrThrow(() => new Error(`workspace ${req.workspaceId} not found`))
      return {
        workspaceId: row.id,
        volumeName: row.volumeName,
        state: row.state,
        createdBySessionId: row.createdBySessionId,
        createdAt: row.createdAt,
        workerPodName: row.workerPodName,
        skillSlugs: row.skillSlugs,
        nixPkgs: row.nixPkgs,
      }
    },

    async deleteWorkspace(req: { workspaceId: string }) {
      const row = await db.selectFrom("wm_workspaces")
        .selectAll()
        .where("id", "=", req.workspaceId)
        .executeTakeFirstOrThrow(() => new Error(`workspace ${req.workspaceId} not found`))

      if (row.workerPodName) {
        try { await podClient.stopPod(row.workerPodName) } catch {}
        try { await podClient.removePod(row.workerPodName) } catch {}
      }

      await db.updateTable("wm_workers")
        .set({ state: "stopped", updatedAt: now() })
        .where("workspaceId", "=", req.workspaceId)
        .execute()

      try {
        await podClient.removeVolume(row.volumeName)
      } catch {}
      await db.deleteFrom("wm_workspaces").where("id", "=", req.workspaceId).execute()
      return {}
    },
  }
}
