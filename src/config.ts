import fs from 'fs';
import path from 'path';
import os from 'os';

export interface WatcherConfig {
  enabled: boolean;
  interval: number;
}

export interface HealerConfig {
  enabled: boolean;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

export interface AlertsConfig {
  telegram: TelegramConfig;
}

export interface ClawDoctorConfig {
  openclawPath: string;
  watchers: {
    gateway: WatcherConfig;
    cron: WatcherConfig;
    session: WatcherConfig;
    auth: WatcherConfig;
    cost: WatcherConfig;
  };
  healers: {
    processRestart: HealerConfig;
    cronRetry: HealerConfig;
  };
  alerts: AlertsConfig;
  dryRun: boolean;
  retentionDays: number;
}

export const AGENTWATCH_DIR = path.join(os.homedir(), '.clawdoctor');
export const CONFIG_PATH = path.join(AGENTWATCH_DIR, 'config.json');
export const DB_PATH = path.join(AGENTWATCH_DIR, 'events.db');
export const PID_PATH = path.join(AGENTWATCH_DIR, 'clawdoctor.pid');

export const DEFAULT_CONFIG: ClawDoctorConfig = {
  openclawPath: path.join(os.homedir(), '.openclaw'),
  watchers: {
    gateway: { enabled: true, interval: 30 },
    cron: { enabled: true, interval: 60 },
    session: { enabled: true, interval: 60 },
    auth: { enabled: true, interval: 60 },
    cost: { enabled: true, interval: 300 },
  },
  healers: {
    processRestart: { enabled: true },
    cronRetry: { enabled: false },
  },
  alerts: {
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
    },
  },
  dryRun: false,
  retentionDays: 7,
};

export function loadConfig(): ClawDoctorConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Run 'clawdoctor init' first.`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<ClawDoctorConfig>;
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

function mergeConfig(defaults: ClawDoctorConfig, overrides: Partial<ClawDoctorConfig>): ClawDoctorConfig {
  return {
    ...defaults,
    ...overrides,
    watchers: { ...defaults.watchers, ...(overrides.watchers ?? {}) },
    healers: { ...defaults.healers, ...(overrides.healers ?? {}) },
    alerts: {
      ...defaults.alerts,
      ...(overrides.alerts ?? {}),
      telegram: {
        ...defaults.alerts.telegram,
        ...(overrides.alerts?.telegram ?? {}),
      },
    },
  };
}

export function saveConfig(config: ClawDoctorConfig): void {
  ensureAgentwatchDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function ensureAgentwatchDir(): void {
  if (!fs.existsSync(AGENTWATCH_DIR)) {
    fs.mkdirSync(AGENTWATCH_DIR, { recursive: true });
  }
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}
