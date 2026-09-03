import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  InternalError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
  WorkboardError,
} from "../../../src/domain/errors";

describe("workboard error taxonomy", () => {
  test("ValidationError carries VALIDATION and details", () => {
    const error = new ValidationError("bad input", { issues: [] });
    expect(error).toBeInstanceOf(WorkboardError);
    expect(error.code).toBe("VALIDATION");
    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("bad input");
    expect(error.details).toEqual({ issues: [] });
  });

  test("NotFoundError message forms", () => {
    expect(new NotFoundError("item").message).toBe("item was not found.");
    expect(new NotFoundError("item", 5).message).toBe("item 5 was not found.");
    expect(new NotFoundError("item", 5).code).toBe("NOT_FOUND");
  });

  test("ConflictError carries CONFLICT", () => {
    const error = new ConflictError("clash");
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("clash");
  });

  test("AuthenticationError carries UNAUTHENTICATED", () => {
    expect(new AuthenticationError().code).toBe("UNAUTHENTICATED");
  });

  test("ForbiddenError, PayloadTooLargeError, MethodNotAllowedError codes", () => {
    expect(new ForbiddenError("origin rejected").code).toBe("FORBIDDEN");
    expect(new ForbiddenError().message).toBe("Access is forbidden.");
    expect(new PayloadTooLargeError().code).toBe("PAYLOAD_TOO_LARGE");
    expect(new MethodNotAllowedError().code).toBe("METHOD_NOT_ALLOWED");
  });

  test("InternalError default and custom messages", () => {
    const cause = new Error("boom");
    const error = new InternalError("unexpected", { cause });
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("unexpected");
    expect(error.cause).toBe(cause);
    expect(new InternalError().message).toBe("An internal error occurred.");
  });

  test("all errors subclass WorkboardError", () => {
    const errors = [
      new ValidationError("x"),
      new NotFoundError("item"),
      new ConflictError("x"),
      new AuthenticationError(),
      new InternalError(),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(WorkboardError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});
