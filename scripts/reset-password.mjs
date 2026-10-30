#!/usr/bin/env node
// Local "forgot password" for the real instance: run it yourself in Terminal.
//   node scripts/reset-password.mjs you@example.com
// Asks for the new password without echoing it, hashes it exactly like the
// server (PBKDF2-SHA256, 100k iterations), and signs out every session/token.
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/reset-password.mjs <email>");
  process.exit(1);
}
const dir = join(homedir(), ".finance/local/v3/d1/miniflare-D1DatabaseObject");
const db = join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && !f.includes("metadata")));
const q = (sql) => execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
const id = q(`SELECT id FROM users WHERE email = '${email.replace(/'/g, "''")}' COLLATE NOCASE`);
if (!id) {
  console.error(`No account for ${email}. Accounts: ${q("SELECT email FROM users") || "none"}`);
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let s = "";
    const onData = (buf) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(s);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const pw = await ask("New password (10+ characters): ");
if (pw.length < 10) {
  console.error("Too short. Nothing changed.");
  process.exit(1);
}
if ((await ask("Again: ")) !== pw) {
  console.error("They don't match. Nothing changed.");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, 100_000, 32, "sha256");
const stored = `pbkdf2-sha256$100000$${salt.toString("base64")}$${hash.toString("base64")}`;
q(`UPDATE users SET password_hash = '${stored}' WHERE id = '${id}'; DELETE FROM tokens WHERE user_id = '${id}' AND kind = 'session';`);
console.log(`Password reset for ${email}. Sign in at http://localhost:5190 (CLI and agent tokens still work).`);
