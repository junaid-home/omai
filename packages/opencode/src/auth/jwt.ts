import { SignJWT, jwtVerify } from "jose"
import { randomBytes } from "node:crypto"
import { Authentication } from "@opencode-ai/core/authentication"

const localSecret = randomBytes(32)
export const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000

export type JwtPayload = {
  readonly sub: string
  readonly username: string
  readonly email: string
  readonly jti: string
}

export function signingKey() {
  const value = Authentication.secret("OPENCODE_JWT_SECRET")
  if (!value) {
    if (Authentication.central()) throw new Error("Central authentication requires OPENCODE_JWT_SECRET")
    return localSecret
  }
  if (Buffer.byteLength(value) < 32) throw new Error("OPENCODE_JWT_SECRET must contain at least 32 bytes")
  return new TextEncoder().encode(value)
}

export function generateToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({ username: payload.username, email: payload.email })
    .setSubject(payload.sub)
    .setJti(payload.jti)
    .setIssuer("omai")
    .setAudience(Authentication.instanceID())
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + TOKEN_LIFETIME_MS) / 1000))
    .sign(signingKey())
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  if (token.length > 8192) return null
  const key = signingKey()
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: "omai",
      audience: Authentication.instanceID(),
      requiredClaims: ["sub", "jti", "iat", "exp"],
    })
    if (
      typeof payload.sub !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload.username !== "string" ||
      typeof payload.email !== "string"
    )
      return null
    return { sub: payload.sub, jti: payload.jti, username: payload.username, email: payload.email }
  } catch {
    return null
  }
}
