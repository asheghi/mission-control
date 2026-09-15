import { ApiError } from "./api.js";

const CODE_MESSAGES = Object.freeze({
  VALIDATION_ERROR: "Check the entered values and try again.",
  INVALID_INPUT: "Check the entered values and try again.",
  NOT_FOUND: "The requested resource could not be found.",
  CONFLICT: "This change conflicts with current data. Refresh and try again.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
});

const STATUS_MESSAGES = Object.freeze({
  400: "Check the entered values and try again.",
  401: "Your session is no longer valid. Sign in again.",
  403: "Your session is no longer valid. Sign in again.",
  404: "The requested resource could not be found.",
  409: "This change conflicts with current data. Refresh and try again.",
  422: "Check the entered values and try again.",
  429: "Too many requests. Wait a moment and try again.",
  500: "The service could not complete the request. Try again.",
  502: "The service is temporarily unavailable. Try again.",
  503: "The service is temporarily unavailable. Try again.",
  504: "The service is temporarily unavailable. Try again.",
});

export function isTerminalAuthError(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function publicErrorMessage(error, fallback = "Something went wrong. Try again.") {
  if (!(error instanceof ApiError)) return fallback;
  const code = typeof error.code === "string" ? error.code : "";
  return CODE_MESSAGES[code] ?? STATUS_MESSAGES[error.status] ?? fallback;
}

export function reportTerminalAuthError(error) {
  if (!isTerminalAuthError(error)) return false;
  window.dispatchEvent(new CustomEvent("workboard:authentication-failed"));
  return true;
}
