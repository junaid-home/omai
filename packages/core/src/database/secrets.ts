import { customType } from "drizzle-orm/pg-core"
import { InstanceStateEncryption } from "../instance-state/encryption"

let cached: ReturnType<typeof InstanceStateEncryption.codec> | undefined

// Configuration is immutable during a runtime. Rotation requires the explicit migration/rotation procedure.
function encryption() {
  return (cached ??= InstanceStateEncryption.codec(InstanceStateEncryption.keyFromEnvironment()))
}

export function encryptedJson(namespace: string, column: string) {
  return customType<{ data: unknown; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => encryption().encode(namespace, column, value),
    fromDriver: (value) => encryption().decode(namespace, column, value),
  })()
}

export function encryptedText(namespace: string, column: string) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => encryption().encode(namespace, column, value),
    fromDriver(value) {
      const result = encryption().decode(namespace, column, value)
      if (typeof result !== "string") throw new Error("Encrypted database text has an invalid value type")
      return result
    },
  })()
}
