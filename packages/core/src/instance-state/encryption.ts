import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

export interface Key {
  readonly instanceID: string
  readonly secret: string
}

/** Encrypt metadata and provider credentials before they reach SQL parameters or database backups. */
export function codec(input: Key) {
  const secret = Buffer.from(input.secret, "base64")
  if (!input.instanceID || secret.length !== 32 || secret.toString("base64") !== input.secret) {
    throw new Error("OPENCODE_DATA_KEY must be a canonical base64-encoded 32-byte key and instance ID must be set")
  }
  const aad = (namespace: string, key: string) =>
    Buffer.from(JSON.stringify(["omai-state-v1", input.instanceID, namespace, key]))
  return {
    encode(namespace: string, key: string, value: unknown) {
      const plaintext = JSON.stringify(value)
      if (plaintext === undefined) throw new Error("Instance state must be JSON serializable")
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", secret, nonce)
      cipher.setAAD(aad(namespace, key))
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      return [
        "v1",
        nonce.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        encrypted.toString("base64"),
      ].join(".")
    },
    decode(namespace: string, key: string, value: string): unknown {
      const parts = value.split(".")
      if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Unsupported instance state envelope")
      const nonce = Buffer.from(parts[1], "base64")
      const tag = Buffer.from(parts[2], "base64")
      if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid instance state envelope")
      const decipher = createDecipheriv("aes-256-gcm", secret, nonce)
      decipher.setAAD(aad(namespace, key))
      decipher.setAuthTag(tag)
      return JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8"),
      ) as unknown
    },
  }
}

export function keyFromEnvironment(): Key {
  const filename = process.env.OPENCODE_DATA_KEY_FILE
  const value = process.env.OPENCODE_DATA_KEY
  if (filename && value) throw new Error("Configure only one of OPENCODE_DATA_KEY_FILE and OPENCODE_DATA_KEY")
  const secret = filename ? readFileSync(filename, "utf8").trim() : value
  const instanceID = process.env.OPENCODE_INSTANCE_ID
  if (!secret || !instanceID)
    throw new Error("Central instance state requires OPENCODE_DATA_KEY_FILE and OPENCODE_INSTANCE_ID")
  return { secret, instanceID }
}

export * as InstanceStateEncryption from "./encryption"
