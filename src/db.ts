import postgres from "postgres"
import { Kysely } from "kysely"
import { PostgresJSDialect } from "kysely-postgres-js"
import type { Database } from "@openzerg/common/entities/kysely-database.js"

export type DB = Kysely<Database>

export function openDB(databaseURL: string): DB {
  const pg = postgres(databaseURL)
  return new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: pg }),
  })
}

export async function autoMigrate(databaseURL: string): Promise<void> {
  const db = openDB(databaseURL)
  try {
    await db.schema.createTable("wm_workspaces")
      .ifNotExists()
      .addColumn("id", "text", c => c.notNull().primaryKey())
      .addColumn("volumeName", "text", c => c.notNull())
      .addColumn("state", "text", c => c.notNull().defaultTo("creating"))
      .addColumn("createdBySessionId", "text", c => c.notNull().defaultTo(""))
      .addColumn("workerPodName", "text", c => c.notNull().defaultTo(""))
      .addColumn("skillSlugs", "text", c => c.notNull().defaultTo("[]"))
      .addColumn("nixPkgs", "text", c => c.notNull().defaultTo("[]"))
      .addColumn("createdAt", "bigint", c => c.notNull())
      .addColumn("updatedAt", "bigint", c => c.notNull())
      .execute()

    await db.schema.createIndex("idx_wm_workspaces_state").ifNotExists()
      .on("wm_workspaces").column("state").execute()
    await db.schema.createIndex("idx_wm_workspaces_createdBySessionId").ifNotExists()
      .on("wm_workspaces").column("createdBySessionId").execute()

    await db.schema.createTable("wm_workers")
      .ifNotExists()
      .addColumn("id", "text", c => c.notNull().primaryKey())
      .addColumn("sessionId", "text", c => c.notNull())
      .addColumn("containerName", "text", c => c.notNull())
      .addColumn("image", "text", c => c.notNull())
      .addColumn("state", "text", c => c.notNull().defaultTo("creating"))
      .addColumn("podmanId", "text", c => c.notNull().defaultTo(""))
      .addColumn("secret", "text", c => c.notNull().defaultTo(""))
      .addColumn("workspaceRoot", "text", c => c.notNull().defaultTo("/data/workspace"))
      .addColumn("filesystemUrl", "text", c => c.notNull().defaultTo(""))
      .addColumn("executionUrl", "text", c => c.notNull().defaultTo(""))
      .addColumn("workspaceId", "text", c => c.notNull().defaultTo(""))
      .addColumn("createdAt", "bigint", c => c.notNull())
      .addColumn("updatedAt", "bigint", c => c.notNull())
      .execute()

    await db.schema.createIndex("idx_wm_workers_sessionId").ifNotExists()
      .on("wm_workers").column("sessionId").execute()
    await db.schema.createIndex("idx_wm_workers_state").ifNotExists()
      .on("wm_workers").column("state").execute()
    await db.schema.createIndex("idx_wm_workers_containerName").ifNotExists()
      .on("wm_workers").column("containerName").execute()

    console.log("[workspace-manager] database ready")
  } finally {
    await db.destroy()
  }
}
