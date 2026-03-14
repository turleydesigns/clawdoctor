import { AgentWatchConfig } from './config.js';
import { BaseWatcher, WatchResult } from './watchers/base.js';
import { GatewayWatcher } from './watchers/gateway.js';
import { CronWatcher } from './watchers/cron.js';
import { SessionWatcher } from './watchers/session.js';
import { AuthWatcher } from './watchers/auth.js';
import { CostWatcher } from './watchers/cost.js';
import { ProcessHealer } from './healers/process.js';
import { CronHealer } from './healers/cron.js';
import { TelegramAlerter } from './alerters/telegram.js';
import { pruneOldEvents } from './store.js';
import { nowIso } from './utils.js';

interface WatcherEntry {
  watcher: BaseWatcher;
  intervalMs: number;
  lastRun: number;
}

export class Daemon {
  private config: AgentWatchConfig;
  private watchers: WatcherEntry[] = [];
  private alerter: TelegramAlerter;
  private processHealer: ProcessHealer;
  private cronHealer: CronHealer;
  private running = false;
  private tickInterval: NodeJS.Timeout | null = null;

  constructor(config: AgentWatchConfig) {
    this.config = config;
    this.alerter = new TelegramAlerter(config);
    this.processHealer = new ProcessHealer(config);
    this.cronHealer = new CronHealer(config);
    this.setupWatchers();
  }

  private setupWatchers(): void {
    const { watchers } = this.config;

    if (watchers.gateway.enabled) {
      this.watchers.push({
        watcher: new GatewayWatcher(this.config),
        intervalMs: watchers.gateway.interval * 1000,
        lastRun: 0,
      });
    }
    if (watchers.cron.enabled) {
      this.watchers.push({
        watcher: new CronWatcher(this.config),
        intervalMs: watchers.cron.interval * 1000,
        lastRun: 0,
      });
    }
    if (watchers.session.enabled) {
      this.watchers.push({
        watcher: new SessionWatcher(this.config),
        intervalMs: watchers.session.interval * 1000,
        lastRun: 0,
      });
    }
    if (watchers.auth.enabled) {
      this.watchers.push({
        watcher: new AuthWatcher(this.config),
        intervalMs: watchers.auth.interval * 1000,
        lastRun: 0,
      });
    }
    if (watchers.cost.enabled) {
      this.watchers.push({
        watcher: new CostWatcher(this.config),
        intervalMs: watchers.cost.interval * 1000,
        lastRun: 0,
      });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(`[${nowIso()}] AgentWatch daemon started`);
    console.log(`[${nowIso()}] Monitoring ${this.watchers.length} watcher(s)`);

    if (this.config.dryRun) {
      console.log(`[${nowIso()}] DRY RUN mode — healers will not take action`);
    }

    // Run all watchers immediately on start
    this.tick();

    // Tick every 5 seconds to check if any watcher is due
    this.tickInterval = setInterval(() => this.tick(), 5000);

    // Prune old events daily
    setInterval(() => {
      const pruned = pruneOldEvents(this.config.retentionDays);
      if (pruned > 0) {
        console.log(`[${nowIso()}] Pruned ${pruned} old event(s)`);
      }
    }, 24 * 3600 * 1000);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log(`[${nowIso()}] AgentWatch daemon stopped`);
  }

  private tick(): void {
    const now = Date.now();
    for (const entry of this.watchers) {
      if (now - entry.lastRun >= entry.intervalMs) {
        entry.lastRun = now;
        this.runWatcher(entry.watcher).catch(err => {
          console.error(`[${nowIso()}] Error in ${entry.watcher.name}:`, err);
        });
      }
    }
  }

  private async runWatcher(watcher: BaseWatcher): Promise<void> {
    try {
      const results = await watcher.run();
      for (const result of results) {
        await this.handleResult(watcher, result);
      }
    } catch (err) {
      console.error(`[${nowIso()}] ${watcher.name} threw:`, err);
    }
  }

  private async handleResult(watcher: BaseWatcher, result: WatchResult): Promise<void> {
    const prefix = `[${nowIso()}] [${watcher.name}]`;

    if (result.severity !== 'info') {
      console.log(`${prefix} ${result.severity.toUpperCase()}: ${result.message}`);
    }

    // Auto-healing
    if (!result.ok) {
      const healResult = await this.attemptHeal(watcher, result);
      if (healResult && this.alerter.shouldAlert(result)) {
        await this.alerter.sendAlert({ watcher: watcher.name, result, healResult });
      } else if (this.alerter.shouldAlert(result)) {
        await this.alerter.sendAlert({ watcher: watcher.name, result });
      }
    }
  }

  private async attemptHeal(
    watcher: BaseWatcher,
    result: WatchResult
  ): Promise<import('./healers/base.js').HealResult | null> {
    if (watcher.name === 'GatewayWatcher' && result.event_type === 'gateway_down') {
      if (this.config.healers.processRestart.enabled) {
        console.log(`[${nowIso()}] [ProcessHealer] Attempting to restart gateway...`);
        const healResult = await this.processHealer.heal({});
        console.log(`[${nowIso()}] [ProcessHealer] ${healResult.success ? 'SUCCESS' : 'FAILED'}: ${healResult.message}`);
        return healResult;
      }
    }

    if (watcher.name === 'CronWatcher' && (result.event_type === 'cron_error' || result.event_type === 'cron_overdue')) {
      const context = result.details ?? {};
      const healResult = await this.cronHealer.heal(context as Record<string, unknown>);
      return healResult;
    }

    return null;
  }

  async runOnce(): Promise<Map<string, WatchResult[]>> {
    const allResults = new Map<string, WatchResult[]>();
    for (const entry of this.watchers) {
      try {
        const results = await entry.watcher.check();
        allResults.set(entry.watcher.name, results);
      } catch (err) {
        allResults.set(entry.watcher.name, [{
          ok: false,
          severity: 'error',
          event_type: 'watcher_error',
          message: `Watcher threw: ${String(err)}`,
        }]);
      }
    }
    return allResults;
  }
}
