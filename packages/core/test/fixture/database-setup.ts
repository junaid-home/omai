// A process owns its schema and restricted login. Never reuse an application schema for tests.
if (!process.env.OMAI_TEST_DATABASE_URL) {
  throw new Error("Tests require OMAI_TEST_DATABASE_URL pointing to a disposable PostgreSQL test database")
}
process.env.OPENCODE_DATABASE_SCHEMA = `omai_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`
process.env.OPENCODE_INSTANCE_ID = `test:${crypto.randomUUID()}`
process.env.OPENCODE_DATA_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
delete process.env.OPENCODE_DB

const { TestDatabase } = await import("./database")
export const database = await TestDatabase.create()
process.env.OPENCODE_DATABASE_URL = database.url
