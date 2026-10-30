// fin — the command-line client. Talks to the same HTTP API as the web app,
// authenticated with a revocable personal token. No dependencies.
//
//   fin login --url https://finance.example.com
//   fin "chai 40 cash"                 smart add (Jev), asks before saving
//   fin add 250 food lunch             exact add
//   fin ask "spent on food last month"
//   fin ls --month 2026-10   ·   fin summary   ·   fin accounts
//
// Every command takes --json for scripts and agents.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { addMonths, fiscalYear, monthOf, monthRange, MONTH_RE, parseDateInput, today } from "../../shared/dates";
import { STATEMENT_SCHEMA, type StatementV1 } from "../../shared/statement";
import { uuidv7 } from "../../shared/ids";
import { displayBalance } from "../../shared/ledger";
import { formatMoney, parseAmount, toDecimal } from "../../shared/money";
import type { Account, AssistResult, Contact, EmiPlan, Subscription, Entity, EntryKind, ImportPlan, Me, ReviewItem, Summary, Transaction, TransactionInput } from "../../shared/types";

const VERSION = "0.1.0";

// ---- Config & profiles ------------------------------------------------------------

interface Profile {
  url: string;
  token: string;
  entityId?: string;
}
interface Config {
  current: string;
  profiles: Record<string, Profile>;
}

const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fin");
const configPath = join(configDir, "config.json");

function loadConfig(): Config {
  if (!existsSync(configPath)) return { current: "default", profiles: {} };
  return JSON.parse(readFileSync(configPath, "utf8")) as Config;
}
function saveConfig(cfg: Config) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath, 0o600); // tokens are credentials
}

// ---- Output helpers ---------------------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint(2), bold: paint(1), red: paint(31), green: paint(32), blue: paint(34), yellow: paint(33) };

class CliError extends Error {
  constructor(
    message: string,
    public code = 1,
  ) {
    super(message);
  }
}

function table(rows: string[][], align: ("l" | "r")[] = []) {
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => visible(r[i] ?? "")))) ?? [];
  for (const r of rows) {
    console.log(
      r
        .map((cell, i) => {
          const pad = " ".repeat(Math.max(0, widths[i] - visible(cell)));
          return align[i] === "r" ? pad + cell : cell + pad;
        })
        .join("  ")
        .trimEnd(),
    );
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

async function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let prompted = false;
  out._writeToOutput = (s: string) => {
    if (!prompted) {
      process.stdout.write(s);
      prompted = true;
    }
  };
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    }),
  );
}

// ---- Cloudflare Access -------------------------------------------------------------
// A deployment behind Cloudflare Access needs a service token on every request.
// From FIN_CF_ACCESS_CLIENT_ID/SECRET, or the macOS Keychain (service finance.cf-access,
// accounts "<host>:client-id" and "<host>:client-secret"). Never stored in the config file.
const accessCache = new Map<string, Record<string, string>>();
function accessHeaders(url: string): Record<string, string> {
  const host = new URL(url).host;
  if (accessCache.has(host)) return accessCache.get(host)!;
  let id = process.env.FIN_CF_ACCESS_CLIENT_ID;
  let secret = process.env.FIN_CF_ACCESS_CLIENT_SECRET;
  if ((!id || !secret) && process.platform === "darwin" && !/^(localhost|127\.)/.test(host)) {
    const kc = (acct: string) => {
      try {
        return execFileSync("security", ["find-generic-password", "-s", "finance.cf-access", "-a", acct, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return undefined;
      }
    };
    id = kc(`${host}:client-id`);
    secret = kc(`${host}:client-secret`);
  }
  const h: Record<string, string> = id && secret ? { "cf-access-client-id": id, "cf-access-client-secret": secret } : {};
  accessCache.set(host, h);
  return h;
}

/** Access answers a blocked request with a login page or 403 HTML, not our JSON. */
function accessBlocked(res: Response) {
  return (res.status === 302 || res.status === 403) && !(res.headers.get("content-type") ?? "").includes("json");
}
const ACCESS_HELP = "Cloudflare Access blocked the request. Store the service token in the Keychain (service finance.cf-access, accounts <host>:client-id / <host>:client-secret) or set FIN_CF_ACCESS_CLIENT_ID and FIN_CF_ACCESS_CLIENT_SECRET.";

/** fetch, retried on network errors (flaky IPv6 / Wi-Fi blips), never on HTTP errors. */
async function fetchRetry(url: string, init: RequestInit, tries = 4): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

// ---- API client --------------------------------------------------------------------

class Client {
  constructor(
    public profile: Profile,
    public profileName: string,
  ) {}

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchRetry(this.profile.url.replace(/\/$/, "") + "/api" + path, {
        method,
        redirect: "manual",
        headers: {
          ...accessHeaders(this.profile.url),
          authorization: `Bearer ${this.profile.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": `fin-cli/${VERSION}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      throw new CliError(`Can't reach ${this.profile.url} (${e.cause?.code ?? e.cause?.message ?? e.message}). Is it running?`);
    }
    if (accessBlocked(res)) throw new CliError(ACCESS_HELP);
    if (res.status === 401) throw new CliError(`Not signed in (or the token was revoked). Run: fin login${this.profileName !== "default" ? ` --profile ${this.profileName}` : ""}`);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const data = type.includes("json") ? ((await res.json()) as { error?: { message: string } }) : null;
      throw new CliError(data?.error?.message ?? `${res.status} ${res.statusText}`);
    }
    return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
  }
}

// ---- Context: profile, entity, chart of accounts -------------------------------------

interface Ctx {
  client: Client;
  cfg: Config;
  profileName: string;
  json: boolean;
  entityFlag?: string;
}

async function entityOf(ctx: Ctx): Promise<Entity> {
  const me = await ctx.client.req<Me>("GET", "/me");
  if (!me.entities.length) throw new CliError("You don't have any entities yet. Create one in the web app.");
  const wanted = ctx.entityFlag ?? process.env.FIN_ENTITY ?? ctx.client.profile.entityId;
  if (!wanted) return me.entities[0];
  const byId = me.entities.find((e) => e.id === wanted);
  return byId ?? pick(wanted, me.entities, "entity");
}

/** Case-insensitive match on name: exact, then prefix, then substring. Ambiguity is an error, never a guess. */
function pick<T extends { name: string }>(query: string, items: T[], what: string): T {
  const q = query.toLowerCase().trim();
  const tiers = [
    items.filter((i) => i.name.toLowerCase() === q),
    items.filter((i) => i.name.toLowerCase().startsWith(q)),
    items.filter((i) => i.name.toLowerCase().split(/[\s&,/-]+/).some((w) => w.startsWith(q))),
    items.filter((i) => i.name.toLowerCase().includes(q)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) throw new CliError(`"${query}" matches several ${what}s: ${tier.map((i) => i.name).join(", ")}`);
  }
  // Show the closest few, not the whole list.
  const close = items
    .map((i) => ({ i, d: [...new Set(q)].filter((ch) => i.name.toLowerCase().includes(ch)).length / Math.max(q.length, 1) }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 6)
    .map((x) => x.i.name);
  throw new CliError(`No ${what} called "${query}".${items.length <= 12 ? ` Options: ${items.map((i) => i.name).join(", ")}` : ` Closest: ${close.join(", ")} (${items.length} in all)`}`);
}

async function chart(ctx: Ctx, entity: Entity, asOf?: string) {
  const q = asOf ? `?asOf=${asOf}` : "";
  const [{ accounts }, { contacts }] = await Promise.all([
    ctx.client.req<{ accounts: Account[] }>("GET", `/entities/${entity.id}/accounts${q}`),
    ctx.client.req<{ contacts: Contact[] }>("GET", `/entities/${entity.id}/contacts${q}`),
  ]);
  const live = accounts.filter((a) => !a.archived && !a.system);
  return {
    all: accounts,
    byId: new Map(accounts.map((a) => [a.id, a])),
    money: live.filter((a) => a.type === "asset" || a.type === "liability"),
    expense: live.filter((a) => a.type === "expense"),
    income: live.filter((a) => a.type === "income"),
    contacts: contacts.filter((x) => !x.archived),
    contactsById: new Map(contacts.map((x) => [x.id, x])),
  };
}

type Chart = Awaited<ReturnType<typeof chart>>;

/** An existing contact by name, or (after asking, when interactive) a new one. */
async function contactArg(ctx: Ctx, ch: Chart, query: string, kind: "person" | "business"): Promise<Pick<TransactionInput, "contactId" | "newContact">> {
  try {
    return { contactId: pick(query, ch.contacts, "contact").id };
  } catch (err) {
    if (err instanceof CliError && err.message.startsWith("No contact")) {
      const name = query.trim().replace(/\b[a-z]/g, (x) => x.toUpperCase());
      if (process.stdin.isTTY && !ctx.json) {
        const ok = (await ask(`New contact "${name}" (${kind})? [Y/n] `)).toLowerCase();
        if (ok && ok !== "y" && ok !== "yes") throw new CliError("Not saved.");
      }
      return { newContact: { name, kind } };
    }
    throw err;
  }
}

async function contactId(ctx: Ctx, ch: Chart, entity: Entity, query: string, kind: "person" | "business"): Promise<string> {
  const r = await contactArg(ctx, ch, query, kind);
  if (r.contactId) return r.contactId;
  const { contact } = await ctx.client.req<{ contact: Contact }>("POST", `/entities/${entity.id}/contacts`, r.newContact);
  return contact.id;
}

const money = (n: number, cur: string, sign: "auto" | "always" = "auto") => formatMoney(n, { currency: cur, minus: "-", sign });

type Describable = Pick<Transaction, "kind" | "amount" | "accountId" | "toAccountId" | "categoryId" | "date" | "note"> &
  Partial<Pick<Transaction, "contactId" | "paidBy" | "share">> & { contactName?: string };

function describe(tx: Describable, byId: Map<string, Account>, cur: string, contacts?: Map<string, Contact>) {
  const name = (id: string | null) => (id ? (byId.get(id)?.name ?? "?") : "?");
  const who = (id: string | null | undefined) => (id ? (contacts?.get(id)?.name ?? "?") : tx.contactName ?? null);
  const amt =
    tx.kind === "income"
      ? c.green(money(tx.amount, cur, "always"))
      : tx.kind === "expense"
        ? c.red(money(-tx.amount, cur))
        : tx.kind === "gave"
          ? money(-tx.amount, cur)
          : tx.kind === "got"
            ? money(tx.amount, cur, "always")
            : money(tx.amount, cur);
  let what: string;
  if (tx.kind === "transfer") what = `${name(tx.accountId)} → ${name(tx.toAccountId)}`;
  else if (tx.kind === "gave") what = `gave ${who(tx.contactId)} · ${name(tx.accountId)}`;
  else if (tx.kind === "got") what = `got from ${who(tx.contactId)} · ${name(tx.accountId)}`;
  else
    what = [
      name(tx.categoryId),
      tx.paidBy ? `paid by ${who(tx.paidBy)}` : name(tx.accountId),
      who(tx.contactId),
      tx.share ? `${who(tx.share.contactId)} owes ${money(tx.share.amount, cur)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  return `${amt}  ${what}  ${c.dim(tx.date)}${tx.note ? `  ${tx.note}` : ""}`;
}

function defaultAccount(entity: Entity, list: Account[]): Account {
  return list.find((a) => a.id === entity.defaultAccountId) ?? list[0];
}

// ---- Commands -----------------------------------------------------------------------

async function cmdLogin(ctx: Omit<Ctx, "client">, flags: Record<string, string | boolean | undefined>) {
  const existing = ctx.cfg.profiles[ctx.profileName];
  let url = (flags.url as string) || existing?.url || (await ask("Server URL (e.g. https://finance.example.com): "));
  url = url.replace(/\/$/, "");
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  let token = flags.token as string | undefined;
  const agent = typeof flags.agent === "string" ? flags.agent : null;
  const name = agent ?? `fin CLI on ${process.env.HOSTNAME || homedir().split("/").pop() || "this computer"}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetchRetry(`${url}/api${path}`, { method: "POST", redirect: "manual", headers: { ...accessHeaders(url), "content-type": "application/json" }, body: JSON.stringify(body) }).catch((err: Error & { cause?: { code?: string; message?: string } }) => {
      throw new CliError(`Can't reach ${url} (${err.cause?.code ?? err.cause?.message ?? err.message}).`);
    });
    if (accessBlocked(res)) throw new CliError(ACCESS_HELP);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message: string } };
    if (!res.ok) throw new CliError(data.error?.message ?? `Request failed (${res.status}).`);
    return data;
  };
  if (!token && (flags.email || flags.password)) {
    // Password login, for people at a terminal. Agents should use the browser flow below.
    const email = (flags.email as string) || (await ask("Email: "));
    const password = await askHidden("Password: ");
    token = (await post("/auth/token", { email, password, name, agent: !!agent })).token as string;
  } else if (!token) {
    // Browser approval: no password ever passes through this terminal (or an agent).
    const d = (await post("/auth/device", { name, agent: !!agent })) as unknown as { deviceCode: string; userCode: string; verifyUrl: string; interval: number; expiresIn: number };
    console.log(`To sign in${agent ? ` ${agent} (agent)` : ""}, open this link and check the code matches:\n\n  ${c.bold(d.verifyUrl)}\n  code ${c.bold(d.userCode)}\n`);
    if (process.platform === "darwin" && !flags["no-browser"]) {
      const { spawn } = await import("node:child_process");
      spawn("open", [d.verifyUrl], { stdio: "ignore", detached: true }).unref();
    }
    process.stdout.write(c.dim("Waiting for approval…"));
    const deadline = Date.now() + d.expiresIn * 1000;
    while (!token) {
      if (Date.now() > deadline) throw new CliError("\nThe code expired. Run fin login again.");
      await new Promise((r) => setTimeout(r, d.interval * 1000));
      const r = (await post("/auth/device/poll", { deviceCode: d.deviceCode })) as { status: string; token?: string };
      if (r.status === "approved") token = r.token;
      else if (r.status === "denied") throw new CliError("\nThe request was denied in the browser.");
      else if (r.status === "expired") throw new CliError("\nThe code expired. Run fin login again.");
    }
    process.stdout.write("\n");
  }
  const client = new Client({ url, token }, ctx.profileName);
  const me = await client.req<Me>("GET", "/me");
  ctx.cfg.profiles[ctx.profileName] = { url, token, entityId: existing?.entityId ?? me.entities[0]?.id };
  if (!ctx.cfg.profiles[ctx.cfg.current]) ctx.cfg.current = ctx.profileName;
  saveConfig(ctx.cfg);
  console.log(`Signed in to ${c.bold(me.appName)} as ${me.user.name} <${me.user.email}> (profile "${ctx.profileName}").`);
  if (me.entities.length) console.log(`Entities: ${me.entities.map((e) => e.name).join(", ")}. Switch with: fin use <name>`);
}

async function cmdEntities(ctx: Ctx) {
  const me = await ctx.client.req<Me>("GET", "/me");
  const current = (await entityOf(ctx)).id;
  if (ctx.json) return console.log(JSON.stringify(me.entities, null, 2));
  table(me.entities.map((e) => [e.id === current ? c.bold("*") : " ", e.id === current ? c.bold(e.name) : e.name, c.dim(e.kind), c.dim(e.role)]));
}

async function cmdUse(ctx: Ctx, args: string[]) {
  if (!args[0]) throw new CliError("Usage: fin use <entity name>");
  const me = await ctx.client.req<Me>("GET", "/me");
  const e = pick(args.join(" "), me.entities, "entity");
  ctx.cfg.profiles[ctx.profileName].entityId = e.id;
  saveConfig(ctx.cfg);
  console.log(`Using ${c.bold(e.name)}.`);
}

/** Balance sheet: what you own (incl. money owed to you) against what you owe (cards, loans, people). */
async function cmdAccounts(ctx: Ctx, flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const asOf = flags["as-of"] ? parseDateInput(String(flags["as-of"]), today()) : undefined;
  if (flags["as-of"] && !asOf) throw new CliError("--as-of must be a date like 2026-03-31.");
  const ch = await chart(ctx, entity, asOf ?? undefined);
  const owedToYou = ch.contacts.filter((x) => x.balance > 0);
  const youOwe = ch.contacts.filter((x) => x.balance < 0);
  const transit = ch.all.find((a) => a.system && a.groupLabel === "Transfers in transit" && a.balance !== 0);
  // Archived accounts still belong on a past balance sheet while they held money then (a sold car on 31 March).
  const held = ch.all.filter((a) => (a.type === "asset" || a.type === "liability") && !a.system && (!a.archived || a.balance !== 0));
  const assetsList = [...held.filter((a) => a.type === "asset"), ...(transit ? [transit] : [])];
  // EMI sub-accounts fold into their card's line.
  const kids = (id: string) => held.filter((a) => a.parentId === id).reduce((s, a) => s + a.balance, 0);
  const liabList = held.filter((a) => a.type === "liability" && !a.parentId).map((a) => ({ ...a, balance: a.balance + kids(a.id), emi: -kids(a.id) }));
  const share = (a: Account) => Math.round((a.balance * (a.ownShare ?? 100)) / 100);
  const assets = assetsList.reduce((s, a) => s + share(a), 0) + owedToYou.reduce((s, x) => s + x.balance, 0);
  const owed = liabList.reduce((s, a) => s - share(a), 0) - youOwe.reduce((s, x) => s + x.balance, 0);
  if (ctx.json) {
    return console.log(
      JSON.stringify(
        { asOf: asOf ?? today(), assets: assetsList, liabilities: liabList, owedToYou, youOwe, totals: { assets, liabilities: owed, netWorth: assets - owed } },
        null,
        2,
      ),
    );
  }
  const cur = entity.currency;
  console.log(`${c.bold(entity.name)}  ${c.dim(`balance sheet${asOf ? ` on ${asOf}` : ""}`)}`);
  const rows: string[][] = [[c.bold("Assets"), c.bold(money(assets, cur))]];
  for (const a of assetsList) {
    const joint = a.jointWith ? c.dim(` (joint, yours ${a.ownShare}%: ${money(share(a), cur)})`) : "";
    rows.push([`  ${a.icon ?? " "} ${a.name}${a.id === entity.defaultAccountId ? c.dim(" (default)") : ""}${joint}`, money(a.balance, cur)]);
  }
  for (const x of owedToYou) rows.push([`  ${x.name} ${c.dim("owes you")}`, c.blue(money(x.balance, cur))]);
  rows.push(["", ""], [c.bold("Liabilities"), c.bold(money(owed, cur))]);
  for (const a of liabList) {
    const lim = a.creditLimit ? c.dim(` (limit ${money(a.creditLimit, cur)})`) : "";
    const emi = a.emi > 0 ? c.dim(` (incl. ${money(a.emi, cur)} on EMI)`) : "";
    rows.push([`  ${a.icon ?? " "} ${a.name}${lim}${emi}`, c.red(money(displayBalance(a.type, a.balance), cur))]);
  }
  for (const x of youOwe) rows.push([`  ${c.dim("you owe")} ${x.name}`, c.red(money(-x.balance, cur))]);
  rows.push(["", ""], [c.bold("Net worth"), c.bold(money(assets - owed, cur))]);
  table(rows, ["l", "r"]);
}

async function cmdContacts(ctx: Ctx, onlyOpen: boolean) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const list = ch.contacts
    .filter((x) => !onlyOpen || x.balance !== 0)
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || (b.lastDate ?? "").localeCompare(a.lastDate ?? ""));
  if (ctx.json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log(c.dim(onlyOpen ? "Nobody owes anybody." : "No contacts yet."));
  const cur = entity.currency;
  table(
    list.map((x) => [
      x.name,
      c.dim(x.kind),
      x.sent ? `sent ${money(x.sent, cur)}` : "",
      x.received ? `received ${money(x.received, cur)}` : "",
      x.balance > 0 ? c.blue(`owes you ${money(x.balance, cur)}`) : x.balance < 0 ? c.red(`you owe ${money(-x.balance, cur)}`) : "",
    ]),
  );
}

async function cmdCategories(ctx: Ctx, flags: Record<string, unknown>) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const list = flags.income ? ch.income : ch.expense;
  if (ctx.json) return console.log(JSON.stringify(list, null, 2));
  table(list.map((a) => [`${a.icon ?? " "} ${a.name}`, c.dim(a.hint ?? "")]));
}

async function save(ctx: Ctx, entity: Entity, input: TransactionInput, byId: Map<string, Account>) {
  if (input.newContact) console.error(c.dim(`+ new contact ${input.newContact.name}`));
  const { transaction } = await ctx.client.req<{ transaction: Transaction }>("POST", `/entities/${entity.id}/transactions`, input);
  if (ctx.json) return console.log(JSON.stringify(transaction, null, 2));
  const fresh = (await ctx.client.req<{ contacts: Contact[] }>("GET", `/entities/${entity.id}/contacts`)).contacts;
  console.log(`${c.green("✓")} ${describe(transaction, byId, entity.currency, new Map(fresh.map((x) => [x.id, x])))}`);
  console.log(c.dim(`  undo: fin rm ${transaction.id}`));
}

/**
 * fin add <amount> <category> [note…] [--with contact] [--split contact[:their share]] [--paid-by contact]
 * fin income <amount> <category> [note…] [--with contact]
 * fin transfer <amount> <from> <to> [note…]
 * fin gave|got <amount> <contact> [note…] [--account A]
 */
async function cmdAdd(ctx: Ctx, kind: EntryKind, args: string[], flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const [amountArg, ...rest] = args;
  const amount = amountArg ? parseAmount(amountArg) : null;
  const usage = {
    expense: "fin add <amount> <category> [note] [--with contact] [--split contact[:share]] [--paid-by contact]",
    income: "fin income <amount> <category> [note] [--with contact]",
    transfer: "fin transfer <amount> <from> <to> [note]",
    gave: "fin gave <amount> <contact> [note] [--account A]",
    got: "fin got <amount> <contact> [note] [--account A]",
  }[kind];
  if (!amount || amount <= 0) throw new CliError(`Usage: ${usage}`);
  const date = flags.date ? parseDateInput(flags.date as string, today()) : today();
  if (!date) throw new CliError(`Can't read the date "${flags.date}". Use today, yesterday, -3, 2026-10-28 or 10-28.`);
  const account = () => (flags.account ? pick(flags.account as string, ch.money, "account") : defaultAccount(entity, ch.money)).id;
  let input: TransactionInput;
  if (kind === "transfer") {
    const [from, to, ...note] = rest;
    if (!from || !to) throw new CliError(`Usage: ${usage}`);
    input = { id: uuidv7(), kind, date, amount, accountId: pick(from, ch.money, "account").id, toAccountId: pick(to, ch.money, "account").id, note: note.join(" ") || null };
  } else if (kind === "gave" || kind === "got") {
    const [who, ...note] = rest;
    if (!who) throw new CliError(`Usage: ${usage}`);
    input = { id: uuidv7(), kind, date, amount, accountId: account(), ...(await contactArg(ctx, ch, who, "person")), note: note.join(" ") || null };
  } else {
    const [catArg, ...note] = rest;
    if (!catArg) throw new CliError(`Which category? Options: ${(kind === "income" ? ch.income : ch.expense).map((a) => a.name).join(", ")}`);
    const party = flags.with as string | undefined;
    input = {
      id: uuidv7(),
      kind,
      date,
      amount,
      accountId: account(),
      categoryId: pick(catArg, kind === "income" ? ch.income : ch.expense, "category").id,
      ...(party ? await contactArg(ctx, ch, party, "business") : {}),
      note: note.join(" ") || null,
    };
    if (kind === "expense" && flags.split) {
      // --split rahul (half) or --split rahul:1500 (their share). The amount is the total bill.
      const [who, shareArg] = String(flags.split).split(":");
      const share = shareArg ? parseAmount(shareArg) : Math.round(amount / 2);
      if (!share || share <= 0 || share >= amount) throw new CliError("Their share must be more than zero and less than the total.");
      input.amount = amount - share;
      input.share = { contactId: await contactId(ctx, ch, entity, who, "person"), amount: share };
    }
    if (kind === "expense" && flags["paid-by"]) {
      // They paid the whole bill; you owe them your share (all of it unless --mine is given).
      const mine = flags.mine ? parseAmount(String(flags.mine)) : amount;
      if (!mine || mine <= 0 || mine > amount) throw new CliError("--mine must be between zero and the total.");
      input.amount = mine;
      input.paidBy = await contactId(ctx, ch, entity, String(flags["paid-by"]), "person");
      input.accountId = null;
    }
  }
  if (flags.source) input.origin = sourceFlag(flags.source);
  await save(ctx, entity, input, ch.byId);
}

function sourceFlag(v: unknown): NonNullable<TransactionInput["origin"]> {
  const allowed = ["manual", "sms", "email", "api"] as const;
  const s = String(v) as (typeof allowed)[number];
  if (!allowed.includes(s)) throw new CliError(`--source must be one of ${allowed.join(", ")}. Statements go through fin import.`);
  return s;
}

/** Free text: Jev reads it, code fills the gaps, and you confirm before anything is saved. */
async function cmdSmart(ctx: Ctx, text: string, flags: Record<string, string | boolean | undefined>, mode: "auto" | "ask" = "auto") {
  const entity = await entityOf(ctx);
  const r = await ctx.client.req<AssistResult>("GET", `/entities/${entity.id}/assist?mode=${mode}&text=${encodeURIComponent(text)}`);
  if (r.mode === "ask" && r.ask) {
    if (ctx.json) return console.log(JSON.stringify(r.ask, null, 2));
    console.log(c.bold(r.ask.answer));
    const ch = await chart(ctx, entity);
    for (const b of r.ask.balances ?? []) {
      const who = ch.contactsById.get(b.contactId)?.name ?? "?";
      console.log(`  ${b.balance > 0 ? c.blue(`${who} owes you ${money(b.balance, entity.currency)}`) : c.red(`you owe ${who} ${money(-b.balance, entity.currency)}`)}`);
    }
    for (const t of r.ask.transactions) console.log("  " + describe(t, ch.byId, entity.currency, ch.contactsById));
    return;
  }
  const p = r.parse!;
  const ch = await chart(ctx, entity);
  const d = { ...p.draft };
  if (!d.accountId) d.accountId = (flags.account ? pick(flags.account as string, ch.money, "account") : defaultAccount(entity, ch.money)).id;
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !ctx.json;

  if (!d.amount) {
    if (!interactive) throw new CliError(`Couldn't find the amount in "${text}".`);
    const a = parseAmount(await ask("Amount: "));
    if (!a) throw new CliError("That isn't an amount.");
    d.amount = a;
  }
  if ((d.kind === "expense" || d.kind === "income") && !d.categoryId) {
    const pool = d.kind === "income" ? ch.income : ch.expense;
    const suggestions = p.suggestions.categoryIds.map((id) => ch.byId.get(id)!).filter(Boolean);
    if (!interactive) throw new CliError(`Not sure of the category${suggestions.length ? ` (maybe ${suggestions.map((s) => s.name).join(", ")})` : ""}. Use: fin add ${toDecimal(d.amount)} <category> ${d.note ?? ""}`);
    if (suggestions.length) suggestions.forEach((s, i) => console.log(`  ${c.bold(String(i + 1))}  ${s.icon ?? ""} ${s.name}`));
    const answer = await ask(suggestions.length ? "Category (number or name): " : "Category: ");
    const n = Number(answer);
    d.categoryId = (n >= 1 && n <= suggestions.length ? suggestions[n - 1] : pick(answer, pool, "category")).id;
  }
  if (d.kind === "transfer" && !d.toAccountId) {
    if (!interactive) throw new CliError("Couldn't tell where the money went. Use: fin transfer <amount> <from> <to>");
    d.toAccountId = pick(await ask("To account: "), ch.money, "account").id;
  }

  if ((d.kind === "gave" || d.kind === "got") && !d.contactId && !d.newContact) {
    if (!interactive) throw new CliError(`Who did you ${d.kind === "gave" ? "give it to" : "get it from"}? Use: fin ${d.kind} <amount> <contact>`);
    Object.assign(d, await contactArg(ctx, ch, await ask("Who? "), "person"));
  }
  const preview = describe({ ...d, amount: d.amount!, accountId: d.accountId, contactName: d.newContact ? `${d.newContact.name} (new)` : undefined }, ch.byId, entity.currency, ch.contactsById);
  for (const w of p.warnings) console.error(c.yellow(`! ${w.message}`));
  const input: TransactionInput = {
    id: uuidv7(),
    kind: d.kind,
    date: d.date,
    amount: d.amount!,
    accountId: d.accountId!,
    categoryId: d.kind === "expense" || d.kind === "income" ? d.categoryId : null,
    toAccountId: d.kind === "transfer" ? d.toAccountId : null,
    contactId: d.kind === "transfer" ? null : d.contactId,
    newContact: d.kind === "transfer" || d.contactId ? null : d.newContact,
    note: d.note,
    origin: flags.source ? sourceFlag(flags.source) : "smart",
  };
  if (!flags.yes) {
    if (!interactive) {
      if (ctx.json) return console.log(JSON.stringify({ draft: input, warnings: p.warnings, confidence: p.confidence }, null, 2));
      console.log(`${preview}\n${c.dim("Not saved. Re-run with --yes to save.")}`);
      return;
    }
    console.log(`${c.dim(entity.name)}  ${preview}`);
    const ok = (await ask("Save? [Y/n] ")).toLowerCase();
    if (ok && ok !== "y" && ok !== "yes") return console.log("Not saved.");
  }
  await save(ctx, entity, input, ch.byId);
}

function rangeFrom(flags: Record<string, string | boolean | undefined>, entity: Entity) {
  if (flags.from || flags.to) {
    const from = parseDateInput(String(flags.from ?? "1900-01-01"), today());
    const to = parseDateInput(String(flags.to ?? today()), today());
    if (!from || !to) throw new CliError("--from/--to must be dates like 2026-10-01.");
    return { from, to, label: `${from} → ${to}` };
  }
  if (flags.fy) {
    const fy = fiscalYear(typeof flags.fy === "string" && /^\d{4}$/.test(flags.fy) ? `${flags.fy}-${String(entity.fyStartMonth).padStart(2, "0")}-01` : today(), entity.fyStartMonth);
    return { from: fy.from, to: fy.to, label: fy.label };
  }
  let m = (flags.month as string) ?? monthOf(today());
  if (m === "last") m = addMonths(monthOf(today()), -1);
  if (!MONTH_RE.test(m)) throw new CliError("--month must look like 2026-10 (or 'last').");
  return { ...monthRange(m), label: m };
}

async function cmdList(ctx: Ctx, flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const q = new URLSearchParams();
  if (flags.q) q.set("q", String(flags.q));
  else {
    const r = rangeFrom(flags, entity);
    q.set("from", r.from);
    q.set("to", r.to);
  }
  if (flags.category) q.set("categoryId", pick(String(flags.category), [...ch.expense, ...ch.income], "category").id);
  const transitAcct = ch.all.filter((a) => a.system && a.groupLabel === "Transfers in transit");
  if (flags.account) q.set("accountId", pick(String(flags.account), [...ch.money, ...transitAcct], "account").id);
  const party = flags.with;
  if (party) q.set("contactId", pick(String(party), ch.contacts, "contact").id);
  q.set("limit", String(flags.limit ?? 200));
  const { transactions } = await ctx.client.req<{ transactions: Transaction[] }>("GET", `/entities/${entity.id}/transactions?${q}`);
  if (ctx.json) return console.log(JSON.stringify(transactions, null, 2));
  if (!transactions.length) return console.log(c.dim("No transactions."));
  const name = (id: string | null) => (id ? (ch.byId.get(id)?.name ?? "?") : "");
  const who = (id: string | null) => (id ? (ch.contactsById.get(id)?.name ?? "") : "");
  table(
    transactions.map((t) => [
      c.dim(t.date),
      t.kind === "income"
        ? c.green(money(t.amount, entity.currency, "always"))
        : t.kind === "expense"
          ? c.red(money(-t.amount, entity.currency))
          : t.kind === "gave"
            ? money(-t.amount, entity.currency)
            : t.kind === "got"
              ? money(t.amount, entity.currency, "always")
              : money(t.amount, entity.currency),
      t.kind === "transfer" ? `${name(t.accountId)} → ${name(t.toAccountId)}` : t.kind === "gave" ? "gave" : t.kind === "got" ? "got" : name(t.categoryId),
      t.kind === "transfer" ? "" : c.dim(t.paidBy ? `paid by ${who(t.paidBy)}` : name(t.accountId)),
      who(t.contactId) + (t.share ? c.dim(` · ${who(t.share.contactId)} owes ${money(t.share.amount, entity.currency)}`) : ""),
      t.note ?? "",
      c.dim(t.id.slice(-8)),
    ]),
    ["l", "r", "l", "l", "l", "l", "l"],
  );
}

async function cmdSummary(ctx: Ctx, flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const r = rangeFrom(flags, entity);
  const [s, ch] = await Promise.all([ctx.client.req<Summary>("GET", `/entities/${entity.id}/summary?from=${r.from}&to=${r.to}`), chart(ctx, entity)]);
  if (ctx.json) return console.log(JSON.stringify(s, null, 2));
  console.log(`${c.bold(entity.name)}  ${c.dim(r.label)}`);
  table(
    [
      ["Income", c.green(money(s.income, entity.currency))],
      ["Expenses", c.red(money(s.expense, entity.currency))],
      [c.bold("Net"), c.bold(money(s.income - s.expense, entity.currency, "always"))],
    ],
    ["l", "r"],
  );
  const top = s.byCategory.filter((x) => ch.byId.get(x.accountId)?.type === "expense").slice(0, 10);
  if (top.length) {
    console.log("");
    table(
      top.map((x) => {
        const a = ch.byId.get(x.accountId)!;
        const pct = s.expense ? Math.round((x.amount / s.expense) * 100) : 0;
        return [`${a.icon ?? " "} ${a.name}`, money(x.amount, entity.currency), c.dim(`${pct}%`), c.dim("█".repeat(Math.max(1, Math.round(pct / 4))))];
      }),
      ["l", "r", "r", "l"],
    );
  }
}

async function findTx(ctx: Ctx, entity: Entity, idOrSuffix: string): Promise<string> {
  if (idOrSuffix.length >= 36) return idOrSuffix;
  const { transactions } = await ctx.client.req<{ transactions: Transaction[] }>("GET", `/entities/${entity.id}/transactions?limit=2000`);
  const hits = transactions.filter((t) => t.id.endsWith(idOrSuffix));
  if (hits.length !== 1) throw new CliError(hits.length ? "That id is ambiguous; use more characters." : "No transaction with that id.");
  return hits[0].id;
}

async function cmdRemove(ctx: Ctx, args: string[], restore = false) {
  if (!args[0]) throw new CliError(`Usage: fin ${restore ? "undo" : "rm"} <id>`);
  const entity = await entityOf(ctx);
  const id = restore ? args[0] : await findTx(ctx, entity, args[0]);
  await ctx.client.req(restore ? "POST" : "DELETE", `/entities/${entity.id}/transactions/${id}${restore ? "/restore" : ""}`);
  if (ctx.json) return console.log(JSON.stringify({ ok: true, id }));
  console.log(restore ? `${c.green("✓")} Restored.` : `${c.green("✓")} Deleted. ${c.dim(`undo: fin undo ${id}`)}`);
}

async function cmdExport(ctx: Ctx, flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const r = rangeFrom(flags, entity);
  const csv = await ctx.client.req<string>("GET", `/entities/${entity.id}/export.csv?from=${r.from}&to=${r.to}&format=${flags.journal ? "journal" : "transactions"}`);
  process.stdout.write(csv.replace(/^\uFEFF/, ""));
}

// ---- Setup: entities, accounts, contacts ---------------------------------------------

const ACCOUNT_TYPES: Record<string, { type: "asset" | "liability"; subtype: string; groupLabel?: string; icon: string }> = {
  cash: { type: "asset", subtype: "cash", icon: "💵" },
  bank: { type: "asset", subtype: "bank", icon: "🏦" },
  wallet: { type: "asset", subtype: "wallet", icon: "📱" },
  card: { type: "liability", subtype: "card", icon: "💳" },
  investment: { type: "asset", subtype: "investment", icon: "📈" },
  fd: { type: "asset", subtype: "investment", groupLabel: "Fixed deposits", icon: "🔒" },
  property: { type: "asset", subtype: "other", groupLabel: "Property", icon: "🏠" },
  loan: { type: "liability", subtype: "loan", icon: "🏛️" },
  other: { type: "asset", subtype: "other", icon: "◻️" },
  "other-liability": { type: "liability", subtype: "other", icon: "◻️" },
};

/** fin entities add "<name>" [--business] [--currency INR] [--fy-start 4] */
async function cmdEntityAdd(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const name = args.join(" ").trim();
  if (!name) throw new CliError('Usage: fin entities add "<name>" [--business] [--currency INR] [--fy-start 4]');
  const currency = String(flags.currency ?? "INR").toUpperCase();
  const body = {
    name,
    kind: flags.business ? "business" : "personal",
    currency,
    fyStartMonth: flags["fy-start"] ? Number(flags["fy-start"]) : currency === "INR" ? 4 : 1,
    color: flags.business ? "#0d9488" : "#5b5bd6",
  };
  const { entity } = await ctx.client.req<{ entity: Entity }>("POST", "/entities", body);
  if (ctx.json) return console.log(JSON.stringify(entity, null, 2));
  console.log(`${c.green("✓")} Created ${c.bold(entity.name)} (${entity.kind}, ${entity.currency}, FY from month ${entity.fyStartMonth}) with starter accounts and categories.`);
  console.log(c.dim(`  switch to it: fin use "${entity.name}"`));
}

function accountBody(flags: Record<string, string | boolean | undefined>, forEdit: boolean) {
  const body: Record<string, unknown> = {};
  if (flags.type) {
    const t = ACCOUNT_TYPES[String(flags.type)];
    if (!t) throw new CliError(`--type must be one of: ${Object.keys(ACCOUNT_TYPES).join(", ")}`);
    body.subtype = t.subtype;
    body.groupLabel = t.groupLabel ?? null;
    if (!forEdit) {
      body.type = t.type;
      body.icon = flags.icon ?? t.icon;
    }
  }
  if (forEdit && flags.icon) body.icon = flags.icon;
  if (flags.bank !== undefined) body.institution = String(flags.bank) || null;
  if (flags.last4 !== undefined) body.numberLast4 = String(flags.last4) || null;
  if (flags.ifsc !== undefined) body.ifsc = String(flags.ifsc) || null;
  if (flags.group !== undefined) body.groupLabel = String(flags.group) || null;
  if (flags.joint !== undefined) body.jointWith = String(flags.joint) || null;
  if (flags.limit !== undefined) {
    const l = String(flags.limit) ? parseAmount(String(flags.limit)) : null;
    if (String(flags.limit) && l === null) throw new CliError("--limit isn't an amount.");
    body.creditLimit = l;
  }
  if (flags.share !== undefined) {
    const share = Number(flags.share);
    if (!Number.isInteger(share) || share < 0 || share > 100) throw new CliError("--share is your percent of the account, 0 to 100.");
    body.ownShare = share;
  }
  return body;
}

/**
 * fin accounts add "<name>" --type bank|cash|wallet|card|investment|fd|property|loan|other
 *   [--balance N] [--as-of D] [--bank B] [--last4 NNNN] [--ifsc X] [--joint "Name"] [--share 50] [--group "Heading"]
 * --balance is what the account holds today (for a card or loan: what you owe).
 */
async function cmdAccountAdd(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const name = args.join(" ").trim();
  if (!name || !flags.type) throw new CliError(`Usage: fin accounts add "<name>" --type ${Object.keys(ACCOUNT_TYPES).join("|")} [--balance N] [--as-of D] [--bank B] [--last4 NNNN] [--joint "Name" --share 50]`);
  const entity = await entityOf(ctx);
  const body = accountBody(flags, false);
  if (flags.balance !== undefined) {
    const b = parseAmount(String(flags.balance));
    if (b === null) throw new CliError("--balance isn't an amount.");
    body.openingBalance = b;
    if (flags["as-of"]) {
      const d = parseDateInput(String(flags["as-of"]), today());
      if (!d) throw new CliError("--as-of must be a date like 2026-03-31.");
      body.openingDate = d;
    }
  }
  const { account } = await ctx.client.req<{ account: Account }>("POST", `/entities/${entity.id}/accounts`, { name, ...body });
  if (ctx.json) return console.log(JSON.stringify(account, null, 2));
  const bal = displayBalance(account.type, account.balance);
  console.log(
    `${c.green("✓")} ${account.icon ?? ""} ${c.bold(account.name)} added to ${entity.name}` +
      `${bal ? ` · ${account.type === "liability" ? "owed" : "balance"} ${money(bal, entity.currency)}` : ""}` +
      `${account.numberLast4 ? ` · statements ending ${account.numberLast4}` : ""}` +
      `${account.jointWith ? ` · joint with ${account.jointWith} (yours ${account.ownShare}%)` : ""}`,
  );
}

async function cmdAccountEdit(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>, archive?: boolean) {
  if (!args[0]) throw new CliError(archive === undefined ? 'Usage: fin accounts edit "<account>" [--name N] [--type T] [--bank B] [--last4 NNNN] [--joint "Name"] [--share 50]' : 'Usage: fin accounts archive "<account>"');
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const pool = archive === false ? ch.all.filter((x) => (x.type === "asset" || x.type === "liability") && !x.system) : ch.money;
  const a = pick(args.join(" "), pool, "account");
  const body = archive === undefined ? accountBody(flags, true) : { archived: archive };
  if (flags.name) body.name = String(flags.name);
  if (!Object.keys(body).length) throw new CliError("Nothing to change. Pass --name, --type, --bank, --last4, --ifsc, --joint, --share or --group.");
  const { account } = await ctx.client.req<{ account: Account }>("PATCH", `/entities/${entity.id}/accounts/${a.id}`, body);
  if (ctx.json) return console.log(JSON.stringify(account, null, 2));
  console.log(`${c.green("✓")} ${archive ? "Archived" : "Updated"} ${account.name}${archive ? c.dim(" (history stays)") : ""}.`);
}

/** fin accounts reconcile "<account>" <balance> [--date D]: set what the account held at the end of a day (cards/loans: what you owed). Posts the difference as an adjustment. */
async function cmdReconcile(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  // Negative balances (a card in credit) can be passed as --balance=-0.35.
  const amountArg = flags.balance !== undefined ? String(flags.balance) : args.pop();
  const balance = amountArg !== undefined ? parseAmount(amountArg) : null;
  if (!args.length || balance === null) throw new CliError('Usage: fin accounts reconcile "<account>" <balance> [--date 2026-03-31]');
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const a = pick(args.join(" "), ch.money, "account");
  const date = flags.date ? parseDateInput(String(flags.date), today()) : today();
  if (!date) throw new CliError("--date must be a date like 2026-03-31.");
  const r = await ctx.client.req<{ account: Account; transactionId: string | null }>("POST", `/entities/${entity.id}/accounts/${a.id}/adjust`, { balance, date });
  if (ctx.json) return console.log(JSON.stringify(r, null, 2));
  console.log(r.transactionId ? `${c.green("✓")} ${a.name} set to ${money(balance, entity.currency)} at the end of ${date} (adjustment posted).` : `${c.green("✓")} ${a.name} already showed ${money(balance, entity.currency)}.`);
}

/**
 * fin edit <id> [--kind expense|income|transfer|gave|got] [--from A] [--to A] [--category C] [--with C | --no-contact] [--note N] [--date D] [--reviewed]
 * Re-points a transaction, e.g. a payment parked in Transfers in transit onto the loan it paid.
 */
async function cmdEdit(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  if (!args[0]) throw new CliError("Usage: fin edit <id> [--kind expense|income|transfer|gave|got] [--from A] [--to A] [--category C] [--with C | --no-contact] [--note N] [--date D] [--reviewed]");
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const id = await findTx(ctx, entity, args[0]);
  const { transaction: tx } = await ctx.client.req<{ transaction: Transaction }>("GET", `/entities/${entity.id}/transactions/${id}`);
  const transit = ch.all.filter((a) => a.system && a.groupLabel === "Transfers in transit");
  const acct = (q: string) => pick(q, [...ch.money, ...transit], "account").id;
  const body: Record<string, unknown> = {};
  if (flags.from) body.accountId = acct(String(flags.from));
  if (flags.to) body.toAccountId = acct(String(flags.to));
  if (flags.category) body.categoryId = pick(String(flags.category), [...ch.expense, ...ch.income], "category").id;
  if (flags.with) body.contactId = pick(String(flags.with), ch.contacts, "contact").id;
  if (flags["no-contact"]) body.contactId = null;
  if (flags.reviewed) body.reviewed = true;
  if (flags.kind) body.kind = String(flags.kind);
  if (body.kind === "transfer") body.contactId = null;
  if (flags.note !== undefined) body.note = String(flags.note) || null;
  if (flags.date) body.date = parseDateInput(String(flags.date), today());
  if (!Object.keys(body).length) throw new CliError("Nothing to change.");
  const { transaction } = await ctx.client.req<{ transaction: Transaction }>("PATCH", `/entities/${entity.id}/transactions/${tx.id}`, body);
  if (ctx.json) return console.log(JSON.stringify(transaction, null, 2));
  console.log(`${c.green("✓")} ${describe(transaction, ch.byId, entity.currency, ch.contactsById)}`);
}

/** fin contacts merge "<dup>" [--into "<keep>"] · fin contacts edit "<c>" --name N */
async function cmdContactMerge(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  if (!args.length || !flags.into) throw new CliError('Usage: fin contacts merge "<duplicate>" [more…] --into "<keep>"');
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const into = pick(String(flags.into), ch.contacts, "contact");
  for (const name of args) {
    const from = pick(name, ch.contacts.filter((x) => x.id !== into.id), "contact");
    await ctx.client.req("POST", `/entities/${entity.id}/contacts/${from.id}/merge`, { into: into.id });
    console.log(`${c.green("✓")} ${from.name} → ${into.name} (${from.transactions} transactions)`);
  }
}

async function cmdContactEdit(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const x = pick(args.join(" "), ch.contacts, "contact");
  const body: Record<string, unknown> = {};
  if (flags.name) body.name = String(flags.name);
  if (flags.person) body.kind = "person";
  if (flags.business) body.kind = "business";
  if (flags.aliases !== undefined) body.aliases = String(flags.aliases);
  if (flags.archive) body.archived = true;
  const cat = flags.category ? pick(String(flags.category), [...ch.expense, ...ch.income], "category") : null;
  if (cat) body.defaultCategoryId = cat.id;
  await ctx.client.req("PATCH", `/entities/${entity.id}/contacts/${x.id}`, body);
  console.log(`${c.green("✓")} ${flags.archive ? "Archived" : "Updated"} ${x.name}${flags.name ? ` → ${flags.name}` : ""}${cat ? ` · usual category ${cat.name}` : ""}.`);
  // --apply: recategorise this contact's past spending/income to the usual category.
  if (cat && flags.apply) {
    const { transactions } = await ctx.client.req<{ transactions: Transaction[] }>("GET", `/entities/${entity.id}/transactions?contactId=${x.id}&limit=5000`);
    let n = 0;
    for (const t of transactions.filter((t) => t.kind === cat.type && t.categoryId !== cat.id)) {
      await ctx.client.req("PATCH", `/entities/${entity.id}/transactions/${t.id}`, { categoryId: cat.id, reviewed: true });
      n++;
    }
    console.log(c.dim(`  ${n} past transaction${n === 1 ? "" : "s"} moved to ${cat.name}`));
  }
}

/** fin categories add "<name>" [--income] [--icon I] [--hint "what goes here"] */
async function cmdCategoryAdd(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const name = args.join(" ").trim();
  if (!name) throw new CliError('Usage: fin categories add "<name>" [--income] [--icon I] [--hint H]');
  const entity = await entityOf(ctx);
  await ctx.client.req("POST", `/entities/${entity.id}/accounts`, { type: flags.income ? "income" : "expense", name, icon: flags.icon ?? null, hint: flags.hint ?? null });
  console.log(`${c.green("✓")} Category ${name} added.`);
}

/** fin credit: limits, used and available across cards. Capacity, not money held. */
async function cmdCredit(ctx: Ctx) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const cards = ch.money.filter((a) => a.type === "liability" && !a.parentId && (a.subtype === "card" || a.creditLimit));
  const rows = cards.map((a) => {
    // The bank blocks the limit for unbilled EMI principal too.
    const used = Math.max(0, -(a.balance + ch.money.filter((k) => k.parentId === a.id).reduce((s, k) => s + k.balance, 0)));
    return { name: a.name, limit: a.creditLimit, used, available: a.creditLimit === null ? null : Math.max(0, a.creditLimit - used), utilisation: a.creditLimit ? used / a.creditLimit : null };
  });
  const withLimit = rows.filter((r) => r.limit !== null);
  const total = { limit: withLimit.reduce((s, r) => s + r.limit!, 0), used: withLimit.reduce((s, r) => s + r.used, 0) };
  const totals = { ...total, available: Math.max(0, total.limit - total.used), utilisation: total.limit ? total.used / total.limit : null };
  if (ctx.json) return console.log(JSON.stringify({ cards: rows, totals, missingLimit: rows.filter((r) => r.limit === null).map((r) => r.name) }, null, 2));
  if (!cards.length) return console.log(c.dim("No cards yet. fin accounts add \"<card>\" --type card --limit 3L"));
  const cur = entity.currency;
  const pct = (u: number | null) => (u === null ? "" : u > 0.3 ? c.yellow(`${Math.round(u * 100)}%`) : `${Math.round(u * 100)}%`);
  table(
    [
      [c.dim("Card"), c.dim("Limit"), c.dim("Used"), c.dim("Available"), c.dim("Used %")],
      ...rows.map((r) => [r.name, r.limit === null ? c.dim("not set") : money(r.limit, cur), money(r.used, cur), r.available === null ? "" : money(r.available, cur), pct(r.utilisation)]),
      ["", "", "", "", ""],
      [c.bold("Total"), c.bold(money(totals.limit, cur)), money(totals.used, cur), c.bold(money(totals.available, cur)), pct(totals.utilisation)],
    ],
    ["l", "r", "r", "r", "r"],
  );
  console.log(c.dim("\nAvailable credit is what you could borrow, not money you have. Under 30% used helps your credit score."));
  const missing = rows.filter((r) => r.limit === null).map((r) => r.name);
  if (missing.length) console.log(c.dim(`No limit set: ${missing.join(", ")}  →  fin accounts edit "<card>" --limit 3L`));
}

const EMI_USAGE = `Usage:
  fin emi                                   list running EMIs (--all includes finished)
  fin emi add "<what it paid for>" --account "<card or bank>" --instalment N [--principal N] [--months N] [--first YYYY-MM-DD]
              [--in-card | --loan "<loan account>"] [--merchant M] [--with <contact>] [--purchase <tx id>] [--evidence "..."]
      Default: the card credits the purchase back and bills monthly (ICICI, HDFC, YES, DBS) — a hidden sub-account holds the rest.
      --in-card: the card's outstanding already includes the whole EMI (SBI Card).
      --loan: a loan repaid from a bank account; the loan account holds what's left.
  fin emi edit <id|title> [--name "<what it paid for>"] [--instalment N] [--principal N] [--months N] [--first D] [--merchant M]
              [--with <contact>] [--purchase <tx id>] [--evidence "..."] [--close | --reopen]`;

async function cmdEmi(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const cur = entity.currency;
  const sub = args[0];
  const amount = (f: string) => {
    if (flags[f] === undefined) return undefined;
    const v = parseAmount(String(flags[f]));
    if (v === null || v <= 0) throw new CliError(`--${f} must be an amount.`);
    return v;
  };
  const common = async (ch: Chart) => {
    const body: Record<string, unknown> = {};
    const inst = amount("instalment");
    if (inst !== undefined) body.instalment = inst;
    const principal = amount("principal");
    if (principal !== undefined) body.principal = principal;
    if (flags.months !== undefined) {
      const m = Number(flags.months);
      if (!Number.isInteger(m) || m < 1) throw new CliError("--months must be a whole number.");
      body.months = m;
    }
    if (flags.first !== undefined) {
      const d = parseDateInput(String(flags.first), today());
      if (!d) throw new CliError("--first must be a date like 2026-07-08.");
      body.firstDue = d;
    }
    if (flags.merchant !== undefined) body.merchant = String(flags.merchant) || null;
    if (flags.evidence !== undefined) body.evidence = String(flags.evidence) || null;
    if (flags.with !== undefined) body.contactId = String(flags.with) ? pick(String(flags.with), ch.contacts, "contact").id : null;
    if (flags.purchase !== undefined) body.purchaseTxId = String(flags.purchase) ? await findTx(ctx, entity, String(flags.purchase)) : null;
    return body;
  };

  if (sub === "add") {
    const title = args.slice(1).join(" ").trim();
    if (!title || !flags.account || flags.instalment === undefined) throw new CliError(EMI_USAGE);
    const ch = await chart(ctx, entity);
    const account = pick(String(flags.account), ch.money.filter((a) => !a.parentId), "account");
    const body = { title, accountId: account.id, ...(await common(ch)) } as Record<string, unknown>;
    body.balance = flags.loan ? { accountId: pick(String(flags.loan), ch.money.filter((a) => a.type === "liability"), "account").id } : flags["in-card"] ? "in-account" : "separate";
    const { plan } = await ctx.client.req<{ plan: EmiPlan }>("POST", `/entities/${entity.id}/emis`, body);
    if (ctx.json) return console.log(JSON.stringify(plan, null, 2));
    return console.log(`${c.green("✓")} ${plan.title}: ${money(plan.instalment, cur)}/mo on ${account.name} · ${planProgress(plan)} · ${money(plan.toPay, cur)} to pay`);
  }

  const { plans } = await ctx.client.req<{ plans: EmiPlan[] }>("GET", `/entities/${entity.id}/emis`);
  if (sub === "edit") {
    const q = args.slice(1).join(" ").trim();
    if (!q) throw new CliError(EMI_USAGE);
    const plan = plans.find((p) => p.id === q || p.id.endsWith(q)) ?? pick(q, plans.map((p) => ({ ...p, name: p.title })), "EMI");
    const ch = await chart(ctx, entity);
    const body = await common(ch);
    if (flags.name !== undefined) body.title = String(flags.name);
    if (flags.close) body.closed = true;
    if (flags.reopen) body.closed = false;
    if (!Object.keys(body).length) throw new CliError(EMI_USAGE);
    const r = await ctx.client.req<{ plan: EmiPlan }>("PATCH", `/entities/${entity.id}/emis/${plan.id}`, body);
    if (ctx.json) return console.log(JSON.stringify(r.plan, null, 2));
    return console.log(`${c.green("✓")} Updated ${r.plan.title} · ${planProgress(r.plan)}`);
  }
  if (sub) throw new CliError(EMI_USAGE);

  const list = plans.filter((p) => flags.all || !p.done);
  if (ctx.json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log(c.dim("No running EMIs. fin emi add --help"));
  const ch = await chart(ctx, entity);
  const name = (id: string) => ch.byId.get(id)?.name ?? "?";
  const who = (id: string | null) => (id ? ` · ${ch.contactsById.get(id)?.name ?? "?"}` : "");
  table(
    [
      [c.dim("What for"), c.dim("On"), c.dim("Monthly"), c.dim("Progress"), c.dim("To pay"), c.dim("Principal"), c.dim("id")],
      ...list.map((p) => [
        `${p.title}${c.dim(`${p.merchant ? ` · ${p.merchant}` : ""}${who(p.contactId)}`)}`,
        name(p.accountId),
        money(p.instalment, cur),
        p.done ? c.dim("finished") : planProgress(p),
        p.done ? "" : money(p.toPay, cur),
        p.done ? "" : `${p.leftEstimated ? "≈" : ""}${money(p.left, cur)}`,
        c.dim(p.id.slice(-8)),
      ]),
      ["", "", "", "", "", "", ""],
      [c.bold("Total"), "", c.bold(money(list.filter((p) => !p.done).reduce((s, p) => s + p.instalment, 0), cur)), "", money(list.filter((p) => !p.done).reduce((s, p) => s + p.toPay, 0), cur), money(list.filter((p) => !p.done).reduce((s, p) => s + p.left, 0), cur), ""],
    ],
    ["l", "l", "r", "l", "r", "r", "l"],
  );
  console.log(c.dim("\nTo pay = instalments left, interest included. Principal = what you'd owe to close it today (counts in net worth); ≈ = worked out from the schedule."));
}

function planProgress(p: EmiPlan) {
  const end = p.lastMonth ? `ends ${p.lastMonth}` : "";
  if (p.done) return "finished";
  if (p.months && p.paid !== null) return `${p.paid}/${p.months} · ${end}`;
  return `≈${p.monthsLeft} left · ${end}`;
}

const SUBS_USAGE = `Usage:
  fin subs                         running subscriptions by category (--all includes cancelled)
  fin subs suggest                 recurring charges not tracked yet
  fin subs add "<name>" --amount N [--every weekly|monthly|quarterly|yearly] (--with <contact> | --match "<note text>")
               [--account A] [--for <company contact>] [--note N]
  fin subs edit <id|name> [--name N] [--amount N] [--every C] [--with C] [--match T] [--account A] [--for C] [--cancel | --restart]`;

async function cmdSubs(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const cur = entity.currency;
  const sub = args[0];
  const ch = await chart(ctx, entity);
  const body = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    if (flags.amount !== undefined) {
      const v = parseAmount(String(flags.amount));
      if (!v || v <= 0) throw new CliError("--amount must be an amount.");
      b.amount = v;
    }
    if (flags.every !== undefined) b.cadence = String(flags.every);
    if (flags.with !== undefined) b.contactId = String(flags.with) ? pick(String(flags.with), ch.contacts, "contact").id : null;
    if (flags.match !== undefined) b.matchText = String(flags.match) || null;
    if (flags.account !== undefined) b.accountId = String(flags.account) ? pick(String(flags.account), ch.money, "account").id : null;
    if (flags.for !== undefined) b.forContactId = String(flags.for) ? pick(String(flags.for), ch.contacts, "contact").id : null;
    if (flags.note !== undefined) b.note = String(flags.note) || null;
    return b;
  };
  const line = (s: Subscription) =>
    `${s.name}: ${money(s.amount, cur)} ${s.cadence} · ${s.charges.length} charges matched · ${s.nextDate ? `next ${s.nextDate}` : s.status}`;
  if (sub === "add") {
    const name = args.slice(1).join(" ").trim();
    if (!name || flags.amount === undefined) throw new CliError(SUBS_USAGE);
    const b = { name, cadence: "monthly", ...body() };
    const { subscription } = await ctx.client.req<{ subscription: Subscription }>("POST", `/entities/${entity.id}/subscriptions`, b);
    if (ctx.json) return console.log(JSON.stringify(subscription, null, 2));
    return console.log(`${c.green("✓")} ${line(subscription)}`);
  }
  if (sub === "suggest") {
    const { suggestions } = await ctx.client.req<{ suggestions: { name: string; amount: number; cadence: string; count: number; accountId: string; lastDate: string }[] }>(
      "GET",
      `/entities/${entity.id}/subscriptions/suggestions`,
    );
    if (ctx.json) return console.log(JSON.stringify(suggestions, null, 2));
    if (!suggestions.length) return console.log(c.dim("Nothing new looks recurring."));
    return table(suggestions.map((s) => [s.name, money(s.amount, cur), s.cadence, `${s.count}×`, ch.byId.get(s.accountId)?.name ?? "", c.dim(`last ${s.lastDate}`)]), ["l", "r", "l", "r", "l", "l"]);
  }
  const { subscriptions } = await ctx.client.req<{ subscriptions: Subscription[] }>("GET", `/entities/${entity.id}/subscriptions`);
  if (sub === "edit") {
    const q = args.slice(1).join(" ").trim();
    if (!q) throw new CliError(SUBS_USAGE);
    const s = subscriptions.find((x) => x.id === q || x.id.endsWith(q)) ?? pick(q, subscriptions, "subscription");
    const b = body();
    if (flags.name !== undefined) b.name = String(flags.name);
    if (flags.cancel) b.cancelled = true;
    if (flags.restart) b.cancelled = false;
    if (!Object.keys(b).length) throw new CliError(SUBS_USAGE);
    const { subscription } = await ctx.client.req<{ subscription: Subscription }>("PATCH", `/entities/${entity.id}/subscriptions/${s.id}`, b);
    if (ctx.json) return console.log(JSON.stringify(subscription, null, 2));
    return console.log(`${c.green("✓")} ${line(subscription)}`);
  }
  if (sub) throw new CliError(SUBS_USAGE);
  const list = subscriptions.filter((s) => flags.all || !s.cancelled);
  if (ctx.json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log(c.dim("No subscriptions tracked. fin subs suggest"));
  const cat = (id: string | null) => (id ? (ch.byId.get(id)?.name ?? "?") : "not charged yet");
  const rows: string[][] = [[c.dim("Name"), c.dim("Amount"), c.dim("Per month"), c.dim("Category"), c.dim("Card"), c.dim("Last"), c.dim("Next"), c.dim("id")]];
  for (const s of [...list].sort((a, b) => cat(a.categoryId).localeCompare(cat(b.categoryId)) || b.monthly - a.monthly))
    rows.push([
      `${s.name}${s.forContactId ? c.dim(` (for ${ch.contactsById.get(s.forContactId)?.name})`) : ""}${s.cancelled ? c.dim(" cancelled") : ""}`,
      `${money(s.amount, cur)}/${s.cadence.slice(0, 2)}`,
      money(s.monthly, cur),
      cat(s.categoryId),
      s.accountId ? (ch.byId.get(s.accountId)?.name ?? "") : "",
      s.lastDate ? `${s.lastDate}${s.priceChanged ? c.yellow(` ${money(s.lastAmount ?? 0, cur)}`) : ""}` : "—",
      s.status === "missed" ? c.yellow(`missed ${s.nextDate}`) : (s.nextDate ?? ""),
      c.dim(s.id.slice(-8)),
    ]);
  const run = list.filter((s) => !s.cancelled);
  rows.push(["", "", "", "", "", "", "", ""], [c.bold("Total"), "", c.bold(money(run.reduce((s, x) => s + x.monthly, 0), cur)), c.dim(`${money(run.reduce((s, x) => s + x.monthly, 0) * 12, cur)} a year`), "", "", "", ""]);
  table(rows, ["l", "r", "r", "l", "l", "l", "l", "l"]);
}

/** fin flag <id> "why" · fin unflag <id> · fin flagged: transactions the owner should look at. */
async function cmdFlag(ctx: Ctx, args: string[], clear: boolean) {
  const entity = await entityOf(ctx);
  const [idArg, ...why] = args;
  const reason = why.join(" ").trim();
  if (!idArg || (!clear && !reason)) throw new CliError(clear ? "Usage: fin unflag <id>" : 'Usage: fin flag <id> "why it needs a look"');
  const id = await findTx(ctx, entity, idArg);
  const { transaction } = await ctx.client.req<{ transaction: Transaction }>("POST", `/entities/${entity.id}/transactions/${id}/flag`, { reason: clear ? null : reason });
  if (ctx.json) return console.log(JSON.stringify(transaction, null, 2));
  console.log(`${c.green("✓")} ${clear ? "Cleared flag on" : "Flagged"} ${transaction.date} ${money(transaction.amount, entity.currency)}${clear ? "" : c.dim(` — ${reason}`)}`);
}

async function cmdFlagged(ctx: Ctx) {
  const entity = await entityOf(ctx);
  const { transactions } = await ctx.client.req<{ transactions: Transaction[] }>("GET", `/entities/${entity.id}/transactions?flagged=1&limit=500`);
  if (ctx.json) return console.log(JSON.stringify(transactions, null, 2));
  if (!transactions.length) return console.log(c.dim("Nothing flagged."));
  const ch = await chart(ctx, entity);
  for (const t of transactions) console.log(`${describe(t, ch.byId, entity.currency, ch.contactsById)}  ${c.dim(t.id.slice(-8))}\n    ${c.yellow(t.flag ?? "")}`);
}

/** fin contacts add "<name>" [--person] [--owes-you N | --you-owe N] [--as-of D] [--aliases "a, b"] */
async function cmdContactAdd(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const name = args.join(" ").trim();
  if (!name) throw new CliError('Usage: fin contacts add "<name>" [--person] [--owes-you N | --you-owe N] [--as-of D] [--aliases "a, b"]');
  if (flags["owes-you"] && flags["you-owe"]) throw new CliError("Pick one: --owes-you or --you-owe.");
  const entity = await entityOf(ctx);
  const body: Record<string, unknown> = { name, kind: flags.person ? "person" : "business" };
  if (flags.aliases) body.aliases = String(flags.aliases);
  const owed = flags["owes-you"] ?? flags["you-owe"];
  if (owed) {
    const amt = parseAmount(String(owed));
    if (!amt || amt <= 0) throw new CliError("The opening balance must be an amount above zero.");
    body.openingBalance = flags["owes-you"] ? amt : -amt;
    if (flags["as-of"]) {
      const d = parseDateInput(String(flags["as-of"]), today());
      if (!d) throw new CliError("--as-of must be a date like 2026-03-31.");
      body.openingDate = d;
    }
  }
  const { contact } = await ctx.client.req<{ contact: Contact }>("POST", `/entities/${entity.id}/contacts`, body);
  if (ctx.json) return console.log(JSON.stringify(contact, null, 2));
  const bal = contact.balance > 0 ? ` · owes you ${money(contact.balance, entity.currency)}` : contact.balance < 0 ? ` · you owe ${money(-contact.balance, entity.currency)}` : "";
  console.log(`${c.green("✓")} ${c.bold(contact.name)} (${contact.kind}) added to ${entity.name}${bal}`);
}

// ---- Statements ---------------------------------------------------------------------

function printPlan(plan: ImportPlan & { related?: Record<string, Transaction> }, cur: string, names: Map<string, string>) {
  const m = (n: number) => money(n, cur, "always");
  console.log(`${c.bold(plan.accountName)}  ${c.dim(`${plan.period.from} → ${plan.period.to}`)}  ${plan.lines.length} lines, balance chain verified ✓`);
  const tag = { link: c.green("matched "), new: c.blue("new     "), pending: c.yellow("needs you"), duplicate: c.dim("seen    "), reversal: c.dim("reversal") };
  for (const l of plan.lines) {
    let what = "";
    if (l.action === "link" && l.transactionId) {
      const t = plan.related?.[l.transactionId];
      what = c.dim(`= ${t?.note ?? (t?.contactId ? names.get(t.contactId) : null) ?? (t?.categoryId ? names.get(t.categoryId) : t?.kind)} (${t?.date})${l.match === "jev" ? " · Jev" : ""}`);
    } else if (l.action === "new" && l.proposal) {
      const p = l.proposal;
      const who = p.contactId ? names.get(p.contactId) : p.newContact ? `${p.newContact.name} (new)` : null;
      const target = p.kind === "transfer" ? `transfer ${names.get(p.accountId!)} → ${names.get(p.toAccountId!)}` : p.kind === "gave" || p.kind === "got" ? `${p.kind} ${who}` : `${p.categoryId ? names.get(p.categoryId) : "Uncategorised"}${who ? ` · ${who}` : ""}`;
      what = `→ ${target}${p.needsReview ? c.yellow(" · review") : ""}`;
    } else if (l.reason) what = c.yellow(l.reason);
    console.log(`  ${tag[l.action]}  ${c.dim(l.date)}  ${m(l.amount).padStart(12)}  ${l.description.slice(0, 44).padEnd(44)}  ${what}`);
  }
  const k = plan.counts;
  console.log(`\n${k.new} new · ${k.link} already recorded · ${k.pending} need you · ${k.duplicate} seen before · ${k.reversal} reversals`);
  for (const w of plan.warnings) console.log(c.yellow(`! ${w}`));
  for (const id of plan.notOnStatement) {
    const t = plan.related?.[id];
    if (t) console.log(c.dim(`  not on statement: ${t.date} ${money(t.amount, cur)} ${t.note ?? (t.contactId ? names.get(t.contactId) : null) ?? (t.categoryId ? names.get(t.categoryId) : "")}`));
  }
}

/** fin import statement.json [--account A] [--yes] [--check] · fin import --schema */
async function cmdImport(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  if (flags.schema) return console.log(JSON.stringify(STATEMENT_SCHEMA, null, 2));
  const file = args[0];
  if (!file) throw new CliError("Usage: fin import <statement.json> [--account A] [--yes]   (fin import --schema prints the format)");
  let st: StatementV1;
  try {
    st = JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"));
  } catch (err) {
    throw new CliError(`Can't read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const accountId = flags.account ? pick(String(flags.account), ch.money, "account").id : null;
  const { plan } = await ctx.client.req<{ plan: ImportPlan & { related?: Record<string, Transaction> } }>("POST", `/entities/${entity.id}/imports`, { statement: st, accountId });
  if (ctx.json && !flags.yes) return console.log(JSON.stringify(plan, null, 2));
  const names = new Map<string, string>([...ch.all.map((a) => [a.id, a.name] as [string, string]), ...ch.contacts.map((x) => [x.id, x.name] as [string, string])]);
  if (!ctx.json) printPlan(plan, entity.currency, names);
  if (flags.check) return;
  if (plan.counts.new + plan.counts.link + plan.counts.pending + plan.counts.reversal === 0) return console.log("Nothing new: every line was imported before.");
  if (!flags.yes) {
    if (!process.stdin.isTTY) return console.log(c.dim(`Preview only. Commit with: fin import ${file} --yes`));
    const ok = (await ask("Commit this import? [Y/n] ")).toLowerCase();
    if (ok && ok !== "y" && ok !== "yes") return console.log("Not imported.");
  }
  const r = await ctx.client.req<{ created: number; matched: number; review: number; ledgerClosing: number; closing: number; balanced: boolean }>("POST", `/entities/${entity.id}/imports/${plan.id}/commit`, {});
  if (ctx.json) return console.log(JSON.stringify({ importId: plan.id, ...r }, null, 2));
  console.log(`${c.green("✓")} Imported: ${r.created} new, ${r.matched} matched${r.review ? `, ${r.review} to review (fin review)` : ""}.`);
  console.log(
    r.balanced
      ? c.green(`  Books agree with the bank: ${money(r.closing, entity.currency)} on ${plan.period.to}.`)
      : c.yellow(`  Books show ${money(r.ledgerClosing, entity.currency)} on ${plan.period.to}; the statement says ${money(r.closing, entity.currency)}. Resolve fin review, then reconcile.`),
  );
  console.log(c.dim(`  undo: fin import undo ${plan.id}`));
}

async function cmdImports(ctx: Ctx, args: string[]) {
  const entity = await entityOf(ctx);
  if (args[0] === "undo") {
    if (!args[1]) throw new CliError("Usage: fin import undo <import id>");
    await ctx.client.req("POST", `/entities/${entity.id}/imports/${args[1]}/undo`, {});
    return console.log(`${c.green("✓")} Import undone.`);
  }
  const ch = await chart(ctx, entity);
  const { imports } = await ctx.client.req<{ imports: { id: string; accountId: string; status: string; period: { from: string; to: string }; created: number; matched: number; review: number; by: string }[] }>("GET", `/entities/${entity.id}/imports`);
  if (ctx.json) return console.log(JSON.stringify(imports, null, 2));
  if (!imports.length) return console.log(c.dim("No imports yet."));
  table(imports.map((i) => [c.dim(i.period.from), ch.byId.get(i.accountId)?.name ?? "?", `${i.created} new · ${i.matched} matched`, i.status === "undone" ? c.dim("undone") : "", c.dim(i.by), c.dim(i.id)]));
}

async function cmdReview(ctx: Ctx) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  const r = await ctx.client.req<{ lines: ReviewItem[]; transactions: Transaction[] }>("GET", `/entities/${entity.id}/review`);
  if (ctx.json) return console.log(JSON.stringify(r, null, 2));
  if (!r.lines.length && !r.transactions.length) return console.log(c.green("Nothing to review."));
  if (r.lines.length) {
    console.log(c.bold("Statement lines waiting for you"));
    for (const l of r.lines) {
      console.log(`  ${c.dim(l.date)}  ${money(l.amount, entity.currency, "always")}  ${l.description.slice(0, 50)}  ${c.yellow(l.reason)}`);
      for (const t of l.candidates) console.log(c.dim(`      maybe: ${describe(t, ch.byId, entity.currency, ch.contactsById)}  ${t.id.slice(-8)}`));
    }
  }
  if (r.transactions.length) {
    console.log(c.bold(`\nImported guesses to check (${r.transactions.length})`));
    for (const t of r.transactions) console.log(`  ${describe(t, ch.byId, entity.currency, ch.contactsById)}  ${c.dim(t.id.slice(-8))}`);
  }
  console.log(c.dim("\nResolve in the web app (Imports → Review), or edit a transaction to confirm it."));
}

/** fin accounts link "HDFC Savings" --last4 4821 [--bank "HDFC Bank"] [--ifsc HDFC0001234] */
async function cmdLink(ctx: Ctx, args: string[], flags: Record<string, string | boolean | undefined>) {
  const entity = await entityOf(ctx);
  const ch = await chart(ctx, entity);
  if (!args[0] || !flags.last4) throw new CliError('Usage: fin accounts link "<account>" --last4 4821 [--bank "HDFC Bank"] [--ifsc HDFC0001234]');
  const a = pick(args.join(" "), ch.money, "account");
  await ctx.client.req("PATCH", `/entities/${entity.id}/accounts/${a.id}`, {
    numberLast4: String(flags.last4),
    ...(flags.bank ? { institution: String(flags.bank) } : {}),
    ...(flags.ifsc ? { ifsc: String(flags.ifsc) } : {}),
  });
  console.log(`${c.green("✓")} Statements ending in ${flags.last4} now import into ${a.name}.`);
}

const HELP = `${c.bold("fin")} — your money from the terminal

  ${c.bold("fin login")} [--url URL] [--profile NAME] [--agent NAME]   approve in the browser (or --password, --token T)
  ${c.bold("fin entities add")} "<name>" [--business]
  ${c.bold("fin accounts add")} "<name>" --type bank|cash|wallet|card|investment|fd|property|loan|other
        [--balance N] [--as-of D] [--bank B] [--last4 NNNN] [--ifsc X] [--joint "Name" --share 50]
  ${c.bold("fin accounts edit")} "<account>" [--name N] [--type T] [--bank B] [--last4 NNNN] [--joint "Name"] [--share 50]
  ${c.bold("fin accounts archive")} "<account>"   ·   cards take --limit 3L
  ${c.bold("fin accounts reconcile")} "<account>" <balance> [--date D]   set a balance on a past date
  ${c.bold("fin credit")}                    card limits, used, available, utilisation
  ${c.bold("fin flag <id> \"why\"")}          ask the owner to look at a transaction (fin unflag <id>, fin flagged)
  ${c.bold("fin subs")}                      subscriptions: what recurs, monthly cost, next charge (fin subs --help)
  ${c.bold("fin emi")}                       EMIs: what each paid for, months and amount left (fin emi --help)
  ${c.bold("fin contacts merge")} "<dup>" … --into "<keep>"  ·  ${c.bold("fin contacts edit")} "<c>" [--name N] [--category C [--apply]] [--archive]
  ${c.bold("fin categories add")} "<name>" [--income]
  ${c.bold("fin contacts add")} "<name>" [--person] [--owes-you N | --you-owe N] [--as-of D]
  ${c.bold('fin "<text>"')}                 smart add or ask: "chai 40 cash", "spent on food last month?"
  ${c.bold("fin add")} <amount> <category> [note]   [--account A] [--date D] [--with contact]
        [--split rahul[:share]]   you paid the total, they owe their share (default half)
        [--paid-by priya [--mine N]]   they paid, you owe your share
  ${c.bold("fin income")} <amount> <category> [note] [--with contact]
  ${c.bold("fin transfer")} <amount> <from> <to> [note]
  ${c.bold("fin gave")} <amount> <contact> [note] · ${c.bold("fin got")} <amount> <contact> [note]   lending and paying back
  ${c.bold("fin owes")}                     who owes whom · ${c.bold("fin contacts")}
  ${c.bold("fin ask")} "<question>"
  ${c.bold("fin ls")} [--month 2026-10|last] [--fy [2025]] [--from D --to D] [-q text] [--category C] [--account A] [--with contact]
  ${c.bold("fin summary")} [--month M] [--fy]
  ${c.bold("fin accounts")} [--as-of 2026-03-31]   balance sheet, incl. loans and people
  ${c.bold("fin categories")} [--income] · ${c.bold("fin entities")} · ${c.bold("fin use")} <entity>
  ${c.bold("fin edit")} <id> [--kind expense|income|transfer|gave|got] [--from A] [--to A] [--category C] [--with C | --no-contact] [--note N] [--date D] [--reviewed]
  ${c.bold("fin rm")} <id> · ${c.bold("fin undo")} <id>
  ${c.bold("fin export")} [--month M | --fy] [--journal] > file.csv
  ${c.bold("fin import")} <statement.json> [--account A] [--yes] [--check]   bank/card statement (fin import --schema)
  ${c.bold("fin imports")} · ${c.bold("fin import undo")} <id> · ${c.bold("fin review")}
  ${c.bold("fin accounts link")} "<account>" --last4 4821 [--bank "HDFC Bank"] [--ifsc …]
  ${c.bold("fin whoami")} · ${c.bold("fin logout")}

  Global: --json  --entity NAME  --profile NAME  --yes (save smart adds without asking)
  --source sms|email   where an add came from (agents reading an SMS or email)
  Agents: fin login --agent Kaira   so everything it adds says "added by Kaira (agent)"
  Amounts: 250 · 1.5k · 2L · 1,20,000 · 120+80
  Profiles let one CLI talk to several servers, e.g. personal and company:
    fin login --profile company --url https://finance.example.org
    fin --profile company ls`;

// ---- Entry -------------------------------------------------------------------------

async function main() {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      profile: { type: "string", short: "p" },
      entity: { type: "string", short: "e" },
      url: { type: "string" },
      token: { type: "string" },
      email: { type: "string" },
      account: { type: "string", short: "a" },
      category: { type: "string", short: "c" },
      date: { type: "string", short: "d" },
      month: { type: "string", short: "m" },
      fy: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      note: { type: "string" },
      q: { type: "string", short: "q" },
      limit: { type: "string" },
      income: { type: "boolean" },
      journal: { type: "boolean" },
      with: { type: "string", short: "w" },
      split: { type: "string" },
      "paid-by": { type: "string" },
      mine: { type: "string" },
      "as-of": { type: "string" },
      source: { type: "string" },
      agent: { type: "string" },
      schema: { type: "boolean" },
      check: { type: "boolean" },
      last4: { type: "string" },
      bank: { type: "string" },
      ifsc: { type: "string" },
      type: { type: "string", short: "t" },
      balance: { type: "string" },
      joint: { type: "string" },
      share: { type: "string" },
      group: { type: "string" },
      icon: { type: "string" },
      name: { type: "string" },
      business: { type: "boolean" },
      person: { type: "boolean" },
      currency: { type: "string" },
      "fy-start": { type: "string" },
      "owes-you": { type: "string" },
      "you-owe": { type: "string" },
      aliases: { type: "string" },
      password: { type: "boolean" },
      "no-browser": { type: "boolean" },
      into: { type: "string" },
      kind: { type: "string" },
      "no-contact": { type: "boolean" },
      reviewed: { type: "boolean" },
      instalment: { type: "string" },
      amount: { type: "string" },
      every: { type: "string" },
      match: { type: "string" },
      for: { type: "string" },
      cancel: { type: "boolean" },
      restart: { type: "boolean" },
      principal: { type: "string" },
      months: { type: "string" },
      first: { type: "string" },
      merchant: { type: "string" },
      evidence: { type: "string" },
      purchase: { type: "string" },
      loan: { type: "string" },
      "in-card": { type: "boolean" },
      close: { type: "boolean" },
      reopen: { type: "boolean" },
      all: { type: "boolean" },
      archive: { type: "boolean" },
      apply: { type: "boolean" },
      hint: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  // --fy with no value
  const argv = process.argv.slice(2);
  if (argv.includes("--fy") && (flags.fy === undefined || flags.fy?.startsWith("-"))) (flags as Record<string, unknown>).fy = true;

  const [cmd, ...args] = positionals;
  if (flags.version) return console.log(VERSION);
  if (flags.help && (cmd === "emi" || cmd === "emis")) return console.log(EMI_USAGE);
  if (flags.help && (cmd === "subs" || cmd === "subscriptions")) return console.log(SUBS_USAGE);
  if (flags.help || !cmd || cmd === "help") return console.log(HELP);

  const cfg = loadConfig();
  const profileName = flags.profile ?? process.env.FIN_PROFILE ?? cfg.current ?? "default";
  const base = { cfg, profileName, json: !!flags.json, entityFlag: flags.entity };

  if (cmd === "login") return cmdLogin(base, flags);
  if (cmd === "import" && flags.schema) return console.log(JSON.stringify(STATEMENT_SCHEMA, null, 2));
  if (cmd === "logout") {
    const p = cfg.profiles[profileName];
    if (p) {
      await new Client(p, profileName).req("GET", "/me/tokens").then(
        async (r) => {
          const t = (r as { tokens: { id: string; current: boolean }[] }).tokens.find((x) => x.current);
          if (t) await new Client(p, profileName).req("DELETE", `/me/tokens/${t.id}`);
        },
        () => {},
      );
      delete cfg.profiles[profileName];
      saveConfig(cfg);
    }
    return console.log("Signed out. The token was revoked.");
  }

  const stored = cfg.profiles[profileName];
  const url = process.env.FIN_URL ?? stored?.url;
  const token = process.env.FIN_TOKEN ?? stored?.token;
  if (!url || !token) throw new CliError(`Not signed in. Run: fin login${profileName !== "default" ? ` --profile ${profileName}` : ""}`);
  if (!cfg.profiles[profileName]) cfg.profiles[profileName] = { url, token };
  const ctx: Ctx = { ...base, client: new Client({ ...stored, url, token }, profileName) };

  switch (cmd) {
    case "whoami": {
      const me = await ctx.client.req<Me>("GET", "/me");
      const e = await entityOf(ctx);
      if (ctx.json) return console.log(JSON.stringify({ ...me, currentEntity: e }, null, 2));
      return console.log(`${me.user.name} <${me.user.email}> on ${url} · using ${c.bold(e.name)} (${e.role})`);
    }
    case "entities":
    case "entity":
      if (args[0] === "add") return cmdEntityAdd(ctx, args.slice(1), flags);
      return cmdEntities(ctx);
    case "use":
      return cmdUse(ctx, args);
    case "accounts":
    case "balance":
    case "bs":
      if (args[0] === "link") return cmdLink(ctx, args.slice(1), flags);
      if (args[0] === "add") return cmdAccountAdd(ctx, args.slice(1), flags);
      if (args[0] === "edit") return cmdAccountEdit(ctx, args.slice(1), flags);
      if (args[0] === "archive") return cmdAccountEdit(ctx, args.slice(1), flags, true);
      if (args[0] === "reconcile") return cmdReconcile(ctx, args.slice(1), flags);
      if (args[0] === "restore") return cmdAccountEdit(ctx, args.slice(1), flags, false);
      return cmdAccounts(ctx, flags);
    case "import":
      if (args[0] === "undo") return cmdImports(ctx, args);
      return cmdImport(ctx, args, flags);
    case "imports":
      return cmdImports(ctx, args);
    case "review":
      return cmdReview(ctx);
    case "edit":
      return cmdEdit(ctx, args, flags);
    case "flag":
      return cmdFlag(ctx, args, false);
    case "unflag":
      return cmdFlag(ctx, args, true);
    case "flagged":
      return cmdFlagged(ctx);
    case "subs":
    case "subscriptions":
      if (flags.help) return console.log(SUBS_USAGE);
      return cmdSubs(ctx, args, flags);
    case "emi":
    case "emis":
      if (flags.help) return console.log(EMI_USAGE);
      return cmdEmi(ctx, args, flags);
    case "credit":
    case "limits":
      return cmdCredit(ctx);
    case "contacts":
    case "contact":
      if (args[0] === "add") return cmdContactAdd(ctx, args.slice(1), flags);
      if (args[0] === "merge") return cmdContactMerge(ctx, args.slice(1), flags);
      if (args[0] === "edit") return cmdContactEdit(ctx, args.slice(1), flags);
      return cmdContacts(ctx, false);
    case "owes":
    case "owe":
    case "ious":
      return cmdContacts(ctx, true);
    case "gave":
    case "lend":
      return cmdAdd(ctx, "gave", args, flags);
    case "got":
      return cmdAdd(ctx, "got", args, flags);
    case "categories":
      if (args[0] === "add") return cmdCategoryAdd(ctx, args.slice(1), flags);
      if (args[0] === "archive") {
        const entity = await entityOf(ctx);
        const ch = await chart(ctx, entity);
        const cat = pick(args.slice(1).join(" "), [...ch.expense, ...ch.income], "category");
        await ctx.client.req("PATCH", `/entities/${entity.id}/accounts/${cat.id}`, { archived: true });
        return console.log(`${c.green("✓")} Archived category ${cat.name} (history stays).`);
      }
      return cmdCategories(ctx, flags);
    case "add":
    case "expense":
      return cmdAdd(ctx, "expense", args, flags);
    case "income":
      return cmdAdd(ctx, "income", args, flags);
    case "transfer":
      return cmdAdd(ctx, "transfer", args, flags);
    case "ls":
    case "list":
      return cmdList(ctx, flags);
    case "summary":
      return cmdSummary(ctx, flags);
    case "rm":
    case "delete":
      return cmdRemove(ctx, args);
    case "undo":
    case "restore":
      return cmdRemove(ctx, args, true);
    case "ask":
      return cmdSmart(ctx, args.join(" "), flags, "ask");
    case "export":
      return cmdExport(ctx, flags);
    default:
      // Anything else is free text: `fin chai 40 cash` or `fin "spent on food last month?"`
      return cmdSmart(ctx, positionals.join(" "), flags);
  }
}

main().catch((err) => {
  console.error(c.red(err instanceof CliError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(err instanceof CliError ? err.code : 1);
});
