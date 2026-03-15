import { BaseHealer, HealResult } from './base.js';
import { runShell } from '../utils.js';

const TRANSIENT_ERROR_PATTERNS = [
  /network/i,
  /timeout/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /rate.?limit/i,
  /503/,
  /504/,
  /temporarily unavailable/i,
];

function isTransientError(errorMsg: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some(p => p.test(errorMsg));
}

export class CronHealer extends BaseHealer {
  readonly name = 'CronHealer';

  async heal(context: Record<string, unknown>): Promise<HealResult> {
    const cronName = (context.cronName as string | undefined) ?? 'unknown';
    const consecutiveErrors = (context.consecutiveErrors as number | undefined) ?? 0;
    const lastError = (context.lastError as string | undefined) ?? '';
    const lastRun = (context.lastRun as string | undefined) ?? 'unknown';
    const dryRun = this.isEffectiveDryRun(this.config.healers.cronRetry.dryRun);

    // Yellow tier: 5+ consecutive errors, ask via Telegram
    if (consecutiveErrors >= 5) {
      if (dryRun) {
        this.writeAudit('cron-ask', cronName, 'yellow', 'dry-run');
        return {
          success: true,
          action: `dry-run: would send Telegram approval for '${cronName}'`,
          message: `[DRY RUN] Would request approval for cron '${cronName}' (${consecutiveErrors} errors)`,
          tier: 'yellow',
        };
      }
      this.writeAudit('cron-ask', cronName, 'yellow', 'pending');
      const result: HealResult = {
        success: true,
        action: `requested approval for cron '${cronName}'`,
        message: `Cron '${cronName}' has ${consecutiveErrors} consecutive errors. Approval requested.`,
        details: { cronName, consecutiveErrors, lastError, lastRun },
        tier: 'yellow',
        requiresApproval: true,
        approvalOptions: [
          { text: 'Retry Now', callbackData: `cron:retry:${cronName}` },
          { text: 'Disable', callbackData: `cron:disable:${cronName}` },
          { text: 'Ignore', callbackData: `cron:ignore:${cronName}` },
        ],
      };
      await this.recordHeal('CronWatcher', result, 'cron_approval_requested');
      return result;
    }

    // Green tier: re-enable if it was auto-disabled due to transient errors
    const transient = isTransientError(lastError);

    if (consecutiveErrors >= 3 && transient) {
      if (dryRun) {
        this.writeAudit('cron-retry', cronName, 'green', 'dry-run');
        return {
          success: true,
          action: `dry-run: would re-enable '${cronName}'`,
          message: `[DRY RUN] Would re-enable cron '${cronName}' (transient error)`,
          tier: 'green',
        };
      }

      const snapshotId = this.takeSnapshot(
        'cron-retry',
        cronName,
        { consecutiveErrors, lastError, lastRun },
        `openclaw cron disable ${cronName}`
      );

      const enableResult = runShell(`openclaw cron enable ${cronName}`);
      if (enableResult.ok) {
        const result: HealResult = {
          success: true,
          action: `openclaw cron enable ${cronName}`,
          message: `Cron '${cronName}' re-enabled after transient error`,
          details: { cronName, consecutiveErrors, lastError, snapshotId },
          tier: 'green',
          snapshotId,
        };
        await this.recordHeal('CronWatcher', result, 'cron_reenabled');
        this.writeAudit('cron-retry', cronName, 'green', 'success', snapshotId);
        return result;
      }

      const result: HealResult = {
        success: false,
        action: `openclaw cron enable ${cronName}`,
        message: `Failed to re-enable cron '${cronName}': ${enableResult.stderr.slice(0, 200)}`,
        details: { cronName, consecutiveErrors, lastError, snapshotId },
        tier: 'green',
        snapshotId,
      };
      await this.recordHeal('CronWatcher', result, 'cron_reenable_failed');
      this.writeAudit('cron-retry', cronName, 'green', 'failed', snapshotId);
      return result;
    }

    // Default: log and suggest manual rerun
    const manualCommand = cronName !== 'unknown'
      ? `openclaw cron run ${cronName}`
      : 'openclaw cron run <cron-name>';

    const result: HealResult = {
      success: true,
      action: `logged cron failure for '${cronName}'`,
      message: `Cron '${cronName}' failed${lastError ? `: ${lastError}` : ''}. Last run: ${lastRun}. Manual rerun: \`${manualCommand}\``,
      details: { cronName, lastRun, lastError, manualCommand },
      tier: 'green',
    };
    await this.recordHeal('CronWatcher', result, 'cron_failure_logged');
    this.writeAudit('cron-log', cronName, 'green', 'success');
    return result;
  }
}
