import { encryptedText } from "../database/secrets"
import { text, primaryKey, boolean } from "drizzle-orm/pg-core"

import { AccountV2 } from "../account"
import { Timestamps, namespace, safeInteger } from "../database/schema.sql"

export const AccountTable = namespace.table("account", {
  id: text().$type<AccountV2.ID>().primaryKey(),
  email: text().notNull(),
  url: text().notNull(),
  access_token: encryptedText("account", "access_token").$type<AccountV2.AccessToken>().notNull(),
  refresh_token: encryptedText("account", "refresh_token").$type<AccountV2.RefreshToken>().notNull(),
  token_expiry: safeInteger(),
  ...Timestamps,
})

export const AccountStateTable = namespace.table("account_state", {
  id: safeInteger().primaryKey(),
  active_account_id: text()
    .$type<AccountV2.ID>()
    .references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: text().$type<AccountV2.OrgID>(),
})

// LEGACY
export const ControlAccountTable = namespace.table(
  "control_account",
  {
    email: text().notNull(),
    url: text().notNull(),
    access_token: encryptedText("control_account", "access_token").$type<AccountV2.AccessToken>().notNull(),
    refresh_token: encryptedText("control_account", "refresh_token").$type<AccountV2.RefreshToken>().notNull(),
    token_expiry: safeInteger(),
    active: boolean()
      .notNull()
      .$default(() => false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
