import { text } from "drizzle-orm/pg-core"
import { Timestamps, namespace } from "../database/schema.sql"

// Project preview screenshots, keyed by project directory. MicroVM projects
// keep their files on the VM's own volume, which the control plane cannot
// read (and which is unavailable while the VM is paused); the shared database
// is the one place both sides can reach.
export const ProjectThumbnailTable = namespace.table("project_thumbnail", {
  directory: text().primaryKey(),
  // Base64-encoded PNG.
  png: text().notNull(),
  ...Timestamps,
})
