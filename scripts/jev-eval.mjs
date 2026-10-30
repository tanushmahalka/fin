// Calibration set for smart add / ask. Run after scripts/e2e.mjs against the same dev DB:
//   node scripts/jev-eval.mjs
// Prints each field as ✓ (right), · (left empty: the person picks) or ✗ (wrong).
// Empty is acceptable; wrong is what the thresholds in worker/jev.ts must keep rare.

const BASE = process.env.BASE ?? "http://localhost:5180";
let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(BASE + "/api" + path, {
    ...init,
    headers: { origin: BASE, "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("fin_session=")) cookie = c.split(";")[0];
  return res.json();
}
await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "correct-horse-battery" }) });
const me = await api("/me");
const ent = Object.fromEntries(me.entities.map((e) => [e.kind, e]));
const names = {};
for (const e of me.entities) {
  const { accounts } = await api(`/entities/${e.id}/accounts`);
  const { contacts } = await api(`/entities/${e.id}/contacts`);
  names[e.id] = Object.fromEntries([...accounts, ...contacts].map((a) => [a.id, a.name]));
}

const T = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const yday = iso(new Date(T.getFullYear(), T.getMonth(), T.getDate() - 1));

// [text, kind, amount (rupees), category, account (null = not named), extra]
const RECORD = [
  ["personal", "chai 40", "expense", 40, "Food & dining", null],
  ["personal", "uber to airport 640 card", "expense", 640, "Transport", "Credit card"],
  ["personal", "swiggy 450 last night", "expense", 450, "Food & dining", null, { date: yday }],
  ["personal", "blinkit 1,230 gpay", "expense", 1230, "Groceries", "Bank account"],
  ["personal", "electricity bill 2340", "expense", 2340, "Bills & utilities", null],
  ["personal", "netflix 649", "expense", 649, "Subscriptions", null],
  ["personal", "rent 25k to landlord", "expense", 25000, "Rent", null],
  ["personal", "withdrew 5000 from atm", "transfer", 5000, null, "Bank account", { to: "Cash" }],
  ["personal", "paid credit card bill 12000 from hdfc", "transfer", 12000, null, "HDFC Savings", { to: "Credit card" }],
  ["personal", "interest credited 312.50", "income", 312.5, "Interest", null],
  ["personal", "refund from amazon 899", "income", 899, "Refunds", null],
  ["personal", "2 coffees 360", "expense", 360, "Food & dining", null],
  ["personal", "gym membership 1500 on 3/10", "expense", 1500, "Health", null],
  ["personal", "haircut 300 cash", "expense", 300, "Personal care", "Cash"],
  ["personal", "flight to goa 6400 on card", "expense", 6400, "Travel", "Credit card"],
  ["personal", "dinner with friends 1800", "expense", 1800, "Food & dining", null],
  ["personal", "mom sent 5000", "income", 5000, "Gifts received", null],
  ["personal", "zepto 640", "expense", 640, "Groceries", null],
  ["personal", "metro recharge 500", "expense", 500, "Transport", null],
  ["personal", "medicines 230 at apollo", "expense", 230, "Health", null],
  ["business", "meta ads 25000", "expense", 25000, "Ad spend", null],
  ["business", "aws 3,450 company card", "expense", 3450, "Software & SaaS", "Company card"],
  ["business", "paid CA 15000 for gst filing", "expense", 15000, "Professional fees", null],
  ["business", "team lunch 2400", "expense", 2400, "Meals", null, { personal: false }],
  ["business", "client paid 1.2L invoice", "income", 120000, "Services", null],
  ["business", "groceries for home 1800", "expense", 1800, null, null, { personal: true }],
  ["business", "netflix 649", "expense", 649, "Software & SaaS", null, { personal: true }],
  ["business", "freelance designer 20000", "expense", 20000, "Contractors", null],
  // Contacts and who owes whom (contacts Blinkit, Rahul, Priya exist after scripts/e2e.mjs)
  ["personal", "blinkit 230", "expense", 230, "Groceries", null, { contact: "Blinkit" }],
  ["personal", "lent rahul 2000", "gave", 2000, null, null, { contact: "Rahul" }],
  ["personal", "rahul returned 500", "got", 500, null, null, { contact: "Rahul" }],
  ["personal", "paid priya back 650", "gave", 650, null, null, { contact: "Priya" }],
  ["personal", "gift for mom 2000", "expense", 2000, "Gifts & donations", null],
  ["personal", "dinner at toit 3200", "expense", 3200, "Food & dining", null, { newContact: "Toit" }],
  ["business", "borrowed 2 lakh from director", "got", 200000, null, null],
];

const ASK = [
  ["personal", "who owes me?", "owed", null],
  ["personal", "how much does rahul owe me", "owed", null],
  ["personal", "spent at blinkit this month", "spending", null],
  ["personal", "how much did I spend on food last month", "spending", "Food & dining"],
  ["personal", "what's my cash balance", "balance", null],
  ["personal", "net worth?", "balance", null],
  ["personal", "show transport this month", "transactions", "Transport"],
  ["personal", "how much salary did I get in october", "income", "Salary"],
  ["personal", "am I within my food budget", "budget", "Food & dining"],
];

const mark = (expected, actual) => (actual === null || actual === undefined ? "·" : actual === expected ? "✓" : "✗");
let wrong = 0, empty = 0, right = 0, ms = 0, tokens = 0;
const tally = (m) => (m === "✓" ? right++ : m === "·" ? empty++ : wrong++);

console.log("RECORD  kind amt cat acct  text → note");
for (const [kind, text, expKind, rupees, cat, acct, extra = {}] of RECORD) {
  const e = ent[kind];
  const r = await api(`/entities/${e.id}/assist?mode=auto&text=${encodeURIComponent(text)}`);
  ms += r.ms;
  tokens += r.usage?.inputTokens ?? 0;
  const p = r.parse;
  if (!p) {
    console.log(`  ✗ routed to ask: ${text}`);
    wrong++;
    continue;
  }
  const n = names[e.id];
  const d = p.draft;
  const marks = [
    mark(expKind, d.kind),
    mark(Math.round(rupees * 100), d.amount),
    cat ? mark(cat, n[d.categoryId]) : d.kind === "transfer" || d.kind === "gave" || d.kind === "got" ? "-" : d.categoryId ? "?" : "·",
    acct ? mark(acct, n[d.accountId]) : d.accountId && !extra.contact ? "✗" : "·",
  ];
  if (extra.to) marks.push(`to:${mark(extra.to, n[d.toAccountId])}`);
  if (extra.date) marks.push(`date:${mark(extra.date, d.date)}`);
  if (extra.personal !== undefined) marks.push(`guard:${p.warnings.length > 0 === extra.personal ? "✓" : "✗"}`);
  if (extra.contact) marks.push(`who:${mark(extra.contact, n[d.contactId])}`);
  if (extra.newContact) marks.push(`new:${mark(extra.newContact, d.newContact?.name)}`);
  marks.filter((m) => m.length === 1 || m.includes(":")).forEach((m) => tally(m.slice(-1)));
  const sugg = !d.categoryId && p.suggestions.categoryIds.length ? ` [suggest: ${p.suggestions.categoryIds.map((id) => n[id]).join(", ")}]` : "";
  const got = d.categoryId && cat && n[d.categoryId] !== cat ? ` (got ${n[d.categoryId]} @${p.confidence.category.toFixed(2)})` : "";
  console.log(`  ${marks.join("  ")}  ${text} → ${JSON.stringify(d.note)}${got}${sugg}`);
}

console.log("\nASK  intent target  text → answer");
for (const [kind, text, intent, cat] of ASK) {
  const e = ent[kind];
  const r = await api(`/entities/${e.id}/assist?mode=auto&text=${encodeURIComponent(text)}`);
  ms += r.ms;
  const a = r.ask;
  if (!a) {
    console.log(`  ✗ routed to record: ${text}`);
    wrong++;
    continue;
  }
  const n = names[e.id];
  const m1 = mark(intent, a.intent);
  const m2 = cat ? mark(cat, n[a.categoryId]) : "-";
  tally(m1);
  if (m2 !== "-") tally(m2);
  console.log(`  ${m1}  ${m2}  ${text} → ${a.answer}`);
}

const calls = RECORD.length + ASK.length;
console.log(`\n${right} right · ${empty} left for the person · ${wrong} wrong   avg ${Math.round(ms / calls)}ms   avg ${Math.round(tokens / RECORD.length)} input tokens/record`);
