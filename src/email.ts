/**
 * ClawDoctor email onboarding via Resend API.
 *
 * Usage:
 *   - Set RESEND_API_KEY env var.
 *   - Call sendOnboardingEmail() immediately after `clawdoctor init`.
 *   - Call fireScheduledEmails() from `clawdoctor status` to send overdue Day 3/7 emails.
 *
 * Schedule persisted at ~/.clawdoctor/email-schedule.json
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import os from 'os';

export const EMAIL_SCHEDULE_PATH = path.join(os.homedir(), '.clawdoctor', 'email-schedule.json');

const FROM_ADDRESS = 'ClawDoctor <noreply@clawdoctor.dev>';
const RESEND_API_HOST = 'api.resend.com';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScheduledEmail {
  day: number;
  subject: string;
  scheduledAt: string; // ISO — when this email should be sent
  sentAt: string | null;
}

export interface EmailSchedule {
  email: string;
  installedAt: string;
  emails: ScheduledEmail[];
}

// ── Email copy ────────────────────────────────────────────────────────────────

function buildDay0(email: string): { subject: string; text: string } {
  return {
    subject: "ClawDoctor is watching — here's how to get the most out of it",
    text: `Hi,

ClawDoctor is now installed and monitoring your OpenClaw setup. Here's what to do next.

── Start monitoring ──────────────────────────────────────

  clawdoctor start

This runs the daemon in the foreground. To keep it running persistently:

  clawdoctor install-service
  systemctl --user enable --now clawdoctor

── Check health at any time ──────────────────────────────

  clawdoctor status    # live health check of all monitors
  clawdoctor log       # event history (last 50 events)

── What ClawDoctor watches ───────────────────────────────

  • Gateway process (every 30s)
  • Cron jobs — failures and overdue runs (every 60s)
  • Agent sessions — errors, aborts, stuck sessions (every 60s)
  • Auth token expiry — warns at 24h, 4h, 1h (every 60s)
  • Daily API spend vs. your configured limit (every 5m)

By default ClawDoctor observes and alerts. Auto-fix healing actions
(auto-restart, auth refresh, session kill) require the Heal tier.

See plans at https://clawdoctor.dev/#pricing

Questions? Just reply to this email.

— Matt at ClawDoctor
`,
  };
}

function buildDay3(email: string): { subject: string; text: string } {
  return {
    subject: "3 things to check after your first 72 hours with ClawDoctor",
    text: `Hi,

You've had ClawDoctor running for a few days. Here are 3 things worth checking now:

1. LOOK AT YOUR EVENT LOG

   clawdoctor log -n 100

   Look for orange (error) or red (critical) events — those are worth investigating.
   You can filter by watcher or severity:

     clawdoctor log -w GatewayWatcher -s error

2. CHECK IF CRONS ARE HEALTHY

   ClawDoctor reads cron state from ~/.openclaw/state/cron-*.json
   If any crons have been silently failing you'll see CronWatcher entries in the log.

3. TUNE WHAT YOU MONITOR

   If you're seeing noise from a specific watcher, disable it in ~/.clawdoctor/config.json:
   Set "enabled": false for any watcher you want to silence.

── Coming up on Day 7 ────────────────────────────────────

We'll send a note on what the Heal tier unlocks — specifically the auto-fix actions
that restart your gateway, refresh auth tokens, and kill stuck sessions automatically.

Run clawdoctor status at any time for a live health snapshot.

— Matt at ClawDoctor
`,
  };
}

function buildDay7(email: string): { subject: string; text: string } {
  return {
    subject: "What ClawDoctor Heal tier unlocks (and whether you need it)",
    text: `Hi,

You've been using ClawDoctor for a week. Here's what the Heal tier adds on top of the free tier:

── Free tier ─────────────────────────────────────────────
  • Up to 5 monitors
  • 7-day event history
  • CLI dashboard and log viewer
  • Observe-only (alerts, no auto-fix)

── Heal tier ($19/mo) ────────────────────────────────────
  • Unlimited monitors
  • 90-day event history
  • AUTO-RESTART gateway when it goes down
  • AUTO-REFRESH auth tokens before they expire
  • Kill stuck sessions (Telegram approval for high-cost ones)
  • Full audit trail with rollback snapshots
  • Approval flow for all risky actions

── How to upgrade ────────────────────────────────────────

  1. Get your key at https://clawdoctor.dev/#pricing
  2. clawdoctor activate <your-key>
  3. clawdoctor stop && clawdoctor start

If the free tier is working well for you, no pressure — it's yours for as long as you need it.
If you have questions about whether Heal fits your setup, reply to this email.

— Matt at ClawDoctor
`,
  };
}

// ── Resend API call ───────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY not set' };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, text });

    const options = {
      hostname: RESEND_API_HOST,
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: `HTTP ${res.statusCode}: ${data}` });
        }
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Request timed out' }); });
    req.write(body);
    req.end();
  });
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

function loadSchedule(): EmailSchedule | null {
  try {
    if (fs.existsSync(EMAIL_SCHEDULE_PATH)) {
      return JSON.parse(fs.readFileSync(EMAIL_SCHEDULE_PATH, 'utf-8')) as EmailSchedule;
    }
  } catch {
    // ignore
  }
  return null;
}

function saveSchedule(schedule: EmailSchedule): void {
  const dir = path.dirname(EMAIL_SCHEDULE_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(EMAIL_SCHEDULE_PATH, JSON.stringify(schedule, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call immediately after `clawdoctor init` when the user provides an email.
 * Sends Day 0 email and writes schedule for Days 3 and 7.
 */
export async function sendOnboardingEmail(email: string): Promise<void> {
  const day0 = buildDay0(email);
  const result = await sendEmail(email, day0.subject, day0.text);

  const now = new Date().toISOString();
  const schedule: EmailSchedule = {
    email,
    installedAt: now,
    emails: [
      {
        day: 0,
        subject: day0.subject,
        scheduledAt: now,
        sentAt: result.ok ? now : null,
      },
      {
        day: 3,
        subject: buildDay3(email).subject,
        scheduledAt: daysFromNow(3),
        sentAt: null,
      },
      {
        day: 7,
        subject: buildDay7(email).subject,
        scheduledAt: daysFromNow(7),
        sentAt: null,
      },
    ],
  };

  saveSchedule(schedule);

  if (result.ok) {
    console.log(`📧 Setup guide sent to ${email}`);
  } else {
    // Schedule is saved; Days 3/7 will still fire via `clawdoctor status`
    console.log(`📧 Email scheduled (send failed: ${result.error ?? 'unknown error'})`);
  }
}

/**
 * Call from `clawdoctor status` to dispatch any overdue scheduled emails.
 * No-ops silently if no schedule exists or nothing is due.
 */
export async function fireScheduledEmails(): Promise<void> {
  const schedule = loadSchedule();
  if (!schedule) return;

  const now = new Date();
  let changed = false;

  for (const entry of schedule.emails) {
    if (entry.sentAt !== null) continue;
    if (new Date(entry.scheduledAt) > now) continue;

    let content: { subject: string; text: string };
    if (entry.day === 0) content = buildDay0(schedule.email);
    else if (entry.day === 3) content = buildDay3(schedule.email);
    else if (entry.day === 7) content = buildDay7(schedule.email);
    else continue;

    const result = await sendEmail(schedule.email, content.subject, content.text);
    if (result.ok) {
      entry.sentAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    saveSchedule(schedule);
  }
}
