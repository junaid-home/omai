import { describe, expect, test } from "bun:test"
import { configFromEnv } from "../src/config"

describe("configFromEnv", () => {
  test("never asks Northflank for a volume below its 6 GB minimum", () => {
    // A 3 GB request was rejected by the nvme storage class, failing every new VM.
    expect(configFromEnv({ NORTHFLANK_VOLUME_SIZE_GB: "3" }).volumeSizeMB).toBe(6 * 1024)
    expect(configFromEnv({}).volumeSizeMB).toBe(6 * 1024)
    expect(configFromEnv({ NORTHFLANK_VOLUME_SIZE_GB: "10" }).volumeSizeMB).toBe(10 * 1024)
  })
})
