import initialMigration from "./migrations/001_initial.sql" with { type: "text" };
import itemHierarchyMigration from "./migrations/002_item_hierarchy.sql" with { type: "text" };
import workItemModelMigration from "./migrations/003_work_item_model.sql" with { type: "text" };

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  { version: 1, name: "initial", sql: initialMigration },
  { version: 2, name: "item-hierarchy", sql: itemHierarchyMigration },
  { version: 3, name: "work-item-model", sql: workItemModelMigration },
];
