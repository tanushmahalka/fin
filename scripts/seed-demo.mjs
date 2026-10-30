// Fills a FRESH local instance with two months of realistic demo data.
//   npm run db:reset && npm run dev   (in another terminal)
//   node scripts/seed-demo.mjs
// Sign in as demo@example.com / demo-password-123

const BASE = process.env.BASE ?? "http://localhost:5180";
let cookie = "";
async function api(method, path, body) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { origin: BASE, "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("fin_session=")) cookie = c.split(";")[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const day = (offset) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const rupees = (n) => Math.round(n * 100);

await api("POST", "/auth/setup", { name: "Asha Rao", email: "demo@example.com", password: "demo-password-123" });
const { entity: me } = await api("POST", "/entities", { name: "Asha Rao", kind: "personal", color: "#5b5bd6" });
const { entity: co } = await api("POST", "/entities", { name: "Acme Studio", kind: "business", color: "#0d9488" });

async function chart(entity) {
  const { accounts } = await api("GET", `/entities/${entity.id}/accounts`);
  return Object.fromEntries(accounts.map((a) => [a.name, a.id]));
}

// Personal
await api("POST", `/entities/${me.id}/accounts`, { type: "asset", subtype: "bank", name: "HDFC Savings", icon: "🏦", openingBalance: rupees(184_250), openingDate: day(62) });
await api("POST", `/entities/${me.id}/accounts`, { type: "asset", subtype: "investment", name: "Zerodha", icon: "📈", openingBalance: rupees(420_000), openingDate: day(62) });
let A = await chart(me);
await api("PATCH", `/entities/${me.id}/accounts/${A["Bank account"]}`, { archived: true });
await api("POST", `/entities/${me.id}/accounts/${A["Cash"]}/adjust`, { balance: rupees(6_500), date: day(62) });
await api("PATCH", `/entities/${me.id}`, { defaultAccountId: A["HDFC Savings"] });
// Statement details: how imported statements find these accounts.
await api("PATCH", `/entities/${me.id}/accounts/${A["HDFC Savings"]}`, { institution: "HDFC Bank", numberLast4: "4821", ifsc: "HDFC0000123" });
await api("PATCH", `/entities/${me.id}/accounts/${A["Credit card"]}`, { institution: "HDFC Bank", numberLast4: "9011" });
A = await chart(me);

// Contacts are created on first use ("newContact"), then reused by id.
const contactIds = {};
async function withContact(entity, name, kind = "business") {
  if (!name) return {};
  if (contactIds[`${entity.id}:${name}`]) return { contactId: contactIds[`${entity.id}:${name}`] };
  const { contact } = await api("POST", `/entities/${entity.id}/contacts`, { name, kind });
  contactIds[`${entity.id}:${name}`] = contact.id;
  return { contactId: contact.id };
}

const personal = [
  [0, "expense", 40, "Food & dining", "Cash", "Chai"],
  [0, "expense", 389, "Transport", "HDFC Savings", "To office", "Uber"],
  [1, "expense", 612, "Food & dining", "Credit card", "Dinner", "Swiggy"],
  [1, "expense", 1_240, "Groceries", "HDFC Savings", null, "Blinkit"],
  [2, "expense", 649, "Subscriptions", "Credit card", null, "Netflix"],
  [3, "expense", 2_340, "Bills & utilities", "HDFC Savings", "Electricity", "BESCOM"],
  [3, "expense", 120, "Food & dining", "Cash", "Coffee"],
  [4, "expense", 4_999, "Shopping", "Credit card", "Running shoes", "Amazon"],
  [5, "expense", 280, "Transport", "Cash", "Auto"],
  [7, "expense", 799, "Health", "HDFC Savings", "Medicines", "Apollo Pharmacy"],
  [8, "expense", 35_000, "Rent", "HDFC Savings", "October rent", "Mr. Iyer"],
  [9, "income", 2_15_000, "Salary", "HDFC Savings", "October salary", "Acme Studio"],
  [10, "expense", 459, "Food & dining", "HDFC Savings", null, "Zomato"],
  [11, "expense", 1_499, "Personal care", "Credit card", "Haircut"],
  [12, "expense", 6_400, "Travel", "Credit card", "Flight to Goa", "IndiGo"],
  [14, "expense", 2_100, "Groceries", "HDFC Savings", "Weekly groceries", "Blinkit"],
  [15, "income", 1_312, "Interest", "HDFC Savings", "Savings interest", "HDFC Bank"],
  [17, "expense", 999, "Education", "Credit card", "Course"],
  [19, "expense", 2_500, "Gifts & donations", "HDFC Savings", "Birthday gift"],
  [22, "expense", 520, "Transport", "HDFC Savings", "Metro recharge"],
  [25, "expense", 1_640, "Groceries", "HDFC Savings", null, "Zepto"],
  [28, "expense", 35_000, "Rent", "HDFC Savings", "September rent", "Mr. Iyer"],
  [30, "income", 2_15_000, "Salary", "HDFC Savings", "September salary", "Acme Studio"],
  [33, "expense", 3_200, "Shopping", "Credit card", null, "Amazon"],
  [36, "expense", 860, "Food & dining", "Cash", "Lunch"],
  [40, "expense", 2_280, "Bills & utilities", "HDFC Savings", "Electricity", "BESCOM"],
  [44, "expense", 1_420, "Groceries", "HDFC Savings", null, "BigBasket"],
];
for (const [d, kind, amt, cat, acct, note, who] of personal) {
  await api("POST", `/entities/${me.id}/transactions`, { kind, date: day(d), amount: rupees(amt), accountId: A[acct], categoryId: A[cat], note, ...(await withContact(me, who)) });
}
await api("POST", `/entities/${me.id}/transactions`, { kind: "transfer", date: day(2), amount: rupees(3_000), accountId: A["HDFC Savings"], toAccountId: A["Cash"], note: "ATM" });
await api("POST", `/entities/${me.id}/transactions`, { kind: "transfer", date: day(9), amount: rupees(25_000), accountId: A["HDFC Savings"], toAccountId: A["Zerodha"], note: "SIP" });
await api("POST", `/entities/${me.id}/transactions`, { kind: "transfer", date: day(11), amount: rupees(18_420), accountId: A["HDFC Savings"], toAccountId: A["Credit card"], note: "Card bill" });
for (const [cat, amt] of [["Food & dining", 6_000], ["Groceries", 8_000], ["Transport", 3_000], ["Shopping", 5_000], ["Entertainment", 3_000]]) {
  await api("PUT", `/entities/${me.id}/budgets/${A[cat]}`, { amount: rupees(amt) });
}

// Loans and who owes whom.
await api("POST", `/entities/${me.id}/accounts`, { type: "liability", subtype: "loan", name: "Car loan", icon: "🚗", openingBalance: rupees(3_20_000), openingDate: day(62) });
A = await chart(me);
await api("POST", `/entities/${me.id}/transactions`, { kind: "transfer", date: day(5), amount: rupees(9_800), accountId: A["HDFC Savings"], toAccountId: A["Car loan"], note: "EMI" });
const rahul = (await withContact(me, "Rahul", "person")).contactId;
const priya = (await withContact(me, "Priya", "person")).contactId;
await api("POST", `/entities/${me.id}/transactions`, { kind: "gave", date: day(13), amount: rupees(5_000), accountId: A["HDFC Savings"], contactId: rahul, note: "Goa trip advance" });
await api("POST", `/entities/${me.id}/transactions`, { kind: "got", date: day(4), amount: rupees(2_000), accountId: A["HDFC Savings"], contactId: rahul, note: "Part payback" });
await api("POST", `/entities/${me.id}/transactions`, { kind: "expense", date: day(6), amount: rupees(1_500), accountId: A["Credit card"], categoryId: A["Food & dining"], share: { contactId: rahul, amount: rupees(1_500) }, note: "Dinner at Toit" });
await api("POST", `/entities/${me.id}/transactions`, { kind: "expense", date: day(6), amount: rupees(650), categoryId: A["Entertainment"], paidBy: priya, note: "Movie tickets" });

// Company
const B = await chart(co);
await api("POST", `/entities/${co.id}/accounts/${B["Current account"]}/adjust`, { balance: rupees(12_40_000), date: day(62) });
const company = [
  [0, "expense", 25_000, "Ad spend", "Company card", "Diwali campaign", "Meta"],
  [1, "expense", 3_450, "Software & SaaS", "Company card", null, "AWS"],
  [2, "income", 1_20_000, "Services", "Current account", "Retainer, Oct", "Acme Retail"],
  [3, "expense", 2_400, "Meals", "Company card", "Team lunch"],
  [5, "expense", 15_000, "Professional fees", "Current account", "GST filing", "Shah & Co (CA)"],
  [6, "expense", 20_000, "Contractors", "Current account", "Designer", "Neha Kapoor"],
  [8, "expense", 1_80_000, "Salaries", "Current account", "October payroll"],
  [9, "expense", 1_999, "Software & SaaS", "Company card", null, "Figma"],
  [12, "income", 85_000, "Sales", "Current account", "Self-serve subscriptions", "Razorpay"],
  [15, "expense", 18_000, "Ad spend", "Company card", null, "Google"],
  [20, "expense", 450, "Bank charges", "Current account", "Gateway fees", "Razorpay"],
  [30, "income", 1_20_000, "Services", "Current account", "Retainer, Sep", "Acme Retail"],
  [38, "expense", 1_80_000, "Salaries", "Current account", "September payroll"],
];
for (const [d, kind, amt, cat, acct, note, who] of company) {
  await api("POST", `/entities/${co.id}/transactions`, { kind, date: day(d), amount: rupees(amt), accountId: B[acct], categoryId: B[cat], note, ...(await withContact(co, who)) });
}
const director = (await withContact(co, "Asha Rao (director)", "person")).contactId;
await api("POST", `/entities/${co.id}/transactions`, { kind: "got", date: day(21), amount: rupees(2_00_000), accountId: B["Current account"], contactId: director, note: "Director's loan" });
await api("PUT", `/entities/${co.id}/budgets/${B["Ad spend"]}`, { amount: rupees(60_000) });
await api("PUT", `/entities/${co.id}/budgets/${B["Software & SaaS"]}`, { amount: rupees(10_000) });

// The CA joins the company only.
const { url } = await api("POST", `/entities/${co.id}/invites`, { email: "ca@example.com", role: "viewer" });
const owner = cookie;
cookie = "";
await api("POST", `/invites/${url.split("/invite/")[1]}/accept`, { name: "Priya Shah (CA)", password: "demo-password-123" });
cookie = owner;
await api("POST", `/entities/${co.id}/invites`, { email: "ops@example.com", role: "editor" });

console.log(`Try an import: node scripts/make-sample-statement.mjs && node cli/dist/fin.mjs import samples/hdfc-statement.json`);
console.log(`Seeded. Sign in at ${BASE} as demo@example.com / demo-password-123 (CA: ca@example.com)`);
