import Database from "@tauri-apps/plugin-sql";

import type { ProjectGraph } from "./types";

/** Must match `DB_URL` in src-tauri/src/lib.rs, where the migrations are registered. */
const DB_URL = "sqlite:meridian.db";

const LAST_PROJECT_KEY = "last_project";

let connection: Promise<Database> | null = null;

/** One shared connection; `Database.load` also runs pending migrations. */
function db(): Promise<Database> {
  connection ??= Database.load(DB_URL).catch((err) => {
    // Never hold on to a rejected promise: otherwise one failed connection
    // attempt would keep failing every later read and write for the whole
    // session, even once whatever caused it has gone away.
    connection = null;
    throw err;
  });
  return connection;
}

export type CachedScan = {
  graph: ProjectGraph;
  /** When the cached scan was taken, as an ISO-8601 string. */
  scannedAt: string;
};

/** The project open when the app was last used, if any. */
export async function loadLastProject(): Promise<string | null> {
  const rows = await (
    await db()
  ).select<{ value: string }[]>("SELECT value FROM app_state WHERE key = $1", [LAST_PROJECT_KEY]);
  return rows[0]?.value ?? null;
}

export async function saveLastProject(path: string): Promise<void> {
  await (
    await db()
  ).execute(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [LAST_PROJECT_KEY, path],
  );
}

/** The stored graph for a project, or null if it has never been scanned. */
export async function loadCachedScan(path: string): Promise<CachedScan | null> {
  const rows = await (
    await db()
  ).select<{ graph: string; scanned_at: string }[]>(
    "SELECT graph, scanned_at FROM scans WHERE path = $1",
    [path],
  );
  const row = rows[0];
  if (!row) return null;

  try {
    return { graph: JSON.parse(row.graph) as ProjectGraph, scannedAt: row.scanned_at };
  } catch {
    // A row written by an older, incompatible version: treat it as a cache miss
    // rather than failing the whole load.
    return null;
  }
}

/** Replace the cached scan for a project. */
export async function saveScan(path: string, graph: ProjectGraph): Promise<string> {
  const scannedAt = new Date().toISOString();
  await (
    await db()
  ).execute(
    `INSERT INTO scans (path, graph, scanned_at) VALUES ($1, $2, $3)
     ON CONFLICT (path) DO UPDATE SET graph = excluded.graph, scanned_at = excluded.scanned_at`,
    [path, JSON.stringify(graph), scannedAt],
  );
  return scannedAt;
}
