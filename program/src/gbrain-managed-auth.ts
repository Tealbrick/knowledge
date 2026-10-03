import { createHmac, timingSafeEqual } from "node:crypto";

const sourcePattern = /^kb-[a-f0-9]{24}$/u;

/** Internal, source-bound capability. Never issued to browsers or harnesses. */
export function managedBrainToken(secret: string, sourceId: string): string {
  if (!sourcePattern.test(sourceId) || secret.length < 32) throw new Error("Invalid managed Brain binding");
  const signature = createHmac("sha256", secret).update(`knowledge-brain-v1:${sourceId}`).digest("hex");
  return `${sourceId}.${signature}`;
}

export function verifyManagedBrainToken(secret: string, bearer: string): string | null {
  const sourceId = bearer.split(".")[0] ?? "";
  if (!sourcePattern.test(sourceId) || secret.length < 32) return null;
  const expected = Buffer.from(managedBrainToken(secret, sourceId));
  const received = Buffer.from(bearer);
  return expected.length === received.length && timingSafeEqual(expected, received) ? sourceId : null;
}
