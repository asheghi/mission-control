// Transport-side credential extraction. The middleware only extracts the
// presented credential; the auth service derives the actor from it.
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (match === null) return null;
  const token = match[1];
  return token ?? null;
}
