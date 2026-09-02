import type { Database } from "bun:sqlite";
import { InternalError } from "../domain/errors";
import type { Migration } from "./schema";

export function currentSchemaVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}

export function migrate(db: Database, migrations: readonly Migration[]): void {
  // Validate the whole list before touching the database so a malformed list
  // can never apply anything.
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new InternalError(
        `Migration "${migration.name}" must declare version ${index + 1}, got ${migration.version}.`,
      );
    }
  }

  const current = currentSchemaVersion(db);
  if (current > migrations.length) {
    throw new InternalError(
      `The database schema version ${current} is newer than this executable supports (version ${migrations.length}).`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // user_version is written inside the same transaction, so it only
      // advances when the migration SQL committed successfully.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    try {
      apply();
    } catch (error) {
      throw new InternalError(
        `Migration ${migration.version} ("${migration.name}") failed and was rolled back.`,
        { cause: error },
      );
    }
  }
}
