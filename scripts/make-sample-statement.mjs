// Writes samples/hdfc-statement.json: what an agent would produce from a real
// HDFC PDF, built from the demo ledger so it exercises every import path —
// matches (some posted a day late), a near miss, one entry the bank never saw,
// brand-new lines, and a failed UPI with its reversal.
//   npm run seed:demo && node scripts/make-sample-statement.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5180";
let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(BASE + "/api" + path, { ...init, headers: { origin: BASE, "content-type": "application/json", cookie } });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("fin_session=")) cookie = c.split(";")[0];
  return res.json();
}
await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "demo@example.com", password: "demo-password-123" }) });
const me = await api("/me");
const e = me.entities.find((x) => x.kind === "personal");
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const day = (offset) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
const from = day(30);
const to = day(0);
const before = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 31);

const { accounts } = await api(`/entities/${e.id}/accounts?asOf=${iso(before)}`);
const { contacts } = await api(`/entities/${e.id}/contacts`);
const hdfc = accounts.find((a) => a.name === "HDFC Savings");
const all = (await api(`/entities/${e.id}/accounts`)).accounts;
const name = (id) => all.find((a) => a.id === id)?.name ?? contacts.find((c) => c.id === id)?.name ?? "";
const { rows } = await api(`/entities/${e.id}/accounts/${hdfc.id}/ledger?limit=500`);

let ref = 430210000000;
const utr = () => String(ref++);
const vpa = (n) => `${n.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12) || "merchant"}@ybl`;
function narration(t) {
  const who = t.contactId ? name(t.contactId) : null;
  if (t.kind === "income" && /salary/i.test(t.note ?? "")) return `NEFT CR-ICIC0000001-${(who ?? "EMPLOYER").toUpperCase()} PVT LTD-SALARY`;
  if (t.kind === "income" && /interest/i.test(t.note ?? "")) return "INT.PD:01-07-2026 TO 30-09-2026";
  if (t.kind === "transfer") {
    const other = name(t.toAccountId === hdfc.id ? t.accountId : t.toAccountId);
    if (other === "Cash") return "ATM WDL/INDIRANAGAR BLR";
    if (other === "Credit card") return "CC PAYMENT XX9011 BILLDESK";
    if (other === "Zerodha") return "ACH D- ZERODHA BROKING-SIP";
    if (other === "Car loan") return "NACH DR-HDFC AUTO LOAN EMI";
    return `IMPS-${other.toUpperCase()}`;
  }
  if (t.kind === "gave" || t.kind === "got") return `UPI-${(who ?? "FRIEND").toUpperCase()} SHARMA-rahul.s@okicici-SBIN0000001-${utr()}-${t.kind === "gave" ? "Goa" : "payback"}`;
  const label = who ?? t.note ?? "PAYMENT";
  return `UPI-${label.toUpperCase()}-${vpa(label)}-YESB0000001-${utr()}-UPI`;
}

const lines = [];
let skipped = null;
for (const t of rows.filter((r) => r.date >= from && r.date <= to && r.kind !== "opening" && r.kind !== "adjustment").reverse()) {
  if (!skipped && /medicines/i.test(t.note ?? "")) {
    skipped = t; // recorded by hand, never reached the bank: shows up as "not on statement"
    continue;
  }
  let amount = t.delta;
  if (name(t.contactId) === "Zomato") amount -= 200; // ₹2 platform fee: a near miss for review
  const late = lines.length % 3 === 1 && t.date < to ? 1 : 0; // banks often post a day later
  const d = new Date(`${t.date}T00:00:00`);
  d.setDate(d.getDate() + late);
  lines.push({ date: iso(d), description: narration(t), amount });
}
const extra = [
  [day(19), "UPI-SWIGGY-swiggy@icici-ICIC0000001-430299911111-UPI", -34_900],
  [day(16), "POS 4521XXXX AMAZON PAY INDIA", -129_900],
  [day(15), "UPI-FASTMERCH-fastmerch@ybl-YESB0000001-430299922222-UPI", -25_000],
  [day(14), "UPI REV-430299922222-FAILED TXN REVERSAL", 25_000],
  [day(10), "SMS CHARGES QTR SEP 26", -1_770],
  [day(3), "NEFT CR-SBIN0000001-RAHUL SHARMA-GOA SETTLE", 100_000],
];
for (const [date, description, amount] of extra) lines.push({ date, description, amount });
lines.sort((a, b) => a.date.localeCompare(b.date));

const rupee = (p) => (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let bal = hdfc.balance;
const out = lines.map((l) => {
  bal += l.amount;
  return { date: l.date, description: l.description, ...(l.amount < 0 ? { debit: rupee(-l.amount) } : { credit: rupee(l.amount) }), balance: rupee(bal) };
});
const statement = {
  version: 1,
  account: { institution: "HDFC Bank", number: "XXXXXXXXXX4821", ifsc: "HDFC0000123", holder: "ASHA RAO", type: "bank" },
  currency: "INR",
  period: { from, to },
  openingBalance: rupee(hdfc.balance),
  closingBalance: rupee(bal),
  lines: out,
};
mkdirSync("samples", { recursive: true });
writeFileSync("samples/hdfc-statement.json", JSON.stringify(statement, null, 2) + "\n");
console.log(`samples/hdfc-statement.json: ${out.length} lines, ${from} → ${to}${skipped ? ` (left out "${skipped.note}" on purpose)` : ""}`);
