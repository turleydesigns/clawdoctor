import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AGENTWATCH_DIR } from './config.js';

export const SNAPSHOTS_DIR = path.join(AGENTWATCH_DIR, 'snapshots');

const ALLOWED_ROLLBACK_PREFIXES = [
  'openclaw gateway',
  'openclaw cron',
  'openclaw session',
  'openclaw auth',
];

export interface Snapshot {
  timestamp: string;
  action: string;
  target: string;
  before: Record<string, unknown>;
  rollbackCommand: string;
}

export function createSnapshot(
  action: string,
  target: string,
  before: Record<string, unknown>,
  rollbackCommand: string
): string {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true, mode: 0o700 });
  // CLI-C4: Always enforce 0700 on snapshots dir in case it pre-existed with wrong perms
  fs.chmodSync(SNAPSHOTS_DIR, 0o700);
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toISOString().slice(11, 19).replace(/:/g, '');
  const id = `${datePart}-${timePart}-${action}`;
  const snapshot: Snapshot = {
    timestamp: now.toISOString(),
    action,
    target,
    before,
    rollbackCommand,
  };
  const snapshotPath = path.join(SNAPSHOTS_DIR, `${id}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // CLI-C4: Enforce 0600 explicitly after write (mode option may not override existing files)
  fs.chmodSync(snapshotPath, 0o600);
  return id;
}

export function listSnapshots(): Array<{ id: string; snapshot: Snapshot }> {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(SNAPSHOTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  return files.map(f => {
    const id = f.replace('.json', '');
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf-8')) as Snapshot;
      return { id, snapshot };
    } catch {
      return null;
    }
  }).filter((x): x is { id: string; snapshot: Snapshot } => x !== null);
}

// CLI-C4: Validate snapshot ID is a safe filename (no path traversal)
const SAFE_SNAPSHOT_ID = /^[\w\-]+$/;

export function getSnapshot(id: string): Snapshot | null {
  if (!SAFE_SNAPSHOT_ID.test(id)) return null;
  const filePath = path.join(SNAPSHOTS_DIR, `${id}.json`);
  // CLI-C4: Verify the resolved path is within the snapshots directory
  if (!path.resolve(filePath).startsWith(path.resolve(SNAPSHOTS_DIR) + path.sep)) return null;
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Snapshot;
  } catch {
    return null;
  }
}

// CLI-C4: Validate rollback command tokens — each token must be a safe identifier
const SAFE_CMD_TOKEN = /^[\w][\w\-./]*$/;

export function executeRollback(id: string): { success: boolean; message: string; snapshot?: Snapshot } {
  const snapshot = getSnapshot(id);
  if (!snapshot) {
    return { success: false, message: `Snapshot '${id}' not found` };
  }

  const cmd = snapshot.rollbackCommand;
  const allowed = ALLOWED_ROLLBACK_PREFIXES.some(prefix => cmd.startsWith(prefix));
  if (!allowed) {
    console.error(`[snapshots] Rollback rejected: command not in allowlist`);
    return { success: false, message: `Rollback rejected: command not in allowlist` };
  }

  const tokens = cmd.split(/\s+/);
  // CLI-C4: Validate every token in the command is a safe identifier
  if (tokens.some(t => !SAFE_CMD_TOKEN.test(t))) {
    console.error(`[snapshots] Rollback rejected: command contains unsafe tokens`);
    return { success: false, message: `Rollback rejected: command contains unsafe tokens` };
  }

  const [bin, ...args] = tokens;
  try {
    execFileSync(bin, args);
    return { success: true, message: `Rollback successful`, snapshot };
  } catch (err) {
    return {
      success: false,
      message: `Rollback failed: ${String(err).slice(0, 200)}`,
      snapshot,
    };
  }
}
