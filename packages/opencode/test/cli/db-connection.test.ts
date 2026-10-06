import { expect, test } from "bun:test"
import { psqlConnection } from "../../src/cli/cmd/db-connection"

test("psql keeps authority credentials out of argv and preserves URI options", () => {
  const connection = psqlConnection({
    url: "postgresql://app:authority%2Fsecret%3Avalue@db.example/omai?sslmode=require",
    schema: "instance_a",
  })
  expect(connection.args).toEqual(["postgresql://app@db.example/omai?sslmode=require"])
  expect(connection.env).toEqual({
    PGPASSWORD: "authority/secret:value",
    PGOPTIONS: "-c search_path=instance_a,pg_catalog",
  })
})

test("psql removes every password query parameter and uses the decoded final override", () => {
  const connection = psqlConnection({
    url: "postgresql://app:authority-secret@db.example/omai?password=old-secret&sslmode=require&password=query%2Fsecret%3A%2B%25",
    schema: "instance_a",
  })
  expect(connection.args).toEqual(["postgresql://app@db.example/omai?sslmode=require"])
  expect(connection.env.PGPASSWORD).toBe("query/secret:+%")
})

test("psql preserves an explicitly empty query password", () => {
  const connection = psqlConnection({
    url: "postgresql://app:authority-secret@db.example/omai?password=",
    schema: "instance_a",
  })
  expect(connection.args).toEqual(["postgresql://app@db.example/omai"])
  expect(connection.env.PGPASSWORD).toBe("")
})

test("psql preserves native libpq URI option encoding when stripping passwords", () => {
  const connection = psqlConnection({
    url: "postgresql://app@db.example/omai?options=-c%20application_name%3Ddb-shell&password=secret",
    schema: "instance_a",
  })
  expect(connection.args).toEqual(["postgresql://app@db.example/omai?options=-c%20application_name%3Ddb-shell"])
})
