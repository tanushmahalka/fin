import { uuidv7 } from "../shared/ids";
import type { AccountSubtype, AccountType, EntityKind } from "../shared/types";
import { now, sql } from "./http";

type Seed = [type: AccountType, name: string, icon: string, hint: string, subtype?: AccountSubtype];

// Hints are what smart add reads to tell categories apart, so they name the
// things people actually type (brands, merchants, Indian context).
// Investments are deliberately not an expense: buying a mutual fund moves money
// between two assets (a transfer), so it must not inflate monthly spending.
const PERSONAL: Seed[] = [
  ["asset", "Cash", "💵", "Physical cash, notes and coins", "cash"],
  ["asset", "Bank account", "🏦", "Savings account: UPI (GPay, PhonePe, Paytm), debit card, NEFT, IMPS", "bank"],
  ["liability", "Credit card", "💳", "Purchases charged to the credit card", "card"],
  ["expense", "Food & dining", "🍜", "Food eaten out or ordered in: restaurants, cafes, chai, coffee, snacks, takeaway, Swiggy, Zomato"],
  ["expense", "Groceries", "🛒", "Household supplies bought to cook and keep at home: kirana, supermarket, vegetables, fruit, milk, staples, Blinkit, Zepto, BigBasket, Instamart"],
  ["expense", "Transport", "🚕", "Uber, Ola, Rapido, autos, metro, bus, fuel, parking, tolls"],
  ["expense", "Shopping", "🛍️", "Clothes, shoes, electronics, gadgets, Amazon, Flipkart, Myntra"],
  ["expense", "Bills & utilities", "💡", "Electricity, water, gas cylinder, mobile recharge, broadband, DTH"],
  ["expense", "Rent", "🏠", "House rent and society maintenance"],
  ["expense", "Health", "💊", "Doctor, medicines, pharmacy, tests, hospital, gym"],
  ["expense", "Entertainment", "🎬", "Movies, concerts, events, games, outings, parties"],
  ["expense", "Travel", "✈️", "Flights, trains, hotels, holidays and trips"],
  ["expense", "Subscriptions", "🔁", "Netflix, Spotify, YouTube Premium, iCloud, apps and memberships billed every month or year"],
  ["expense", "Education", "📚", "Courses, books, tuition and exam fees"],
  ["expense", "Gifts & donations", "🎁", "Presents for others, charity and donations"],
  ["expense", "Personal care", "💇", "Salon, haircut, grooming, skincare, cosmetics"],
  ["expense", "Taxes", "🧾", "Income tax, advance tax, property tax"],
  ["expense", "Bank & card charges", "🏦", "Bank fees, card interest, late fees, GST/IGST on charges, forex markup"],
  ["expense", "Other", "•", "Spending that fits no other category"],
  ["income", "Salary", "💼", "Pay from an employer"],
  ["income", "Business income", "🏢", "Payments from clients, freelance work or one's own business"],
  ["income", "Interest", "🏦", "Interest from savings accounts and fixed deposits"],
  ["income", "Dividends", "📈", "Dividends from shares or mutual funds"],
  ["income", "Refunds", "↩️", "Money returned for a purchase, cancellation or overcharge"],
  ["income", "Gifts received", "🎁", "Money given by family or friends"],
  ["income", "Other income", "•", "Income that fits no other category"],
];

const BUSINESS: Seed[] = [
  ["asset", "Current account", "🏦", "The company's bank account: NEFT, RTGS, UPI, debit card", "bank"],
  ["asset", "Petty cash", "💵", "Cash kept at the office", "cash"],
  ["liability", "Company card", "💳", "Purchases charged to the company credit card", "card"],
  ["expense", "Salaries", "👥", "Employee salaries, payroll and bonuses"],
  ["expense", "Contractors", "🧑‍💻", "Freelancers and contractors paid for work"],
  ["expense", "Ad spend", "📣", "Meta, Google, LinkedIn and other paid ads"],
  ["expense", "Software & SaaS", "💻", "Software subscriptions, cloud hosting, domains, AI APIs"],
  ["expense", "Rent & office", "🏢", "Office rent, coworking and maintenance"],
  ["expense", "Travel", "✈️", "Work travel: flights, trains, hotels, cabs for business"],
  ["expense", "Meals", "🍽️", "Team meals and client meals"],
  ["expense", "Professional fees", "⚖️", "CA, lawyer, consultants, ROC and compliance filings"],
  ["expense", "Bank charges", "🏦", "Bank fees and payment gateway charges"],
  ["expense", "Taxes & duties", "🧾", "GST, TDS and other statutory dues paid"],
  ["expense", "Office supplies", "📦", "Stationery, equipment and furniture"],
  ["expense", "Marketing", "🎯", "Events, sponsorships, design, PR and merchandise"],
  ["expense", "Utilities", "💡", "Office electricity, internet and phone bills"],
  ["expense", "Other", "•", "Spending that fits no other category"],
  ["income", "Sales", "💰", "Revenue from customers for products or subscriptions"],
  ["income", "Services", "🤝", "Fees for services, projects and retainers"],
  ["income", "Interest", "🏦", "Interest earned on deposits"],
  ["income", "Other income", "•", "Income that fits no other category"],
];

export const OPENING_BALANCES = "Opening balances";
export const LENT_AND_BORROWED = "Lent & borrowed";

/** Statements that give a new entity a ready-to-use chart of accounts. */
export function seedAccounts(db: D1Database, entityId: string, kind: EntityKind) {
  const t = now();
  const rows = kind === "business" ? BUSINESS : PERSONAL;
  let firstMoneyAccount: string | null = null;
  const stmts = rows.map(([type, name, icon, hint, subtype], i) => {
    const id = uuidv7();
    if (!firstMoneyAccount && type === "asset") firstMoneyAccount = id;
    return sql(
      db,
      `INSERT INTO accounts (id, entity_id, type, subtype, name, icon, hint, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entityId,
      type,
      subtype ?? null,
      name,
      icon,
      hint,
      i,
      t,
    );
  });
  // Who owes whom: one receivable/payable account, split by contact.
  const iouAccountId = uuidv7();
  stmts.push(
    sql(
      db,
      `INSERT INTO accounts (id, entity_id, type, subtype, name, icon, sort, system, created_at) VALUES (?, ?, 'asset', 'other', ?, '🤝', 0, 1, ?)`,
      iouAccountId,
      entityId,
      LENT_AND_BORROWED,
      t,
    ),
  );
  // Equity counter-account for opening balances and reconciliation adjustments.
  stmts.push(
    sql(
      db,
      `INSERT INTO accounts (id, entity_id, type, name, icon, sort, system, created_at) VALUES (?, ?, 'equity', ?, '⚖️', 0, 1, ?)`,
      uuidv7(),
      entityId,
      OPENING_BALANCES,
      t,
    ),
  );
  return { stmts, defaultAccountId: firstMoneyAccount as string | null, iouAccountId };
}
