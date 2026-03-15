import fs from 'fs';
import path from 'path';
import { AGENTWATCH_DIR } from './config.js';
import { runShell } from './utils.js';

export const SNAPSHOTS_DIR = path.join(AGENTWATCH_DIR, 'snapshots');

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
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
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
  fs.writeFileSync(path.join(SNAPSHOTS_DIR, `${id}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');
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

export function getSnapshot(id: string): Snapshot | null {
  const filePath = path.join(SNAPSHOTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Snapshot;
  } catch {
    return null;
  }
}

export function executeRollback(id: string): { success: boolean; message: string; snapshot?: Snapshot } {
  const snapshot = getSnapshot(id);
  if (!snapshot) {
    return { success: false, message: `Snapshot '${id}' not found` };
  }

  const result = runShell(snapshot.rollbackCommand);
  if (result.ok) {
    return { success: true, message: `Rollback successful: ${snapshot.rollbackCommand}`, snapshot };
  }
  return {
    success: false,
    message: `Rollback failed: ${result.stderr.slice(0, 200) || result.stdout.slice(0, 200)}`,
    snapshot,
  };
}
