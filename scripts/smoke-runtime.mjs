import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = await mkdtemp(path.join(os.tmpdir(), "claude-workspace-accounts-runtime-"));
const databasePath = path.join(directory, "smoke.sqlite3");

try {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE smoke (id TEXT PRIMARY KEY, value INTEGER NOT NULL);
    BEGIN IMMEDIATE;
  `);
  database.prepare("INSERT INTO smoke (id, value) VALUES (@id, @value)")
    .run({ id: "runtime", value: 42 });
  database.exec("COMMIT");
  const row = database.prepare("SELECT value FROM smoke WHERE id = ?")
    .get("runtime");
  database.close();
  if (!row || row.value !== 42) {
    throw new Error("Built-in SQLite did not round-trip the expected value.");
  }
  console.log("VS Code runtime prerequisites: SQLite OK");
} finally {
  await rm(directory, { recursive: true, force: true });
}
