import {createHash, createHmac, timingSafeEqual} from "node:crypto";
import {nativeMemoryOperation} from "./brain-native-policy.js";
export interface NativeMemoryClaim { sourceId: string; clientId: string; operation: string; expires: number }
export function nativeMemoryToken(secret: string, sourceId: string, principalId: string, operation: string, now = Date.now()): string {
  if (secret.length < 32 || !/^kb-[a-f0-9]{24}$/u.test(sourceId) || !principalId || !(operation === "catalog" || nativeMemoryOperation(operation))) throw new Error("Invalid native memory binding");
  const claim: NativeMemoryClaim = {sourceId, clientId: `kc-${createHash("sha256").update(principalId).digest("hex")}`, operation, expires: Math.floor(now / 1000) + 300};
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `kn2.${payload}.${createHmac("sha256", secret).update(`kn2.${payload}`).digest("hex")}`;
}
export function verifyNativeMemoryToken(secret: string, token: string, now = Date.now()): NativeMemoryClaim | null {
  if (secret.length < 32 || token.length > 1024) return null;
  const [version, payload, signature, extra] = token.split(".");
  if (version !== "kn2" || !payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(createHmac("sha256",secret).update(`kn2.${payload}`).digest("hex"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload,"base64url").toString()) as NativeMemoryClaim;
    return /^kb-[a-f0-9]{24}$/u.test(c.sourceId) && /^kc-[a-f0-9]{64}$/u.test(c.clientId) && (c.operation === "catalog" || nativeMemoryOperation(c.operation)) && Number.isSafeInteger(c.expires) && c.expires > now / 1000 && c.expires <= now / 1000 + 301 ? c : null;
  } catch { return null; }
}
