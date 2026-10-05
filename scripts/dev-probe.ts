import { devOrigin } from "./dev-common";

const TIMEOUT_MS = 2_000;

export async function healthEndpointResponds(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`${devOrigin(host, port)}/api/health`, {
      redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch { return false; }
}

/** Reject anonymous success, redirects and unrelated HTML/JSON endpoints.
 * This is a local development sanity check, not authentication of a hostile server.
 */
export async function tokenAcceptedOnOrigin(host: string, port: number, token: string): Promise<"yes" | "no"> {
  try {
    const url = `${devOrigin(host, port)}/api/participants`;
    const anonymous = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (anonymous.status !== 401) return "no";
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) return "no";
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data) || body.data.length === 0) return "no";
    return body.data.every((entry: unknown) => entry !== null && typeof entry === "object"
      && "id" in entry && Number.isSafeInteger(entry.id) && Number(entry.id) > 0
      && "name" in entry && typeof entry.name === "string" && entry.name.length > 0
      && "kind" in entry && (entry.kind === "human" || entry.kind === "agent")) ? "yes" : "no";
  } catch { return "no"; }
}
