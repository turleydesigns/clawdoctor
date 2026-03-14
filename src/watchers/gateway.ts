import { BaseWatcher, WatchResult } from './base.js';
import { runShell } from '../utils.js';

export class GatewayWatcher extends BaseWatcher {
  readonly name = 'GatewayWatcher';
  readonly defaultInterval = 30;

  async check(): Promise<WatchResult[]> {
    // Try pgrep first
    const pgrep = runShell('pgrep -f "openclaw"');
    if (pgrep.ok && pgrep.stdout.trim().length > 0) {
      const pids = pgrep.stdout.trim().split('\n').join(', ');
      return [this.ok(`Gateway process running (PIDs: ${pids})`, 'gateway_running')];
    }

    // Try systemctl
    const systemctl = runShell('systemctl is-active openclaw-gateway 2>/dev/null');
    if (systemctl.ok && systemctl.stdout.trim() === 'active') {
      return [this.ok('Gateway systemd service active', 'gateway_running')];
    }

    return [
      this.critical(
        'Gateway process not found',
        'gateway_down',
        { pgrep_stdout: pgrep.stdout, pgrep_stderr: pgrep.stderr }
      ),
    ];
  }
}
