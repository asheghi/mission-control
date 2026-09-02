// Opaque pagination cursors.
//
// Encoded shape: base64url(JSON array of tuple parts). Item lists use the
// [updatedAt, id] tuple (updated_at DESC, id DESC ordering); comments and
// history use [createdAt, id] (ascending); my_work uses [doneFlag, updatedAt, id].
// Cursors are opaque to clients: decode failures map to a validation error.
import { ValidationError } from "../domain/errors";

type CursorPart = string | number | boolean;

export function encodeCursor(parts: readonly CursorPart[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decode(cursor: string, expectedLength: number): CursorPart[] {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new ValidationError("Invalid pagination cursor.");
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    throw new ValidationError("Invalid pagination cursor.");
  }
  for (const part of parsed) {
    if (typeof part !== "string" && typeof part !== "number" && typeof part !== "boolean") {
      throw new ValidationError("Invalid pagination cursor.");
    }
  }
  return parsed as CursorPart[];
}

function stringPart(part: CursorPart | undefined): string {
  if (typeof part !== "string") throw new ValidationError("Invalid pagination cursor.");
  return part;
}

function numberPart(part: CursorPart | undefined): number {
  if (typeof part !== "number") throw new ValidationError("Invalid pagination cursor.");
  return part;
}

function doneFlagPart(part: CursorPart | undefined): 0 | 1 {
  if (part !== 0 && part !== 1) throw new ValidationError("Invalid pagination cursor.");
  return part;
}

export function decodeUpdatedAtIdCursor(cursor: string): { readonly updatedAt: string; readonly id: number } {
  const parts = decode(cursor, 2);
  return { updatedAt: stringPart(parts[0]), id: numberPart(parts[1]) };
}

export function decodeCreatedAtIdCursor(cursor: string): { readonly createdAt: string; readonly id: number } {
  const parts = decode(cursor, 2);
  return { createdAt: stringPart(parts[0]), id: numberPart(parts[1]) };
}

export function decodeDoneFlagUpdatedAtIdCursor(cursor: string): {
  readonly doneFlag: 0 | 1;
  readonly updatedAt: string;
  readonly id: number;
} {
  const parts = decode(cursor, 3);
  return { doneFlag: doneFlagPart(parts[0]), updatedAt: stringPart(parts[1]), id: numberPart(parts[2]) };
}
