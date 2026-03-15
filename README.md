# clawdoctor

Self-healing monitor for OpenClaw. Watches your gateway, crons, and agent sessions, sends Telegram alerts, and auto-fixes what it can.

Built by people who run 20+ OpenClaw agents in production and got tired of checking if things were still alive.

## Install

```bash
npm install -g clawdoctor
```

## Quick Start

```bash
# Configure
clawdoctor init

# Start monitoring
clawdoctor start
```

## Commands

```bash
clawdoctor init             # Interactive setup
clawdoctor start            # Start monitoring daemon
clawdoctor start --dry-run  # Run without taking healing actions
clawdoctor stop             # Stop daemon
clawdoctor status           # Live health check of all monitors
clawdoctor log              # Show recent events from local database
clawdoctor log -n 100       # Show 100 events
clawdoctor log -w GatewayWatcher -s critical  # Filter by watcher/severity
clawdoctor install-service  # Install as systemd user service
```

## What It Monitors

| Monitor | What It Watches | Interval |
|---------|-----------------|----------|
| **GatewayWatcher** | `openclaw` process running | 30s |
| **CronWatcher** | `~/.openclaw/state/cron-*.json` for missed/failed crons | 60s |
| **SessionWatcher** | `~/.openclaw/agents/*/sessions/*.jsonl` for errors, aborts, stuck sessions | 60s |
| **AuthWatcher** | Gateway logs for 401/403/token expired patterns | 60s |
| **CostWatcher** | Session token costs - flags if >3x rolling average | 5m |

## What It Fixes

| Healer | Action |
|--------|--------|
| **ProcessHealer** | Restarts gateway via `systemctl restart openclaw-gateway` or `openclaw gateway restart`, then verifies |
| **CronHealer** | Logs the failure and includes the manual rerun command in the alert (Phase 0 - no auto-rerun) |

## Alerts

Telegram alerts with rate limiting (max 1 per monitor per 5 minutes):

```
🔴 ClawDoctor Alert
Monitor: GatewayWatcher
Event: Gateway process not found
Action: openclaw gateway restart
Status: ✅ Back online
─────
Time: 2026-03-15 03:14 UTC
Host: devbox
```

## Configuration

Config lives at `~/.clawdoctor/config.json`:

```json
{
  "openclawPath": "/root/.openclaw",
  "watchers": {
    "gateway": { "enabled": true, "interval": 30 },
    "cron": { "enabled": true, "interval": 60 },
    "session": { "enabled": true, "interval": 60 },
    "auth": { "enabled": true, "interval": 60 },
    "cost": { "enabled": true, "interval": 300 }
  },
  "healers": {
    "processRestart": { "enabled": true },
    "cronRetry": { "enabled": false }
  },
  "alerts": {
    "telegram": {
      "enabled": true,
      "botToken": "your-bot-token",
      "chatId": "your-chat-id"
    }
  },
  "dryRun": false,
  "retentionDays": 7
}
```

Events are stored in `~/.clawdoctor/events.db` (SQLite) and retained for 7 days by default.

## Systemd

```bash
clawdoctor install-service
systemctl --user daemon-reload
systemctl --user enable clawdoctor
systemctl --user start clawdoctor
```

## License

MIT
