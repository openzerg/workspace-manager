import type { GelClient } from "@openzerg/common/gel"
import type { PodClient } from "@openzerg/common/pod-client"
import { gelQuery, unwrap } from "@openzerg/common/gel"
import { ok, err } from "neverthrow"
import { NotFoundError } from "@openzerg/common"
import { randomUUID } from "node:crypto"
import {
  insertWorkspace,
  listAllWorkspaces,
  getWorkspaceById,
  getWorkspaceForDelete,
  stopWorkersForWorkspace,
  deleteWorkspaceById,
} from "@openzerg/common/queries"

function shortId(): string {
  return randomUUID().split("-")[0]
}

export function createWorkspaceHandlers(gel: GelClient, podClient: PodClient) {
  return {
    createWorkspace(req: { sessionId: string }) {
      const volumeName = `ws-${shortId()}`
      const ts = BigInt(Math.floor(Date.now() / 1000))
      return unwrap(
        podClient.createVolume(volumeName).andThen(() =>
          gelQuery(() => insertWorkspace(gel, {
            volumeName,
            createdBySessionId: req.sessionId,
            createdAt: Number(ts),
            updatedAt: Number(ts),
          })),
        ).map((row) => ({ workspaceId: row.id, volumeName: row.volumeName })),
      )
    },

    listWorkspaces(_req: unknown) {
      return unwrap(
        gelQuery(() => listAllWorkspaces(gel)).map((rows) => ({
          workspaces: rows.map(r => ({
            workspaceId: r.id,
            volumeName: r.volumeName,
            state: r.state,
            createdBySessionId: r.createdBySessionId,
            createdAt: BigInt(r.createdAt),
            workerPodName: r.workerPodName,
            skillSlugs: r.skillSlugs,
            nixPkgs: r.nixPkgs,
          })),
        })),
      )
    },

    getWorkspace(req: { workspaceId: string }) {
      return unwrap(
        gelQuery(() => getWorkspaceById(gel, { id: req.workspaceId })).andThen((row) => {
          if (!row) return err(new NotFoundError(`workspace ${req.workspaceId} not found`))
          return ok({
            workspaceId: row.id,
            volumeName: row.volumeName,
            state: row.state,
            createdBySessionId: row.createdBySessionId,
            createdAt: BigInt(row.createdAt),
            workerPodName: row.workerPodName,
            skillSlugs: row.skillSlugs,
            nixPkgs: row.nixPkgs,
          })
        }),
      )
    },

    deleteWorkspace(req: { workspaceId: string }) {
      return unwrap(
        gelQuery(() => getWorkspaceForDelete(gel, { id: req.workspaceId })).andThen((row) => {
          if (!row) return err(new NotFoundError(`workspace ${req.workspaceId} not found`))

          const ts = BigInt(Math.floor(Date.now() / 1000))

          return gelQuery(() => stopWorkersForWorkspace(gel, {
            workspaceId: req.workspaceId,
            updatedAt: Number(ts),
          })).andThen(() =>
            row.workerPodName
              ? podClient.stopPod(row.workerPodName)
                  .andThen(() => podClient.removePod(row.workerPodName))
              : ok(undefined),
          ).andThen(() =>
            podClient.removeVolume(row.volumeName),
          ).andThen(() =>
            gelQuery(() => deleteWorkspaceById(gel, { id: req.workspaceId })),
          )
            .map(() => ({}))
        }),
      )
    },
  }
}
