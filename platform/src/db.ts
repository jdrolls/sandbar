import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Computer {
  id: string;
  name: string;
  agent: "hermes" | "none";
  basePort: number;
  controlToken: string;
  createdAt: string;
}

interface ComputerRow {
  id: string;
  name: string;
  agent: string;
  base_port: number;
  control_token: string;
  created_at: string;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowToComputer(row: ComputerRow): Computer {
  if (row.agent !== "hermes" && row.agent !== "none") {
    throw new Error(`Invalid agent stored for computer ${row.id}.`);
  }
  return {
    id: row.id,
    name: row.name,
    agent: row.agent,
    basePort: row.base_port,
    controlToken: row.control_token,
    createdAt: row.created_at,
  };
}

/** Persistent metadata for the platform; provider credentials are deliberately absent. */
export class SandbarDatabase {
  private readonly database: Database;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.database = new Database(join(dataDirectory, "sandbar.db"));
    this.database.run("PRAGMA journal_mode = WAL;");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS computers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent TEXT NOT NULL,
        base_port INTEGER NOT NULL,
        control_token TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getOrCreatePlatformToken(dataDirectory: string): { token: string; created: boolean } {
    const row = this.database
      .query("SELECT value FROM settings WHERE key = ?")
      .get("platform_token") as { value: string } | null;
    const validExistingToken = row !== null && /^[a-f0-9]{32}$/.test(row.value);
    const token = validExistingToken ? row.value : randomToken();

    if (!validExistingToken) {
      this.database.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["platform_token", token]);
    }

    // The file is for installers and operators. Keep it readable only by the platform user.
    const tokenPath = join(dataDirectory, "token");
    writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    return { token, created: !validExistingToken };
  }

  listComputers(): Computer[] {
    const rows = this.database
      .query("SELECT id, name, agent, base_port, control_token, created_at FROM computers ORDER BY created_at DESC")
      .all() as ComputerRow[];
    return rows.map(rowToComputer);
  }

  getComputer(id: string): Computer | null {
    const row = this.database
      .query("SELECT id, name, agent, base_port, control_token, created_at FROM computers WHERE id = ?")
      .get(id) as ComputerRow | null;
    return row === null ? null : rowToComputer(row);
  }

  addComputer(computer: Computer): void {
    this.database.run(
      `INSERT INTO computers (id, name, agent, base_port, control_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [computer.id, computer.name, computer.agent, computer.basePort, computer.controlToken, computer.createdAt],
    );
  }

  deleteComputer(id: string): void {
    this.database.run("DELETE FROM computers WHERE id = ?", [id]);
  }
}
