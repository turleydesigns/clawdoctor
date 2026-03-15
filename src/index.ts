#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import {
  loadConfig,
  saveConfig,
  configExists,
  DEFAULT_CONFIG,
  AGENTWATCH_DIR,
  PID_PATH,
  ClawDoctorConfig,
} from './config.js';
import { Daemon } from './daemon.js';
import { getRecentEvents, pruneOldEvents } from './store.js';
import { nowIso, runShell } from './utils.js';

const pkg = { version: '0.1.0' };

const program = new Command();

program
  .name('clawdoctor')
  .description('Self-healing doctor for OpenClaw')
  .version(pkg.version);

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Interactive setup: detect OpenClaw, configure alerts')
  .action(async () => {
    console.log('\n🔍 ClawDoctor Setup\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (question: string, defaultVal = ''): Promise<string> =>
      new Promise(resolve => {
        const hint = defaultVal ? ` [${defaultVal}]` : '';
        rl.question(`${question}${hint}: `, answer => {
          resolve(answer.trim() || defaultVal);
        });
      });

    // Detect OpenClaw
    const defaultOpenclawPath = path.join(os.homedir(), '.openclaw');
    const openclawExists = fs.existsSync(defaultOpenclawPath);
    const openclawhWhich = runShell('which openclaw');

    if (openclawExists) {
      console.log(`✅ Found OpenClaw at ${defaultOpenclawPath}`);
    } else {
      console.log(`⚠️  OpenClaw not found at ${defaultOpenclawPath}`);
    }

    if (openclawhWhich.ok) {
      console.log(`✅ openclaw binary found at ${openclawhWhich.stdout.trim()}`);
    } else {
      console.log(`⚠️  openclaw binary not found in PATH`);
    }

    console.log('');

    const openclawPath = await ask('OpenClaw data path', defaultOpenclawPath);

    // Telegram setup
    console.log('\n📱 Telegram Alerts (optional — press Enter to skip)\n');
    const botToken = await ask('Telegram bot token (leave blank to skip)');
    let chatId = '';
    if (botToken) {
      chatId = await ask('Telegram chat ID');
    }

    // Watcher preferences
    console.log('\n⚙️  Watcher Configuration\n');
    const enableGateway = (await ask('Monitor gateway process?', 'yes')).toLowerCase() !== 'no';
    const enableCron = (await ask('Monitor crons?', 'yes')).toLowerCase() !== 'no';
    const enableSession = (await ask('Monitor sessions?', 'yes')).toLowerCase() !== 'no';
    const enableAuth = (await ask('Monitor auth failures?', 'yes')).toLowerCase() !== 'no';
    const enableCost = (await ask('Monitor cost anomalies?', 'yes')).toLowerCase() !== 'no';

    // Healer preferences
    console.log('\n🔧 Auto-Fix Configuration\n');
    const enableProcessRestart = (await ask('Auto-restart gateway on failure?', 'yes')).toLowerCase() !== 'no';

    // Dry run?
    const dryRun = (await ask('Enable dry-run mode (no actual healing)?', 'no')).toLowerCase() === 'yes';

    rl.close();

    const config: ClawDoctorConfig = {
      ...DEFAULT_CONFIG,
      openclawPath,
      watchers: {
        gateway: { enabled: enableGateway, interval: 30 },
        cron: { enabled: enableCron, interval: 60 },
        session: { enabled: enableSession, interval: 60 },
        auth: { enabled: enableAuth, interval: 60 },
        cost: { enabled: enableCost, interval: 300 },
      },
      healers: {
        processRestart: { enabled: enableProcessRestart },
        cronRetry: { enabled: false },
      },
      alerts: {
        telegram: {
          enabled: !!(botToken && chatId),
          botToken: botToken || '',
          chatId: chatId || '',
        },
      },
      dryRun,
      retentionDays: 7,
    };

    saveConfig(config);
    console.log(`\n✅ Config saved to ${AGENTWATCH_DIR}/config.json`);

    // Offer systemd install
    console.log('\n💡 To start monitoring now, run: clawdoctor start');
    console.log('💡 To install as a systemd service, run: clawdoctor install-service');
    console.log('');
  });

// ── start ─────────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start monitoring daemon (foreground)')
  .option('--dry-run', 'Run in dry-run mode (no healing actions)')
  .action((opts: { dryRun?: boolean }) => {
    let config: ClawDoctorConfig;
    try {
      config = loadConfig();
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }

    if (opts.dryRun) config.dryRun = true;

    // Write PID file
    fs.mkdirSync(AGENTWATCH_DIR, { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid), 'utf-8');

    const daemon = new Daemon(config);

    const shutdown = () => {
      daemon.stop();
      try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    daemon.start();
  });

// ── stop ──────────────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the running daemon')
  .action(() => {
    if (!fs.existsSync(PID_PATH)) {
      console.log('No daemon PID file found. Is clawdoctor running?');
      process.exit(1);
    }

    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
    if (isNaN(pid)) {
      console.error('Invalid PID file');
      process.exit(1);
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to PID ${pid}`);
    } catch (err) {
      console.error(`Failed to stop daemon (PID ${pid}):`, err);
      process.exit(1);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show current health of all monitors')
  .action(async () => {
    let config: ClawDoctorConfig;
    try {
      config = loadConfig();
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }

    const daemonRunning = isDaemonRunning();
    console.log(`\nClawDoctor Status`);
    console.log(`─────────────────`);
    console.log(`Daemon:     ${daemonRunning ? '✅ running' : '⚪ stopped'}`);
    console.log(`Config:     ${AGENTWATCH_DIR}/config.json`);
    console.log(`Dry Run:    ${config.dryRun ? 'yes' : 'no'}`);
    console.log(`Telegram:   ${config.alerts.telegram.enabled ? '✅ enabled' : '⚪ disabled'}`);
    console.log('');
    console.log('Watchers:');
    for (const [name, watcher] of Object.entries(config.watchers)) {
      console.log(`  ${watcher.enabled ? '✅' : '⚪'} ${name.padEnd(10)} (every ${watcher.interval}s)`);
    }
    console.log('');
    console.log('Healers:');
    for (const [name, healer] of Object.entries(config.healers)) {
      console.log(`  ${healer.enabled ? '✅' : '⚪'} ${name}`);
    }

    // Run a quick check
    console.log('\nRunning quick check...\n');
    const daemon = new Daemon(config);
    const results = await daemon.runOnce();

    for (const [watcherName, watchResults] of results) {
      for (const result of watchResults) {
        const icon = result.ok ? '✅' : (result.severity === 'critical' ? '🔴' : result.severity === 'error' ? '🟠' : '🟡');
        console.log(`${icon} [${watcherName}] ${result.message}`);
      }
    }
    console.log('');
  });

// ── log ───────────────────────────────────────────────────────────────────────
program
  .command('log')
  .description('Show recent events from local SQLite')
  .option('-n, --lines <number>', 'Number of events to show', '50')
  .option('-w, --watcher <name>', 'Filter by watcher name')
  .option('-s, --severity <level>', 'Filter by severity (info|warning|error|critical)')
  .action((opts: { lines: string; watcher?: string; severity?: string }) => {
    const limit = parseInt(opts.lines, 10);
    let config: ClawDoctorConfig;
    try {
      config = loadConfig();
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }

    // Prune first
    pruneOldEvents(config.retentionDays);

    const events = getRecentEvents(
      limit,
      opts.watcher,
      opts.severity as import('./store.js').Severity | undefined
    );

    if (events.length === 0) {
      console.log('No events found.');
      return;
    }

    console.log(`\nRecent Events (${events.length})\n`);
    for (const event of events.reverse()) {
      const severityIcon = { info: '⚪', warning: '🟡', error: '🟠', critical: '🔴' }[event.severity] ?? '⚪';
      const ts = event.timestamp.slice(0, 19).replace('T', ' ');
      console.log(`${severityIcon} ${ts}  [${event.watcher}]  ${event.message}`);
      if (event.action_taken) {
        console.log(`   → ${event.action_taken}: ${event.action_result ?? ''}`);
      }
    }
    console.log('');
  });

// ── install-service ───────────────────────────────────────────────────────────
program
  .command('install-service')
  .description('Install clawdoctor as a systemd user service')
  .action(() => {
    const agentWatchBin = runShell('which clawdoctor').stdout.trim() || process.argv[1];
    const serviceContent = `[Unit]
Description=ClawDoctor — OpenClaw monitor
After=network.target

[Service]
Type=simple
ExecStart=${agentWatchBin} start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

    const systemdUserDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(systemdUserDir, { recursive: true });
    const serviceFile = path.join(systemdUserDir, 'clawdoctor.service');
    fs.writeFileSync(serviceFile, serviceContent, 'utf-8');

    console.log(`✅ Service file written to ${serviceFile}`);
    console.log('\nTo enable and start:');
    console.log('  systemctl --user daemon-reload');
    console.log('  systemctl --user enable clawdoctor');
    console.log('  systemctl --user start clawdoctor');
    console.log('');
  });

function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    return false;
  }
}

program.parse(process.argv);
