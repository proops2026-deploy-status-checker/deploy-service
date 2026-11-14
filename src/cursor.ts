import type { DeployCursor } from "./domain";

// Opaque keyset cursor: base64url("<created_at epoch ms>:<id>"). Clients must not parse it.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: DeployCursor): string {
  return Buffer.from(`${cursor.createdAt.getTime()}:${cursor.id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string): DeployCursor | null {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;

  const millis = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!/^\d{1,15}$/.test(millis) || !UUID_PATTERN.test(id)) return null;

  return { createdAt: new Date(Number(millis)), id };
}
