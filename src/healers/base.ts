import { ClawDoctorConfig } from '../config.js';
import { insertEvent } from '../store.js';
import { nowIso } from '../utils.js';

export interface HealResult {
  success: boolean;
  action: string;
  message: string;
  details?: Record<string, unknown>;
}

export abstract class BaseHealer {
  abstract readonly name: string;

  protected config: ClawDoctorConfig;

  constructor(config: ClawDoctorConfig) {
    this.config = config;
  }

  abstract heal(context: Record<string, unknown>): Promise<HealResult>;

  protected async recordHeal(
    watcherName: string,
    result: HealResult,
    eventType: string
  ): Promise<void> {
    insertEvent({
      timestamp: nowIso(),
      watcher: watcherName,
      severity: result.success ? 'info' : 'error',
      event_type: eventType,
      message: result.message,
      details: result.details ? JSON.stringify(result.details) : undefined,
      action_taken: result.action,
      action_result: result.success ? 'success' : 'failed',
    });
  }
}
