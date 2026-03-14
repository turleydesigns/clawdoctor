import fs from 'fs';
import path from 'path';
import { BaseWatcher, WatchResult } from './base.js';
import { fileAgeSeconds } from '../utils.js';

interface CronState {
  name?: string;
  lastRun?: string;
  lastError?: string;
  status?: string;
  interval?: number; // expected interval in seconds
}

export class CronWatcher extends BaseWatcher {
  readonly name = 'CronWatcher';
  readonly defaultInterval = 60;

  async check(): Promise<WatchResult[]> {
    const cronDir = path.join(this.config.openclawPath, 'state');
    const results: WatchResult[] = [];

    if (!fs.existsSync(cronDir)) {
      results.push(this.ok('No cron state directory found (OpenClaw may not use crons)', 'cron_no_state_dir'));
      return results;
    }

    let cronFiles: string[];
    try {
      cronFiles = fs.readdirSync(cronDir).filter(f => f.startsWith('cron-') && f.endsWith('.json'));
    } catch {
      results.push(this.warn(`Cannot read cron state dir: ${cronDir}`, 'cron_state_unreadable'));
      return results;
    }

    if (cronFiles.length === 0) {
      results.push(this.ok('No cron state files found', 'cron_no_files'));
      return results;
    }

    for (const file of cronFiles) {
      const filePath = path.join(cronDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const state = JSON.parse(raw) as CronState;
        const cronName = state.name ?? path.basename(file, '.json');

        // Check for error status
        if (state.status === 'error' || state.lastError) {
          results.push(
            this.error(
              `Cron '${cronName}' last run errored`,
              'cron_error',
              { cronName, lastRun: state.lastRun, lastError: state.lastError }
            )
          );
          continue;
        }

        // Check if overdue
        if (state.lastRun && state.interval) {
          const lastRunDate = new Date(state.lastRun);
          if (!isNaN(lastRunDate.getTime())) {
            const ageSec = fileAgeSeconds(lastRunDate);
            const overdueThreshold = state.interval * 2; // 2x interval = overdue
            if (ageSec > overdueThreshold) {
              results.push(
                this.warn(
                  `Cron '${cronName}' overdue — last run ${Math.round(ageSec / 60)}m ago (expected every ${Math.round(state.interval / 60)}m)`,
                  'cron_overdue',
                  { cronName, lastRun: state.lastRun, ageSec, interval: state.interval }
                )
              );
              continue;
            }
          }
        }

        results.push(this.ok(`Cron '${cronName}' OK`, 'cron_ok'));
      } catch {
        results.push(this.warn(`Cannot parse cron state file: ${file}`, 'cron_parse_error', { file }));
      }
    }

    return results;
  }
}
