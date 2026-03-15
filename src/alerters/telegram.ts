import { ClawDoctorConfig } from '../config.js';
import { WatchResult } from '../watchers/base.js';
import { HealResult } from '../healers/base.js';
import { nowUtcDisplay, hostname, nowIso } from '../utils.js';

const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes per monitor

const TELEGRAM_API = 'https://api.telegram.org';

interface AlertPayload {
  watcher: string;
  result: WatchResult;
  healResult?: HealResult;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

interface PendingCallback {
  handler: () => Promise<void>;
  expiresAt: number;
}

export class TelegramAlerter {
  private config: ClawDoctorConfig;
  private lastAlertTime: Map<string, number> = new Map();
  private pendingCallbacks: Map<string, PendingCallback> = new Map();
  private lastUpdateId = 0;

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

  async sendWithButtons(
    text: string,
    buttons: InlineButton[][],
    handlers: Record<string, () => Promise<void>>
  ): Promise<boolean> {
    const { telegram } = this.config.alerts;

    if (!telegram.enabled || !telegram.botToken || !telegram.chatId) {
      return false;
    }

    try {
      const url = `${TELEGRAM_API}/bot${telegram.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: buttons,
          },
        }),
      });

      if (response.ok) {
        // Register handlers with 24-hour expiry
        const expiresAt = Date.now() + 24 * 3600 * 1000;
        for (const [callbackData, handler] of Object.entries(handlers)) {
          this.pendingCallbacks.set(callbackData, { handler, expiresAt });
        }
        return true;
      } else {
        const body = await response.text();
        console.error(`[TelegramAlerter] Failed to send inline message: ${response.status} ${body}`);
        return false;
      }
    } catch (err) {
      console.error(`[TelegramAlerter] Error sending inline message:`, err);
      return false;
    }
  }

  async pollCallbacks(): Promise<void> {
    const { telegram } = this.config.alerts;

    if (!telegram.enabled || !telegram.botToken || !telegram.chatId) {
      return;
    }

    // Evict expired callbacks
    const now = Date.now();
    for (const [key, pending] of this.pendingCallbacks) {
      if (now > pending.expiresAt) {
        this.pendingCallbacks.delete(key);
      }
    }

    if (this.pendingCallbacks.size === 0) {
      return;
    }

    try {
      const url = `${TELEGRAM_API}/bot${telegram.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=1&allowed_updates=["callback_query"]`;
      const response = await fetch(url);
      if (!response.ok) return;

      const data = await response.json() as {
        ok: boolean;
        result: Array<{
          update_id: number;
          callback_query?: {
            id: string;
            data?: string;
          };
        }>;
      };

      if (!data.ok || !data.result?.length) return;

      for (const update of data.result) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

        const cbq = update.callback_query;
        if (!cbq?.data) continue;

        const pending = this.pendingCallbacks.get(cbq.data);
        if (!pending) continue;

        // Answer the callback query to remove loading state
        try {
          await fetch(`${TELEGRAM_API}/bot${telegram.botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cbq.id, text: 'Processing...' }),
          });
        } catch { /* ignore */ }

        // Remove handler and execute
        this.pendingCallbacks.delete(cbq.data);
        console.log(`[${nowIso()}] [TelegramAlerter] Callback received: ${cbq.data}`);
        pending.handler().catch(err => {
          console.error(`[TelegramAlerter] Callback handler error:`, err);
        });
      }
    } catch (err) {
      console.error(`[TelegramAlerter] Poll error:`, err);
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

  formatApprovalMessage(
    watcher: string,
    message: string,
    options: Array<{ text: string; callbackData: string }>
  ): { text: string; buttons: InlineButton[][] } {
    const lines = [
      `🟡 <b>ClawDoctor: Action Required</b>`,
      `Monitor: ${watcher}`,
      `Issue: ${message}`,
      '─────',
      `Time: ${nowUtcDisplay()}`,
      `Host: ${hostname()}`,
    ];

    const buttons: InlineButton[][] = [
      options.map(o => ({ text: o.text, callback_data: o.callbackData })),
    ];

    return { text: lines.join('\n'), buttons };
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
