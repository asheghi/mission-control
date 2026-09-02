import { z } from "zod";
import { ValidationError } from "./errors";

export const participantKindSchema = z.enum(["human", "agent"]);
export const workStatusSchema = z.enum(["todo", "doing", "blocked", "done"]);
export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const positiveIdSchema = z.number().int().positive();
export const handleSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Use a 1-64 character ASCII handle.");
export const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a six-digit hexadecimal color.");
export const titleSchema = z.string().trim().min(1).max(256);
export const bodySchema = z.string().max(100_000);
export const commentBodySchema = z.string().max(100_000).refine((value) => value.trim().length > 0, "Comment body must not be blank.");
export const labelNameSchema = z.string().trim().min(1).max(64);
export const tokenNameSchema = z.string().trim().min(1).max(128);

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError("Input validation failed.", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}
