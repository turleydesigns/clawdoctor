import { BaseHealer, HealResult } from './base.js';

export class CronHealer extends BaseHealer {
  readonly name = 'CronHealer';

  async heal(context: Record<string, unknown>): Promise<HealResult> {
    const cronName = (context.cronName as string | undefined) ?? 'unknown';
    const lastRun = (context.lastRun as string | undefined) ?? 'unknown';
    const lastError = (context.lastError as string | undefined) ?? undefined;

    // Phase 0: do not auto-rerun crons, just log and suggest
    const manualCommand = cronName !== 'unknown'
      ? `openclaw cron run ${cronName}`
      : 'openclaw cron run <cron-name>';

    const result: HealResult = {
      success: true,
      action: `logged cron failure for '${cronName}'`,
      message: `Cron '${cronName}' failed${lastError ? `: ${lastError}` : ''}. Last run: ${lastRun}. Manual rerun: \`${manualCommand}\``,
      details: { cronName, lastRun, lastError, manualCommand },
    };

    await this.recordHeal('CronWatcher', result, 'cron_failure_logged');
    return result;
  }
}
