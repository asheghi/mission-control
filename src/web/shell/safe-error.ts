import { publicErrorMessage } from "../public-errors.js";

export function safeErrorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  return publicErrorMessage(error, fallback);
}
