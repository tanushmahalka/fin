// End-to-end API check against a running instance on a FRESH local database.
//   rm -rf .wrangler/state && npm run db:migrate:local && npm run dev
//   npm run test:e2e            (BASE=http://localhost:5180 by default)
// Exercises auth, multi-entity isolation, roles, the ledger invariants, export and Jev assist.

import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:5180";
const PASSWORD = "correct-horse-battery";
let failures = 0;

class Client {
  cookie = "";
  constructor(name, bearer) {
    this.name = name;
    this.bearer = bearer;
  }
  async req(method, path, body) {
    const headers = { origin: BASE };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const res = await fetch(BASE + "/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(";");
      if (pair.startsWith("fin_session=")) this.cookie = pair.endsWith("=") ? "" : pair;
    }
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get = (p) => this.req("GET", p);
  post = (p, b = {}) => this.req("POST", p, b);
  patch = (p, b) => this.req("PATCH", p, b);
  put = (p, b) => this.req("PUT", p, b);
  del = (p) => this.req("DELETE", p);
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${err.message.split("\n").join("\n    ")}`);
  }
}

const owner = new Client("owner");
const ca = new Client("ca");
const stranger = new Client("stranger");
let personal, company, acct, cats;

console.log(`E2E against ${BASE}`);

await step("fresh instance needs setup", async () => {
  const r = await owner.get("/auth/status");
  assert.equal(r.data.needsSetup, true, "run against a fresh database");
});

await step("setup creates the first account and signs in", async () => {
  const r = await owner.post("/auth/setup", { name: "Asha Rao", email: "owner@example.com", password: PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(owner.cookie, "session cookie set");
});

await step("second setup is refused", async () => {
  const r = await stranger.post("/auth/setup", { name: "X", email: "x@example.com", password: PASSWORD });
  assert.equal(r.status, 403);
});

await step("cookie writes without our Origin are refused (CSRF)", async () => {
  const r = await fetch(BASE + "/api/entities", { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
  assert.equal(r.status, 403);
});

await step("create two entities with seeded charts of accounts", async () => {
  const a = await owner.post("/entities", { name: "Asha Rao", kind: "personal" });
  const b = await owner.post("/entities", { name: "Acme Studio", kind: "business" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  personal = a.data.entity;
  company = b.data.entity;
  assert.equal(personal.fyStartMonth, 4, "INR defaults to an April FY");
  const me = await owner.get("/me");
  assert.equal(me.data.entities.length, 2);
});

const accountsOf = async (c, e) => (await c.get(`/entities/${e.id}/accounts`)).data.accounts;
const byName = (list, name) => list.find((a) => a.name === name);

await step("accounts and categories are seeded", async () => {
  const list = await accountsOf(owner, personal);
  acct = { cash: byName(list, "Cash"), bank: byName(list, "Bank account"), card: byName(list, "Credit card") };
  cats = { food: byName(list, "Food & dining"), salary: byName(list, "Salary"), transport: byName(list, "Transport") };
  assert.ok(acct.cash && acct.bank && acct.card && cats.food && cats.salary);
  assert.equal(personal.defaultAccountId, acct.cash.id);
});

await step("opening balance posts against equity", async () => {
  const r = await owner.post(`/entities/${personal.id}/accounts`, { type: "asset", subtype: "bank", name: "HDFC Savings", openingBalance: 5_000_000, openingDate: "2026-04-01" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.account.balance, 5_000_000);
  acct.hdfc = r.data.account;
});

await step("duplicate account names are rejected", async () => {
  const r = await owner.post(`/entities/${personal.id}/accounts`, { type: "asset", name: "hdfc savings" });
  assert.equal(r.status, 409);
});

let chaiId;
await step("expense, income, transfer post balanced entries", async () => {
  const e = await owner.post(`/entities/${personal.id}/transactions`, { kind: "expense", date: "2026-10-28", amount: 4_000, accountId: acct.cash.id, categoryId: cats.food.id, note: "Chai" });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  chaiId = e.data.transaction.id;
  assert.deepEqual(
    e.data.transaction.postings.map((p) => p.amount).sort((x, y) => x - y),
    [-4000, 4000],
  );
  const i = await owner.post(`/entities/${personal.id}/transactions`, { kind: "income", date: "2026-10-01", amount: 8_000_000, accountId: acct.hdfc.id, categoryId: cats.salary.id });
  assert.equal(i.status, 201);
  const t = await owner.post(`/entities/${personal.id}/transactions`, { kind: "transfer", date: "2026-10-02", amount: 500_000, accountId: acct.hdfc.id, toAccountId: acct.cash.id, note: "ATM" });
  assert.equal(t.status, 201);
  const card = await owner.post(`/entities/${personal.id}/transactions`, { kind: "expense", date: "2026-10-03", amount: 120_000, accountId: acct.card.id, categoryId: cats.transport.id, note: "Flight cab" });
  assert.equal(card.status, 201);
});

await step("balances: cash 5000−40, HDFC 50k+80k−5k, card owes 1200", async () => {
  const list = await accountsOf(owner, personal);
  assert.equal(byName(list, "Cash").balance, 500_000 - 4_000);
  assert.equal(byName(list, "HDFC Savings").balance, 5_000_000 + 8_000_000 - 500_000);
  assert.equal(byName(list, "Credit card").balance, -120_000, "liabilities carry credit balances");
});

await step("summary excludes transfers and opening balances", async () => {
  const r = await owner.get(`/entities/${personal.id}/summary?from=2026-10-01&to=2026-10-31`);
  assert.equal(r.data.income, 8_000_000);
  assert.equal(r.data.expense, 4_000 + 120_000);
});

await step("bad postings are rejected (wrong category type, same-account transfer)", async () => {
  const a = await owner.post(`/entities/${personal.id}/transactions`, { kind: "expense", amount: 100, accountId: acct.cash.id, categoryId: cats.salary.id });
  assert.equal(a.status, 400);
  const b = await owner.post(`/entities/${personal.id}/transactions`, { kind: "transfer", amount: 100, accountId: acct.cash.id, toAccountId: acct.cash.id });
  assert.equal(b.status, 400);
});

await step("cross-entity account use is rejected", async () => {
  const companyAccounts = await accountsOf(owner, company);
  const r = await owner.post(`/entities/${personal.id}/transactions`, { kind: "expense", amount: 100, accountId: byName(companyAccounts, "Current account").id, categoryId: cats.food.id });
  assert.equal(r.status, 400);
});

await step("client ids make creates idempotent", async () => {
  const id = "01890a5d-ac96-774b-bcce-b302099a8057";
  const body = { id, kind: "expense", date: "2026-10-29", amount: 2_500, accountId: acct.cash.id, categoryId: cats.food.id };
  const first = await owner.post(`/entities/${personal.id}/transactions`, body);
  const again = await owner.post(`/entities/${personal.id}/transactions`, body);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  const list = await owner.get(`/entities/${personal.id}/transactions?from=2026-10-29&to=2026-10-29`);
  assert.equal(list.data.transactions.length, 1);
});

await step("edit rewrites postings; delete is soft and restorable", async () => {
  const e = await owner.patch(`/entities/${personal.id}/transactions/${chaiId}`, { amount: 6_000, note: "Chai + samosa" });
  assert.equal(e.status, 200);
  assert.equal(e.data.transaction.amount, 6_000);
  assert.equal((await owner.del(`/entities/${personal.id}/transactions/${chaiId}`)).status, 200);
  assert.equal((await owner.get(`/entities/${personal.id}/transactions/${chaiId}`)).status, 404);
  assert.equal((await owner.post(`/entities/${personal.id}/transactions/${chaiId}/restore`)).status, 200);
});

await step("reconcile posts an adjustment to reach the stated balance", async () => {
  const r = await owner.post(`/entities/${personal.id}/accounts/${acct.cash.id}/adjust`, { balance: 450_000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.account.balance, 450_000);
});

await step("every transaction balances (integrity)", async () => {
  const r = await owner.get(`/entities/${personal.id}/integrity`);
  assert.equal(r.data.ok, true, JSON.stringify(r.data));
});

await step("ledger shows running balance", async () => {
  const r = await owner.get(`/entities/${personal.id}/accounts/${acct.hdfc.id}/ledger`);
  assert.equal(r.data.rows[0].running, 5_000_000 + 8_000_000 - 500_000);
});

await step("audit log is append-only and records changes", async () => {
  const r = await owner.get(`/entities/${personal.id}/activity`);
  assert.ok(r.data.items.length >= 8);
  assert.ok(r.data.items.some((i) => i.action === "transaction.update"));
});

let inviteUrl;
await step("owner invites the CA to the company as viewer", async () => {
  const r = await owner.post(`/entities/${company.id}/invites`, { email: "ca@example.com", role: "viewer" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  inviteUrl = r.data.url;
});

await step("CA accepts by creating an account", async () => {
  const token = inviteUrl.split("/invite/")[1];
  const preview = await ca.get(`/invites/${token}`);
  assert.equal(preview.data.entityName, "Acme Studio");
  const r = await ca.post(`/invites/${token}/accept`, { name: "Priya (CA)", password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = await ca.get("/me");
  assert.deepEqual(me.data.entities.map((e) => e.name), ["Acme Studio"]);
  assert.equal((await ca.get(`/invites/${token}`)).status, 410, "invite is single-use");
});

await step("CA cannot see the personal entity (404, not 403)", async () => {
  assert.equal((await ca.get(`/entities/${personal.id}`)).status, 404);
  assert.equal((await ca.get(`/entities/${personal.id}/transactions`)).status, 404);
});

await step("viewer can read and export but not write", async () => {
  assert.equal((await ca.get(`/entities/${company.id}/transactions`)).status, 200);
  const list = await accountsOf(ca, company);
  const w = await ca.post(`/entities/${company.id}/transactions`, { kind: "expense", amount: 100, accountId: byName(list, "Current account").id, categoryId: byName(list, "Ad spend").id });
  assert.equal(w.status, 403);
  assert.equal((await ca.get(`/entities/${company.id}/export.csv`)).status, 200);
});

await step("owner promotes CA to editor; last owner cannot be demoted", async () => {
  const me = await owner.get("/me");
  const members = await owner.get(`/entities/${company.id}/members`);
  const caMember = members.data.members.find((m) => m.email === "ca@example.com");
  assert.equal((await owner.patch(`/entities/${company.id}/members/${caMember.userId}`, { role: "editor" })).status, 200);
  assert.equal((await owner.patch(`/entities/${company.id}/members/${me.data.user.id}`, { role: "viewer" })).status, 400);
});

await step("CSV export neutralises formula injection", async () => {
  const list = await accountsOf(owner, company);
  await owner.post(`/entities/${company.id}/transactions`, { kind: "expense", date: "2026-10-10", amount: 99_900, accountId: byName(list, "Current account").id, categoryId: byName(list, "Ad spend").id, note: "=HYPERLINK(\"http://evil\")" });
  const r = await owner.get(`/entities/${company.id}/export.csv?from=2026-10-01&to=2026-10-31`);
  assert.match(r.data, /'=HYPERLINK/);
  assert.match(r.headers.get("content-disposition"), /acme-studio_2026-10-01_2026-10-31_transactions\.csv/);
  const j = await owner.get(`/entities/${company.id}/export.csv?from=2026-10-01&to=2026-10-31&format=journal`);
  assert.match(j.data, /Debit,Credit/);
});

let cliToken;
await step("CLI token login works and is revocable", async () => {
  const r = await stranger.post("/auth/token", { email: "owner@example.com", password: PASSWORD, name: "test" });
  assert.equal(r.status, 201);
  cliToken = r.data.token;
  assert.match(cliToken, /^fin_/);
  const cli = new Client("cli", cliToken);
  assert.equal((await cli.get("/me")).status, 200);
  assert.equal((await cli.post(`/entities/${personal.id}/transactions`, { kind: "expense", amount: 1000, accountId: acct.cash.id, categoryId: cats.food.id })).status, 201, "bearer writes need no Origin");
  const tokens = await owner.get("/me/tokens");
  assert.equal((await owner.del(`/me/tokens/${tokens.data.tokens[0].id}`)).status, 200);
  assert.equal((await cli.get("/me")).status, 401);
});

await step("wrong password is rejected without revealing the email exists", async () => {
  const a = await stranger.post("/auth/login", { email: "owner@example.com", password: "nope-nope-nope" });
  const b = await stranger.post("/auth/login", { email: "nobody@example.com", password: "nope-nope-nope" });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.data.error.message, b.data.error.message);
});

// ---- Contacts and who owes whom ----------------------------------------------
const P = () => `/entities/${personal.id}`;
const contactsOf = async () => (await owner.get(`${P()}/contacts`)).data.contacts;
let blinkit, rahul, priya;

await step("contacts: create, duplicate names refused", async () => {
  const r = await owner.post(`${P()}/contacts`, { name: "Blinkit", kind: "business", aliases: "grofers" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  blinkit = r.data.contact;
  assert.equal((await owner.post(`${P()}/contacts`, { name: "blinkit" })).status, 409);
});

await step("expense tagged with a contact counts as money sent to them", async () => {
  const groceries = byName(await accountsOf(owner, personal), "Groceries");
  const r = await owner.post(`${P()}/transactions`, { kind: "expense", date: "2026-10-20", amount: 64_000, accountId: acct.hdfc.id, categoryId: groceries.id, contactId: blinkit.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.transaction.contactId, blinkit.id);
  const b = (await contactsOf()).find((c) => c.id === blinkit.id);
  assert.equal(b.sent, 64_000);
  assert.equal(b.topCategoryId, groceries.id, "history remembers the usual category");
  assert.equal(b.lastAccountId, acct.hdfc.id, "and the usual account");
});

await step("gave: lending creates a new contact inline and a balance they owe", async () => {
  const r = await owner.post(`${P()}/transactions`, { kind: "gave", date: "2026-10-21", amount: 200_000, accountId: acct.hdfc.id, newContact: { name: "Rahul", kind: "person" }, note: "Goa trip advance" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.transaction.kind, "gave");
  rahul = (await contactsOf()).find((c) => c.name === "Rahul");
  assert.equal(rahul.balance, 200_000);
  assert.equal(rahul.sent, 200_000);
});

await step("got: repayment reduces what they owe; lending is never income or spending", async () => {
  await owner.post(`${P()}/transactions`, { kind: "got", date: "2026-10-22", amount: 50_000, accountId: acct.hdfc.id, contactId: rahul.id });
  assert.equal((await contactsOf()).find((c) => c.id === rahul.id).balance, 150_000);
  const s = await owner.get(`${P()}/summary?from=2026-10-21&to=2026-10-22`);
  assert.equal(s.data.income, 0);
  assert.equal(s.data.expense, 0);
});

let splitId;
await step("split: you pay ₹3,000, your share ₹1,000 is spending, Rahul owes ₹2,000", async () => {
  const r = await owner.post(`${P()}/transactions`, { kind: "expense", date: "2026-10-23", amount: 100_000, accountId: acct.card.id, categoryId: cats.food.id, share: { contactId: rahul.id, amount: 200_000 }, note: "Dinner" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  splitId = r.data.transaction.id;
  assert.deepEqual(r.data.transaction.share, { contactId: rahul.id, amount: 200_000 });
  assert.equal(r.data.transaction.postings.length, 3);
  assert.equal((await contactsOf()).find((c) => c.id === rahul.id).balance, 350_000);
  const s = await owner.get(`${P()}/summary?from=2026-10-23&to=2026-10-23`);
  assert.equal(s.data.expense, 100_000, "only your share is spending");
});

await step("paid by: Priya paid ₹650 for you, so you owe her", async () => {
  const p = await owner.post(`${P()}/contacts`, { name: "Priya", kind: "person" });
  priya = p.data.contact;
  const r = await owner.post(`${P()}/transactions`, { kind: "expense", date: "2026-10-24", amount: 65_000, categoryId: byName(await accountsOf(owner, personal), "Entertainment").id, paidBy: priya.id, note: "Movie" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.transaction.paidBy, priya.id);
  assert.equal((await contactsOf()).find((c) => c.id === priya.id).balance, -65_000);
});

await step("Lent & borrowed equals the sum of contact balances", async () => {
  const list = await accountsOf(owner, personal);
  const iou = list.find((a) => a.id === personal.iouAccountId);
  const total = (await contactsOf()).reduce((s, c) => s + c.balance, 0);
  assert.equal(iou.balance, total);
  assert.equal(total, 350_000 - 65_000);
});

await step("editing a split away updates who owes whom", async () => {
  const r = await owner.patch(`${P()}/transactions/${splitId}`, { share: null });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.transaction.postings.length, 2);
  assert.equal((await contactsOf()).find((c) => c.id === rahul.id).balance, 150_000);
});

await step("statement shows a running balance; archiving needs settling up", async () => {
  const st = await owner.get(`${P()}/contacts/${rahul.id}/statement`);
  assert.equal(st.data.rows[0].running, 150_000);
  assert.equal((await owner.patch(`${P()}/contacts/${rahul.id}`, { archived: true })).status, 400);
});

await step("balances as of a date (balance sheet for 31 March)", async () => {
  const r = await owner.get(`${P()}/accounts?asOf=2026-10-21`);
  const iou = r.data.accounts.find((a) => a.id === personal.iouAccountId);
  assert.equal(iou.balance, 200_000);
});

await step("a company contact can't be used in personal books", async () => {
  const co = await owner.post(`/entities/${company.id}/contacts`, { name: "AWS" });
  const r = await owner.post(`${P()}/transactions`, { kind: "expense", amount: 100, accountId: acct.cash.id, categoryId: cats.food.id, contactId: co.data.contact.id });
  assert.equal(r.status, 400);
});

await step("gave/got without a contact is refused", async () => {
  const r = await owner.post(`${P()}/transactions`, { kind: "gave", amount: 100, accountId: acct.cash.id });
  assert.equal(r.status, 400);
});

await step("integrity still holds with splits and IOUs", async () => {
  assert.equal((await owner.get(`${P()}/integrity`)).data.ok, true);
});

// ---- Jev assist -------------------------------------------------------------
const assistCase = async (entity, text, mode = "auto") => (await owner.get(`/entities/${entity.id}/assist?mode=${mode}&text=${encodeURIComponent(text)}`)).data;

await step("assist: 'chai 40 cash yesterday' → expense, food, cash, ₹40, yesterday", async () => {
  const r = await assistCase(personal, "chai 40 cash yesterday");
  assert.equal(r.mode, "record", JSON.stringify(r));
  const d = r.parse.draft;
  assert.equal(d.kind, "expense");
  assert.equal(d.amount, 4_000);
  assert.equal(d.categoryId, cats.food.id, `category ${JSON.stringify(r.parse)}`);
  assert.equal(d.accountId, acct.cash.id);
  console.log(`      source=${r.source} model=${r.model ?? "-"} ${r.ms}ms note=${JSON.stringify(d.note)}`);
});

await step("assist: salary goes to income", async () => {
  const r = await assistCase(personal, "got 80k salary in hdfc", "record");
  assert.equal(r.parse.draft.kind, "income");
  assert.equal(r.parse.draft.amount, 8_000_000);
  assert.equal(r.parse.draft.categoryId, cats.salary.id);
});

await step("assist: question routes to ask and code computes the answer", async () => {
  const r = await assistCase(personal, "how much did I spend on food in october?");
  assert.equal(r.mode, "ask", JSON.stringify(r));
  assert.equal(r.ask.intent, "spending");
  console.log(`      → ${r.ask.answer}`);
});

await step("assist: personal spend in the company is flagged", async () => {
  const r = await assistCase(company, "netflix 649 for home", "record");
  console.log(`      warnings=${JSON.stringify(r.parse.warnings.map((w) => [w.code, Math.round(w.probability * 100) / 100]))}`);
  if (r.source === "jev") assert.ok(r.parse.warnings.some((w) => w.code === "looks_personal"));
});

await step("assist: known contact is recognised and history fills the category", async () => {
  const r = await assistCase(personal, "blinkit 230");
  assert.equal(r.parse.draft.contactId, blinkit.id, JSON.stringify(r.parse));
  assert.equal(byName(await accountsOf(owner, personal), "Groceries").id, r.parse.draft.categoryId);
});

await step("assist: 'lent rahul 2000' → gave, Rahul", async () => {
  const r = await assistCase(personal, "lent rahul 2000", "record");
  assert.equal(r.parse.draft.kind, "gave", JSON.stringify(r.parse.draft));
  assert.equal(r.parse.draft.contactId, rahul.id);
});

await step("assist: a new merchant name is proposed as a new contact", async () => {
  const r = await assistCase(personal, "zepto 640", "record");
  console.log(`      newContact=${JSON.stringify(r.parse.draft.newContact)}`);
  if (r.source === "jev") assert.equal(r.parse.draft.newContact?.name, "Zepto");
});

await step("assist: who owes me", async () => {
  const r = await assistCase(personal, "how much does rahul owe me?");
  assert.equal(r.ask?.intent, "owed", JSON.stringify(r));
  console.log(`      → ${r.ask.answer}`);
});

await step("contact suggestions from past notes", async () => {
  for (const d of ["2026-10-01", "2026-10-02"]) await owner.post(`${P()}/transactions`, { kind: "expense", date: d, amount: 45_000, accountId: acct.cash.id, categoryId: cats.food.id, note: "Swiggy dinner" });
  const r = await owner.get(`${P()}/contacts/suggestions`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  console.log(`      → ${r.data.suggestions.map((s) => `${s.name}(${s.transactionIds.length})`).join(", ")}`);
  const swiggy = r.data.suggestions.find((s) => s.name === "Swiggy");
  if (swiggy) {
    const a = await owner.post(`${P()}/contacts/suggestions/apply`, { items: [swiggy] });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal((await contactsOf()).find((c) => c.name === "Swiggy").transactions, 2);
  }
});

// ---- Statement import ------------------------------------------------------------
const rupee = (p) => (p / 100).toFixed(2);
function statement(lines, { last4 = "4821", openingRupees = 50_000, from = "2026-10-01", to = "2026-10-31" } = {}) {
  let bal = Math.round(openingRupees * 100);
  const out = lines.map(([date, description, amount]) => {
    const paise = Math.round(amount * 100);
    bal += paise;
    return { date, description, ...(paise < 0 ? { debit: rupee(-paise) } : { credit: rupee(paise) }), balance: rupee(bal) };
  });
  return {
    version: 1,
    account: { institution: "HDFC Bank", number: `XXXXXXXX${last4}`, ifsc: "HDFC0000123", holder: "Asha Rao", type: "bank" },
    period: { from, to },
    openingBalance: rupee(Math.round(openingRupees * 100)),
    closingBalance: rupee(bal),
    lines: out,
  };
}
let octStatement, octPlan, chai100, auto100, zomato999;

await step("statement setup: manual entries the bank will also report", async () => {
  const food = cats.food.id;
  const transport = cats.transport.id;
  const zomato = await owner.post(`${P()}/transactions`, { kind: "expense", date: "2026-10-27", amount: 99_900, accountId: acct.hdfc.id, categoryId: food, newContact: { name: "Zomato", kind: "business" }, note: "Dinner" });
  zomato999 = zomato.data.transaction.id;
  chai100 = (await owner.post(`${P()}/transactions`, { kind: "expense", date: "2026-10-29", amount: 10_000, accountId: acct.hdfc.id, categoryId: food, note: "Chai" })).data.transaction.id;
  auto100 = (await owner.post(`${P()}/transactions`, { kind: "expense", date: "2026-10-29", amount: 10_000, accountId: acct.hdfc.id, categoryId: transport, note: "Auto" })).data.transaction.id;
  octStatement = statement([
    ["2026-10-01", "NEFT CR-ACME0000001-ACME CORP-SALARY OCT", 80_000],
    ["2026-10-02", "ATM WDL/MG ROAD BLR", -5_000],
    ["2026-10-05", "UPI-SWIGGY-swiggy@icici-ICIC0000001-430212345678-UPI", -612],
    ["2026-10-09", "POS 4521XXXX AMAZON PAY INDIA", -1_299],
    ["2026-10-12", "UPI-FASTMERCH-fastmerch@ybl-YESB0000001-430299990000-UPI", -250],
    ["2026-10-13", "UPI REV-430299990000-FAILED TXN REVERSAL", 250],
    ["2026-10-15", "SMS CHARGES QTR SEP 26", -17.7],
    ["2026-10-21", "UPI-RAHUL SHARMA-rahul.s@okicici-SBIN0000001-430211110000-Goa", -2_000],
    ["2026-10-21", "UPI-BLINKIT-blinkit.payu@hdfcbank-HDFC0000240-430233334444-UPI", -640],
    ["2026-10-22", "UPI-RAHUL SHARMA-rahul.s@okicici-SBIN0000001-430211115555-repay", 500],
    ["2026-10-25", "UPI-PRIYA MENON-priya.m@okaxis-UTIB0000001-430277778888-concert", -3_000],
    ["2026-10-28", "UPI-ZOMATO-zomato@hdfcbank-HDFC0000240-430255556666-UPI", -1_001],
    ["2026-10-29", "UPI-RAPIDO-rapido@ybl-YESB0000001-430244445555-RIDE", -100],
  ]);
});

await step("import: unmapped statement errors out with the fix", async () => {
  const r = await owner.post(`${P()}/imports`, { statement: octStatement });
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "unmapped_account");
  assert.match(r.data.error.message, /••4821 matches none/);
});

await step("import: a misread digit breaks the running balance and names the line", async () => {
  await owner.patch(`${P()}/accounts/${acct.hdfc.id}`, { institution: "HDFC Bank", numberLast4: "4821", ifsc: "HDFC0000123" });
  const broken = structuredClone(octStatement);
  broken.lines[3].debit = "1,229.00"; // 1,299 misread
  const r = await owner.post(`${P()}/imports`, { statement: broken });
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "invalid_statement");
  assert.match(r.data.error.message, /Line 4/);
});

await step("import: two accounts can't share last 4 digits", async () => {
  const r = await owner.patch(`${P()}/accounts/${acct.cash.id}`, { numberLast4: "4821" });
  assert.equal(r.status, 409);
});

await step("import preview: matches, near miss, Jev tie-break, reversal, new lines", async () => {
  const r = await owner.post(`${P()}/imports`, { statement: octStatement });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  octPlan = r.data.plan;
  const by = (n) => octPlan.lines.find((l) => l.lineNo === n);
  console.log(`      counts=${JSON.stringify(octPlan.counts)}`);
  for (const l of octPlan.lines) console.log(`        ${String(l.lineNo).padStart(2)} ${l.action.padEnd(9)} ${l.match ?? ""} ${l.description.slice(0, 42)}${l.proposal ? ` → ${l.proposal.kind} ${octPlan.related?.[l.proposal.categoryId]?.name ?? ""}` : ""}${l.reason ? ` (${l.reason})` : ""}`);
  assert.equal(by(1).action, "link", "salary matches the recorded income");
  assert.equal(by(2).action, "link", "ATM matches the recorded transfer");
  assert.equal(by(5).action, "reversal");
  assert.equal(by(6).action, "reversal");
  assert.equal(by(8).action, "link", "gave Rahul");
  assert.equal(by(9).action, "link", "Blinkit a day later");
  assert.equal(by(10).action, "link", "got from Rahul");
  assert.equal(by(12).action, "pending", "₹1,001 vs ₹999 is a near miss, never auto-linked");
  assert.equal(by(3).action, "new");
  assert.ok(octPlan.notOnStatement.includes(chai100) || by(13).transactionId === chai100, "one ₹100 stays unmatched");
  if (by(13).action === "link") assert.equal(by(13).transactionId, auto100, "Rapido is the auto ride, not the chai");
  assert.ok(octPlan.warnings.length >= 1);
});

await step("import commit: new lines created as statement-origin; matches reconciled", async () => {
  const r = await owner.post(`${P()}/imports/${octPlan.id}/commit`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  console.log(`      ${JSON.stringify(r.data)}`);
  const salary = (await owner.get(`${P()}/transactions?from=2026-10-01&to=2026-10-01`)).data.transactions.find((t) => t.kind === "income");
  assert.equal(salary.origin, "manual");
  assert.equal(salary.reconciled, true);
  assert.deepEqual(salary.sources, ["statement"]);
  const swiggy = (await owner.get(`${P()}/transactions?from=2026-10-05&to=2026-10-05`)).data.transactions[0];
  assert.equal(swiggy.origin, "statement");
  assert.equal(swiggy.amount, 61_200);
  assert.equal((await owner.get(`${P()}/integrity`)).data.ok, true);
});

await step("import: the same statement again changes nothing", async () => {
  const r = await owner.post(`${P()}/imports`, { statement: octStatement });
  assert.equal(r.data.plan.counts.duplicate, octStatement.lines.length, JSON.stringify(r.data.plan.counts));
});

await step("import: UPI IDs learned from your own labels are lookups next time", async () => {
  const nov = statement([["2026-11-03", "UPI-RS-rahul.s@okicici-SBIN0000001-430200001111-dinner share", 300]], { from: "2026-11-01", to: "2026-11-30", openingRupees: 116_830.3 });
  const r = await owner.post(`${P()}/imports`, { statement: nov });
  const line = r.data.plan.lines[0];
  assert.equal(line.proposal?.contactId, rahul.id, JSON.stringify(line));
  assert.match(line.proposal.why ?? "", /known UPI ID/);
});

await step("review queue: near miss resolved by fixing the amount and linking", async () => {
  const q = await owner.get(`${P()}/review`);
  const item = q.data.lines.find((l) => l.amount === -100_100);
  assert.ok(item, JSON.stringify(q.data.lines));
  assert.equal(item.candidates[0].id, zomato999);
  const refused = await owner.post(`${P()}/evidence/${item.evidenceId}/link`, { transactionId: zomato999 });
  assert.equal(refused.status, 400, "amounts must agree");
  await owner.patch(`${P()}/transactions/${zomato999}`, { amount: 100_100 });
  assert.equal((await owner.post(`${P()}/evidence/${item.evidenceId}/link`, { transactionId: zomato999 })).status, 200);
  assert.equal((await owner.get(`${P()}/transactions/${zomato999}`)).data.transaction.reconciled, true);
});

await step("undo: the import's transactions go, matches unlink", async () => {
  assert.equal((await owner.post(`${P()}/imports/${octPlan.id}/undo`, {})).status, 200);
  const swiggy = (await owner.get(`${P()}/transactions?from=2026-10-05&to=2026-10-05`)).data.transactions;
  assert.equal(swiggy.length, 0);
  const salary = (await owner.get(`${P()}/transactions?from=2026-10-01&to=2026-10-01`)).data.transactions.find((t) => t.kind === "income");
  assert.equal(salary.reconciled, false);
  assert.equal((await owner.get(`${P()}/integrity`)).data.ok, true);
});

await step("agent tokens: writes say which agent added them", async () => {
  const t = await owner.post("/me/tokens", { name: "Kaira", agent: true });
  const agent = new Client("agent", t.data.token);
  const r = await agent.post(`${P()}/transactions`, { kind: "expense", amount: 5_000, accountId: acct.cash.id, categoryId: cats.food.id, origin: "sms", note: "From SMS" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.transaction.agentName, "Kaira");
  assert.equal(r.data.transaction.origin, "sms");
});

// ---- Setup features for agents ---------------------------------------------------
await step("device login: browser approval issues a token once, no password", async () => {
  const anon = new Client("device");
  const start = await anon.post("/auth/device", { name: "Claude", agent: true });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  assert.match(start.data.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal((await anon.post("/auth/device/poll", { deviceCode: start.data.deviceCode })).data.status, "pending");
  assert.equal((await stranger.get(`/auth/device/${start.data.userCode}`)).status, 401, "approving needs a signed-in person");
  const info = await owner.get(`/auth/device/${start.data.userCode}`);
  assert.equal(info.data.agent, true);
  assert.equal((await owner.post(`/auth/device/${start.data.userCode}`, { approve: true })).status, 200);
  const done = await anon.post("/auth/device/poll", { deviceCode: start.data.deviceCode });
  assert.equal(done.data.status, "approved");
  const agent = new Client("agent", done.data.token);
  assert.equal((await agent.get("/me")).status, 200);
  assert.equal((await anon.post("/auth/device/poll", { deviceCode: start.data.deviceCode })).status, 410, "a code works once");
  const denied = await anon.post("/auth/device", { name: "Other" });
  await owner.post(`/auth/device/${denied.data.userCode}`, { approve: false });
  assert.equal((await anon.post("/auth/device/poll", { deviceCode: denied.data.deviceCode })).data.status, "denied");
});

await step("contacts: opening 'owes you' balance never counts as income", async () => {
  const r = await owner.post(`${P()}/contacts`, { name: "Northwind Labs", kind: "business", openingBalance: 2_500_000, openingDate: "2026-03-31" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.contact.balance, 2_500_000);
  const s = await owner.get(`${P()}/summary?from=2026-03-01&to=2026-03-31`);
  assert.equal(s.data.income, 0);
  assert.equal((await owner.get(`${P()}/integrity`)).data.ok, true);
});

await step("accounts: joint account with a share, fixed deposit group", async () => {
  const j = await owner.post(`${P()}/accounts`, { type: "asset", subtype: "bank", name: "BoB Joint", jointWith: "Meera Rao", ownShare: 50, openingBalance: 1_000_000, institution: "Bank of Baroda", numberLast4: "8842" });
  assert.equal(j.status, 201, JSON.stringify(j.data));
  assert.equal(j.data.account.ownShare, 50);
  assert.equal(j.data.account.balance, 1_000_000, "the ledger keeps the full balance");
  const fd = await owner.post(`${P()}/accounts`, { type: "asset", subtype: "investment", groupLabel: "Fixed deposits", name: "SBI FD" });
  assert.equal(fd.data.account.groupLabel, "Fixed deposits");
  assert.equal((await owner.post(`${P()}/accounts`, { type: "asset", subtype: "bank", name: "X", ownShare: 120 })).status, 400);
});

await step("cards: credit limit is capacity, never net worth", async () => {
  const before = (await accountsOf(owner, personal)).filter((a) => a.type === "asset").reduce((s, a) => s + a.balance, 0);
  const r = await owner.patch(`${P()}/accounts/${acct.card.id}`, { creditLimit: 30_000_000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.account.creditLimit, 30_000_000);
  const after = (await accountsOf(owner, personal)).filter((a) => a.type === "asset").reduce((s, a) => s + a.balance, 0);
  assert.equal(after, before);
  const bank = await owner.patch(`${P()}/accounts/${acct.cash.id}`, { creditLimit: 100 });
  assert.equal(bank.data.account.creditLimit, null, "only liabilities carry a limit");
});

await step("transfers in transit: a card payment parks, the card statement claims it (either order)", async () => {
  const card = await owner.post(`${P()}/accounts`, { type: "liability", subtype: "card", name: "Transit Card", institution: "Test Bank", numberLast4: "5555" });
  const card2 = await owner.post(`${P()}/accounts`, { type: "liability", subtype: "card", name: "Other Card", institution: "Test Bank", numberLast4: "6666" });
  assert.equal(card.status, 201);
  const bank = (lines, opening, from, to) => statement(lines, { last4: "4821", openingRupees: opening, from, to });
  const cardSt = (last4, lines, from, to) => ({
    version: 1, account: { institution: "Test Bank", number: `XXXX${last4}`, type: "card" }, period: { from, to },
    openingBalance: "0.00", closingBalance: (lines.reduce((s, [, , a]) => s - a, 0)).toFixed(2),
    lines: lines.map(([date, description, amount]) => ({ date, description, ...(amount < 0 ? { debit: (-amount).toFixed(2) } : { credit: amount.toFixed(2) }) })),
  });
  const imp = async (st) => { const r = await owner.post(`${P()}/imports`, { statement: st }); assert.equal(r.status, 201, JSON.stringify(r.data)); await owner.post(`${P()}/imports/${r.data.plan.id}/commit`, {}); return r.data.plan; };
  const cur = (await accountsOf(owner, personal)).find((a) => a.name === "HDFC Savings").balance / 100;
  // Bank first: payment parks in transit (the narration doesn't say which card).
  await imp(bank([["2026-12-02", "CRED CLUB CC BILL PAYMENT BILLDESK", -500]], cur, "2026-12-01", "2026-12-31"));
  let transit = (await accountsOf(owner, personal)).find((a) => a.name === "Transfers in transit");
  assert.equal(transit?.balance, 50_000, "₹500 waiting in transit");
  // Card second: its payment line claims the parked transfer.
  const cp = await imp(cardSt("5555", [["2026-12-03", "PAYMENT RECEIVED THANK YOU", 500]], "2026-12-01", "2026-12-31"));
  assert.equal(cp.lines[0].match, "transit", JSON.stringify(cp.lines[0]));
  transit = (await accountsOf(owner, personal)).find((a) => a.name === "Transfers in transit");
  assert.equal(transit.balance, 0, "claimed");
  assert.equal((await accountsOf(owner, personal)).find((a) => a.name === "Transit Card").balance, 50_000, "the card shows the payment once");
  // Card first, bank second.
  await imp(cardSt("6666", [["2027-01-05", "PAYMENT RECEIVED BBPS", 300]], "2027-01-01", "2027-01-31"));
  const cur2 = (await accountsOf(owner, personal)).find((a) => a.name === "HDFC Savings").balance / 100;
  const bp = await imp(bank([["2027-01-04", "CRED CLUB CC BILL PAYMENT BILLDESK", -300]], cur2, "2027-01-01", "2027-01-31"));
  assert.equal(bp.lines[0].match, "transit", JSON.stringify(bp.lines[0]));
  assert.equal((await accountsOf(owner, personal)).find((a) => a.name === "Transfers in transit").balance, 0);
  assert.equal((await owner.get(`${P()}/integrity`)).data.ok, true);
});

await step("EMIs: a monthly-billed plan folds into its card; an SBI-style plan is worked out from the schedule", async () => {
  const card = (await owner.post(`${P()}/accounts`, { type: "liability", subtype: "card", name: "EMI Card", creditLimit: 5_000_000 })).data.account;
  // Monthly-billed: a hidden sub-account of the card holds what isn't billed yet.
  const r = await owner.post(`${P()}/emis`, { title: "Refurbished laptop", accountId: card.id, merchant: "Refurb Store", principal: 1_200_000, instalment: 410_000, months: 3, firstDue: "2027-02-16", balance: "separate" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const plan = r.data.plan;
  const sub = (await accountsOf(owner, personal)).find((a) => a.id === plan.balanceAccountId);
  assert.equal(sub.parentId, card.id, "sub-account hangs off the card");
  // Purchase on the card, credited back on conversion, then one instalment's principal billed.
  await owner.post(`${P()}/transactions`, { kind: "expense", date: "2027-01-10", amount: 1_200_000, accountId: card.id, categoryId: (await accountsOf(owner, personal)).find((a) => a.type === "expense").id });
  await owner.post(`${P()}/transactions`, { kind: "transfer", date: "2027-01-12", amount: 1_200_000, accountId: plan.balanceAccountId, toAccountId: card.id, note: "Purchase to EMI credit" });
  await owner.post(`${P()}/transactions`, { kind: "transfer", date: "2027-02-16", amount: 400_000, accountId: card.id, toAccountId: plan.balanceAccountId, note: "EMI principal 1/3" });
  const accts = await accountsOf(owner, personal);
  assert.equal(accts.find((a) => a.id === card.id).balance, -400_000, "the card shows only the billed instalment");
  assert.equal(accts.find((a) => a.id === plan.balanceAccountId).balance, -800_000, "the rest sits in the plan");
  const listed = (await owner.get(`${P()}/emis?asOf=2027-02-20`)).data.plans.find((p) => p.id === plan.id);
  assert.equal(listed.left, 800_000, "principal left comes from the ledger");
  assert.equal(listed.paid, 1);
  assert.equal(listed.monthsLeft, 2);
  assert.equal(listed.toPay, 820_000);
  assert.equal(listed.lastMonth, "2027-04");
  // SBI-style: inside the card balance; left from the schedule (₹12,000 at ₹1,080 × 12, after 3 paid).
  const sbi = await owner.post(`${P()}/emis`, { title: "Headphones", accountId: card.id, principal: 1_200_000, instalment: 108_000, months: 12, firstDue: "2026-08-01", balance: "in-account" });
  assert.equal(sbi.status, 201, JSON.stringify(sbi.data));
  assert.equal(sbi.data.plan.balanceAccountId, null);
  const est = (await owner.get(`${P()}/emis?asOf=2026-10-30`)).data.plans.find((p) => p.id === sbi.data.plan.id);
  assert.equal(est.paid, 3);
  assert.ok(Math.abs(est.left - 915_963) <= 2, `schedule estimate ${est.left}`);
  assert.equal(est.leftEstimated, true);
  // Rename keeps the hidden account in step; closing marks it done.
  const ed = await owner.patch(`${P()}/emis/${plan.id}`, { title: "Laptop (refurb)" });
  assert.equal(ed.data.plan.title, "Laptop (refurb)");
  assert.equal((await accountsOf(owner, personal)).find((a) => a.id === plan.balanceAccountId).name, "EMI · Laptop (refurb)");
  assert.equal((await owner.patch(`${P()}/emis/${sbi.data.plan.id}`, { closed: true })).data.plan.done, true);
  const bad = await owner.post(`${P()}/emis`, { title: "x", accountId: card.id, instalment: 100, balance: "in-account" });
  assert.equal(bad.status, 400, "in-card plans need a schedule");
  assert.equal((await owner.get(`${P()}/integrity`)).data.ok, true);
});

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
