import { disposeAllInstances } from "./fixture"

export async function resetDatabase() {
  await disposeAllInstances()
  const { database } = await import("../../../core/test/fixture/database-setup")
  await database.reset()
}
