export interface MentionCandidate<T> {
  readonly name: string;
  readonly value: T;
}

const MENTION_PATTERN = /(^|[^A-Za-z0-9_@.\-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_-])/g;

export function parseMentionNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[2];
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

export function resolveMentions<T>(text: string, candidates: readonly MentionCandidate<T>[]): T[] {
  const byName = new Map(candidates.map((candidate) => [candidate.name.toLowerCase(), candidate.value]));
  return parseMentionNames(text)
    .map((name) => byName.get(name.toLowerCase()))
    .filter((value): value is T => value !== undefined);
}
