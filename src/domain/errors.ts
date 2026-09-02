export type WorkboardErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHENTICATED"
  | "INTERNAL";

export class WorkboardError extends Error {
  constructor(
    public readonly code: WorkboardErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends WorkboardError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("VALIDATION", message, details);
  }
}

export class NotFoundError extends WorkboardError {
  constructor(resource: string, id?: number | string) {
    super("NOT_FOUND", id === undefined ? `${resource} was not found.` : `${resource} ${id} was not found.`);
  }
}

export class ConflictError extends WorkboardError {
  constructor(message: string) {
    super("CONFLICT", message);
  }
}

export class AuthenticationError extends WorkboardError {
  constructor() {
    super("UNAUTHENTICATED", "Authentication failed.");
  }
}

export class InternalError extends WorkboardError {
  constructor(message = "An internal error occurred.", options?: ErrorOptions) {
    super("INTERNAL", message, undefined, options);
  }
}
