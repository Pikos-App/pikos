/**
 * Launch email blast
 *
 * Before running:
 *   1. Set DATABASE_URL in .env
 *   2. Set RESEND_API_KEY in .env
 *   3. Edit FROM, SUBJECT, and BODY below
 *   4. Run: pnpm send-launch
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

// ─── Edit these before sending ────────────────────────────────────────────────

const FROM = "Pikos <hello@pikos.app>"; // must be a verified Resend domain/address
const SUBJECT = "Pikos is launching \u2014 you're first to know";
const BODY_HTML = `
<p>Hi there,</p>
<p>We're launching Pikos \u2014 the local-first app that combines notes, tasks, and calendar in one place. No account required.</p>
<p><strong>Download it here:</strong> <a href="https://pikos.app">pikos.app</a></p>
<p>Thanks for your interest. We hope you love it.</p>
<p>\u2014 Alex</p>
`;
const BODY_TEXT = `
Hi there,

We're launching Pikos \u2014 the local-first app that combines notes, tasks, and calendar in one place. No account required.

Download it here: https://pikos.app

Thanks for your interest. We hope you love it.

\u2014 Alex
`.trim();

// ─── End of editable section ─────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dotenv dependency required)
const envPath = resolve(__dirname, "../.env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error("Error: RESEND_API_KEY is not set.");
  process.exit(1);
}

// Load emails from postgres
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const { rows } = await pool.query("SELECT email FROM waitlist ORDER BY created_at");
await pool.end();

const emails = rows.map((r) => r.email);

if (!emails.length) {
  console.log("No emails to send to. Exiting.");
  process.exit(0);
}

console.log(`Sending to ${emails.length} recipient(s)\u2026`);

// Resend batch API allows up to 100 emails per request
const BATCH_SIZE = 100;
let sent = 0;

for (let i = 0; i < emails.length; i += BATCH_SIZE) {
  const batch = emails.slice(i, i + BATCH_SIZE).map((to) => ({
    from: FROM,
    to,
    subject: SUBJECT,
    html: BODY_HTML,
    text: BODY_TEXT,
  }));

  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(batch),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err);
    process.exit(1);
  }

  sent += batch.length;
  console.log(`  Sent batch ${Math.floor(i / BATCH_SIZE) + 1}: ${sent}/${emails.length}`);
}

console.log(`Done. ${sent} email(s) sent.`);
