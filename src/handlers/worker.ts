import type { GelClient } from "@openzerg/common/gel"
import type { PodClient, HostMount } from "@openzerg/common/pod-client"
import { gelQuery, unwrap } from "@openzerg/common/gel"
import { ok, err } from "neverthrow"
import { NotFoundError } from "@openzerg/common"
import { randomUUID } from "node:crypto"
import {
  insertWorker,
  getWorkerForStop,
  stopWorkerById,
  getWorkerStatus,
  listAllWorkers,
  getWorkspaceForEnsure,
  getRunningWorkerForWorkspace,
  updateWorkspacePodName,
  getWorkspaceById,
  updateWorkspaceConfig,
} from "@openzerg/common/queries"

function shortId(): string {
  return randomUUID().split("-")[0]
}

function parseJsonArray(val: string): string[] {
  try { return JSON.parse(val) } catch { return [] }
}

export function createWorkerHandlers(gel: GelClient, podClient: PodClient) {
  return {
    startWorker(req: {
      sessionId: string
      image: string
      env: { [key: string]: string }
      volumes: Array<{ name: string; destination: string }>
      command?: string[]
    }) {
      const podName = `worker-${shortId()}`
      const secret = randomUUID()
      const ts = BigInt(Math.floor(Date.now() / 1000))
      const workspaceRoot = req.volumes.length > 0 ? req.volumes[0].destination : "/data/workspace"

      return unwrap(
        podClient.createPod({
          name: podName,
          labels: { "managed-by": "wm" },
          containers: [{
            name: podName,
            image: req.image,
            command: req.command,
            env: { WORKER_SECRET: secret, ...req.env },
            volumeMounts: req.volumes.map(v => ({ name: v.name, destination: v.destination })),
          }],
        }).andThen((podId) =>
          podClient.startPod(podName).map(() => podId),
        ).andThen((podId) =>
          gelQuery(() => insertWorker(gel, {
            sessionId: req.sessionId,
            containerName: podName,
            image: req.image,
            podmanId: podId,
            secret,
            workspaceRoot,
            workspaceId: "",
            createdAt: Number(ts),
            updatedAt: Number(ts),
          })),
        ).map((row) => ({ workerId: row.id, containerName: row.containerName, secret: row.secret })),
      )
    },

    stopWorker(req: { workerId: string }) {
      return unwrap(
        gelQuery(() => getWorkerForStop(gel, { id: req.workerId })).andThen((row) => {
          if (!row) return err(new NotFoundError(`worker ${req.workerId} not found`))

          const ts = BigInt(Math.floor(Date.now() / 1000))

          return podClient.stopPod(row.containerName)
            .andThen(() => podClient.removePod(row.containerName))
            .andThen(() => gelQuery(() => stopWorkerById(gel, { id: req.workerId, updatedAt: Number(ts) })))
            .map(() => ({}))
        }),
      )
    },

    getWorkerStatus(req: { workerId: string }) {
      return unwrap(
        gelQuery(() => getWorkerStatus(gel, { id: req.workerId })).andThen((row) => {
          if (!row) return err(new NotFoundError(`worker ${req.workerId} not found`))
          return ok({ state: row.state, containerId: row.podmanId })
        }),
      )
    },

    listWorkers(_req: unknown) {
      return unwrap(
        gelQuery(() => listAllWorkers(gel)).map((rows) => ({
          workers: rows.map(r => ({
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
            createdAt: BigInt(r.createdAt),
            workspaceId: r.workspaceId,
          })),
        })),
      )
    },

    ensureWorkspaceWorker(req: {
      workspaceId: string
      image: string
      env: { [key: string]: string }
    }) {
      return unwrap(
        gelQuery(() => getWorkspaceForEnsure(gel, { id: req.workspaceId })).andThen((ws) => {
          if (!ws) return err(new NotFoundError(`workspace ${req.workspaceId} not found`))

          return gelQuery(() => getRunningWorkerForWorkspace(gel, { workspaceId: req.workspaceId })).andThen((existing) => {
            if (existing) {
              return ok({
                workerId: existing.id,
                containerName: existing.containerName,
                secret: existing.secret,
                volumeName: ws.volumeName,
              })
            }

            const podName = `worker-${shortId()}`
            const secret = randomUUID()
            const ts = BigInt(Math.floor(Date.now() / 1000))

            const skillSlugs = parseJsonArray(ws.skillSlugs)
            const hostMounts: HostMount[] = skillSlugs.map(slug => ({
              hostPath: `/var/lib/openzerg/skills/${slug}`,
              containerPath: `/skills/${slug}`,
              readOnly: true,
            }))

            return podClient.createPod({
              name: podName,
              labels: { "managed-by": "wm", "workspace-id": req.workspaceId },
              containers: [{
                name: podName,
                image: req.image,
                env: { WORKER_SECRET: secret, ...req.env },
                volumeMounts: [{ name: ws.volumeName, destination: "/data/workspace" }],
              }],
              hostMounts: hostMounts.length > 0 ? hostMounts : undefined,
            }).andThen((podId) =>
              podClient.startPod(podName).map(() => podId),
            ).andThen((podId) =>
              gelQuery(() => insertWorker(gel, {
                sessionId: ws.createdBySessionId,
                containerName: podName,
                image: req.image,
                podmanId: podId,
                secret,
                workspaceRoot: "data/workspace",
                workspaceId: req.workspaceId,
                createdAt: Number(ts),
                updatedAt: Number(ts),
              })),
            ).andThen((row) =>
              gelQuery(() => updateWorkspacePodName(gel, {
                id: req.workspaceId,
                workerPodName: podName,
                updatedAt: Number(ts),
              })).map(() => ({
                workerId: row.id,
                containerName: row.containerName,
                secret: row.secret,
                volumeName: ws.volumeName,
              })),
            )
          })
        }),
      )
    },

    updateWorkspaceConfig(req: {
      workspaceId: string
      skillSlugs: string
      nixPkgs: string
    }) {
      const ts = BigInt(Math.floor(Date.now() / 1000))
      return unwrap(
        gelQuery(() => getWorkspaceById(gel, { id: req.workspaceId })).andThen((ws) => {
          if (!ws) return err(new NotFoundError(`workspace ${req.workspaceId} not found`))

          return gelQuery(() => updateWorkspaceConfig(gel, {
            id: req.workspaceId,
            skillSlugs: req.skillSlugs,
            nixPkgs: req.nixPkgs,
            updatedAt: Number(ts),
          })).map(() => ({}))
        }),
      )
    },
  }
}
