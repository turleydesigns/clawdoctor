import fs from 'fs';
import path from 'path';
import { BaseWatcher, WatchResult } from './base.js';
import { fileAgeSeconds } from '../utils.js';

interface SessionEntry {
  type?: string;
  error?: string;
  status?: string;
  timestamp?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const MAX_SESSION_AGE_HOURS = 4;
const SESSION_TIMEOUT_SECONDS = MAX_SESSION_AGE_HOURS * 3600;

export class SessionWatcher extends BaseWatcher {
  readonly name = 'SessionWatcher';
  readonly defaultInterval = 60;

  async check(): Promise<WatchResult[]> {
    const agentsDir = path.join(this.config.openclawPath, 'agents');
    const results: WatchResult[] = [];

    if (!fs.existsSync(agentsDir)) {
      results.push(this.ok('No agents directory found', 'session_no_agents_dir'));
      return results;
    }

    let agentDirs: string[];
    try {
      agentDirs = fs.readdirSync(agentsDir).filter(d => {
        try {
          return fs.statSync(path.join(agentsDir, d)).isDirectory();
        } catch { return false; }
      });
    } catch {
      results.push(this.warn(`Cannot read agents dir: ${agentsDir}`, 'session_agents_unreadable'));
      return results;
    }

    let checkedSessions = 0;

    for (const agentDir of agentDirs) {
      const sessionsDir = path.join(agentsDir, agentDir, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      let sessionFiles: string[];
      try {
        sessionFiles = fs.readdirSync(sessionsDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtime }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
          .slice(0, 5) // newest 5 sessions per agent
          .map(f => f.name);
      } catch { continue; }

      for (const sessionFile of sessionFiles) {
        const sessionPath = path.join(sessionsDir, sessionFile);
        checkedSessions++;

        try {
          const stat = fs.statSync(sessionPath);
          const ageSec = fileAgeSeconds(stat.mtime);

          // Only check recent sessions (< 4 hours old)
          if (ageSec > SESSION_TIMEOUT_SECONDS) continue;

          const lines = fs.readFileSync(sessionPath, 'utf-8')
            .split('\n')
            .filter(l => l.trim())
            .slice(-50); // last 50 entries

          const entries = lines.map(line => {
            try { return JSON.parse(line) as SessionEntry; }
            catch { return null; }
          }).filter((e): e is SessionEntry => e !== null);

          // Check for errors
          const errorEntries = entries.filter(e => e.type === 'error' || e.error || e.status === 'error');
          if (errorEntries.length > 0) {
            const lastError = errorEntries[errorEntries.length - 1];
            results.push(
              this.error(
                `Session error in agent '${agentDir}': ${lastError.error ?? lastError.type ?? 'unknown error'}`,
                'session_error',
                { agent: agentDir, session: sessionFile, error: lastError.error }
              )
            );
            continue;
          }

          // Check for aborted sessions
          const abortedEntries = entries.filter(e => e.status === 'aborted' || e.type === 'abort');
          if (abortedEntries.length > 0) {
            results.push(
              this.warn(
                `Session aborted in agent '${agentDir}'`,
                'session_aborted',
                { agent: agentDir, session: sessionFile }
              )
            );
            continue;
          }

          // Check for sessions that ran too long (still active but file is old)
          const lastEntry = entries[entries.length - 1];
          if (lastEntry?.type !== 'end' && lastEntry?.status !== 'complete' && ageSec > 3600) {
            results.push(
              this.warn(
                `Session in agent '${agentDir}' may be stuck (running for ${Math.round(ageSec / 60)}m)`,
                'session_stuck',
                { agent: agentDir, session: sessionFile, ageSec }
              )
            );
          }
        } catch { continue; }
      }
    }

    if (results.length === 0) {
      if (checkedSessions > 0) {
        results.push(this.ok(`${checkedSessions} recent session(s) healthy`, 'sessions_ok'));
      } else {
        results.push(this.ok('No recent sessions to check', 'sessions_ok'));
      }
    }

    return results;
  }
}
