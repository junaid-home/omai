import { afterAll, afterEach, beforeEach } from "bun:test"
import { database } from "./database-setup"

export { database } from "./database-setup"

// Bun's concurrent tests must not truncate a schema while another test is still using it.
// Parallel test processes remain independent through their unique schemas.
let previous = Promise.resolve()
let release: (() => void) | undefined
beforeEach(async () => {
  const wait = previous
  let next: (() => void) | undefined
  previous = new Promise<void>((resolve) => {
    next = resolve
  })
  await wait
  release = next
  await database.reset()
})
afterEach(() => {
  release?.()
  release = undefined
})
afterAll(() => database.close())
