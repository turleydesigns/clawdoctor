import { execFileSync } from 'child_process';
import { BaseWatcher, WatchResult } from './base.js';

const AUTH_PATTERNS = [
  /401/,
  /403/,
  /token expired/i,
  /auth failed/i,
  /unauthorized/i,
  /authentication error/i,
  /invalid token/i,
  /permission denied/i,
];

const MAX_LOG_LINES = 200;

export class AuthWatcher extends BaseWatcher {
  readonly name = 'AuthWatcher';
  readonly defaultInterval = 60;

  async check(): Promise<WatchResult[]> {
    const results: WatchResult[] = [];

    // Try to read from systemd journal
    const journalLines = this.readJournalLogs();
    if (journalLines !== null) {
      return this.analyzeLines(journalLines, 'systemd journal');
    }

    // Try to find gateway log files
    const logLines = this.readLogFiles();
    if (logLines !== null) {
      return this.analyzeLines(logLines, 'log file');
    }

    results.push(this.ok('No gateway logs accessible for auth check', 'auth_no_logs'));
    return results;
  }

  private readJournalLogs(): string[] | null {
    try {
      const output = execFileSync(
        'journalctl',
        ['-u', 'openclaw-gateway', '--since', '5 minutes ago', '--no-pager', '-q'],
        { encoding: 'utf-8', timeout: 5000 }
      );
      return output.split('\n').slice(-MAX_LOG_LINES);
    } catch {
      return null;
    }
  }

  private readLogFiles(): string[] | null {
    const logPaths = [
      `${this.config.openclawPath}/logs/gateway.log`,
      `${this.config.openclawPath}/gateway.log`,
    ];

    for (const logPath of logPaths) {
      try {
        const output = execFileSync('tail', ['-n', String(MAX_LOG_LINES), logPath], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        return output.split('\n');
      } catch {
        continue;
      }
    }
    return null;
  }

  private analyzeLines(lines: string[], source: string): WatchResult[] {
    const matches: string[] = [];

    for (const line of lines) {
      if (AUTH_PATTERNS.some(pattern => pattern.test(line))) {
        matches.push(line.trim());
      }
    }

    if (matches.length === 0) {
      return [this.ok(`No auth failures detected in ${source}`, 'auth_ok')];
    }

    return [
      this.error(
        `${matches.length} auth failure(s) detected in ${source}`,
        'auth_failure',
        { count: matches.length, samples: matches.slice(0, 3) }
      ),
    ];
  }
}
