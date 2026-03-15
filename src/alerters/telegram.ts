import { ClawDoctorConfig } from '../config.js';
import { WatchResult } from '../watchers/base.js';
import { HealResult } from '../healers/base.js';
import { nowUtcDisplay, hostname } from '../utils.js';

const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes per monitor

const TELEGRAM_API = 'https://api.telegram.org';

interface AlertPayload {
  watcher: string;
  result: WatchResult;
  healResult?: HealResult;
}

export class TelegramAlerter {
  private config: ClawDoctorConfig;
  private lastAlertTime: Map<string, number> = new Map();

  constructor(config: ClawDoctorConfig) {
    this.config = config;
  }

  private isRateLimited(watcherName: string): boolean {
    const lastAlert = this.lastAlertTime.get(watcherName) ?? 0;
    return Date.now() - lastAlert < RATE_LIMIT_MS;
  }

  private markAlerted(watcherName: string): void {
    this.lastAlertTime.set(watcherName, Date.now());
  }

  shouldAlert(result: WatchResult): boolean {
    return result.severity === 'error' || result.severity === 'critical' || result.severity === 'warning';
  }

  async sendAlert(payload: AlertPayload): Promise<boolean> {
    const { telegram } = this.config.alerts;

    if (!telegram.enabled || !telegram.botToken || !telegram.chatId) {
      return false;
    }

    if (this.isRateLimited(payload.watcher)) {
      return false;
    }

    const message = this.formatMessage(payload);

    try {
      const url = `${TELEGRAM_API}/bot${telegram.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (response.ok) {
        this.markAlerted(payload.watcher);
        return true;
      } else {
        const body = await response.text();
        console.error(`[TelegramAlerter] Failed to send alert: ${response.status} ${body}`);
        return false;
      }
    } catch (err) {
      console.error(`[TelegramAlerter] Error sending alert:`, err);
      return false;
    }
  }

  formatMessage(payload: AlertPayload): string {
    const { watcher, result, healResult } = payload;
    const isOk = result.ok || result.severity === 'info';
    const icon = isOk ? '🟢' : (result.severity === 'critical' ? '🔴' : '🟡');

    const actionLine = healResult
      ? `Action: ${healResult.action}\nStatus: ${healResult.success ? '✅ ' + healResult.message : '❌ ' + healResult.message}`
      : '';

    const lines = [
      `${icon} <b>ClawDoctor Alert</b>`,
      `Monitor: ${watcher}`,
      `Event: ${result.message}`,
      ...(actionLine ? [actionLine] : []),
      '─────',
      `Time: ${nowUtcDisplay()}`,
      `Host: ${hostname()}`,
    ];

    return lines.join('\n');
  }

  async sendRecovery(watcherName: string, message: string): Promise<boolean> {
    const fakeResult: WatchResult = {
      ok: true,
      severity: 'info',
      event_type: 'recovered',
      message,
    };
    return this.sendAlert({ watcher: watcherName, result: fakeResult });
  }
}
