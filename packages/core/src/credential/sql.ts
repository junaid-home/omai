import { encryptedJson } from "../database/secrets"
import { text, boolean, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps, namespace } from "../database/schema.sql"
import type { Credential } from "../credential"

export const CredentialTable = namespace.table(
  "credential",
  {
    id: text().$type<Credential.ID>().primaryKey(),
    integration_id: text().$type<Credential.Info["integrationID"]>(),
    label: text().notNull(),
    value: encryptedJson("credential", "value").$type<Credential.Value>().notNull(),
    connector_id: text(),
    method_id: text(),
    active: boolean(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("credential_integration_unique").on(table.integration_id)],
)
