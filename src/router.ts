import type { ConnectRouter } from "@connectrpc/connect"
import { WorkspaceManagerService } from "@openzerg/common/gen/workspacemanager/v1_pb.js"
import type { DB } from "./db.js"
import type { PodClient } from "@openzerg/common/pod-client"
import { createWorkspaceHandlers } from "./handlers/workspace.js"
import { createWorkerHandlers } from "./handlers/worker.js"

export function createWorkspaceManagerRouter(db: DB, podClient: PodClient) {
  const workspace = createWorkspaceHandlers(db, podClient)
  const worker = createWorkerHandlers(db, podClient)

  return (router: ConnectRouter) => {
    router.service(WorkspaceManagerService, {
      health: async () => ({ status: "ok" }),
      createWorkspace: workspace.createWorkspace,
      listWorkspaces: workspace.listWorkspaces,
      getWorkspace: workspace.getWorkspace,
      deleteWorkspace: workspace.deleteWorkspace,
      startWorker: worker.startWorker,
      stopWorker: worker.stopWorker,
      getWorkerStatus: worker.getWorkerStatus,
      listWorkers: worker.listWorkers,
      ensureWorkspaceWorker: worker.ensureWorkspaceWorker,
      updateWorkspaceConfig: worker.updateWorkspaceConfig,
    })
  }
}
