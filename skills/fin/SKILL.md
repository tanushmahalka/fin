---
name: fin
description: "Run someone's personal finances through the `fin` CLI (Finance: a double-entry money manager with a read-only web app). Read the books, record and fix transactions, import bank and card statements, categorise, clear transfers in transit, book loans, EMIs and subscriptions, and flag what needs the owner. Triggers: fin, finance app, my books, balance sheet, net worth, categorise transactions, import statement, bank or credit card statement, EMI, loan, subscription, who owes me, transfers in transit, flagged, reconcile."
---

# fin: run the books for your owner

Finance is a money manager built for an AI agent to operate on someone's behalf:
a double-entry ledger on Cloudflare Workers + D1, the `fin` CLI, and a web app the
owner uses to **read**. **You do the writing. The owner reads, samples and talks to
you.** Anything that genuinely needs them goes on their Flagged page with a one-line
reason.

Read `README.md` for setup and `AGENTS.md` before changing the code.

## 1. Ground rules

1. **Keep the web app read-only for the owner.** Don't build approve queues, add/edit
   forms or "suggestions" for them to act on. If you need them, `fin flag <id> "why"`
   and ask in chat.
2. **Sign in as an agent** (`fin login --agent "<your name>"`) so every write says
   "added by <you> (agent)". Agent edits stay *needs review* until you pass
   `--reviewed`. Pass it once you're sure.
3. **Back up before risky work:** bulk edits, deletes, imports, migrations.
   `npm run real:backup` (local) or `npm run cloud:backup` (hosted).
4. **Never guess which account a statement belongs to.** Statements map by exact last
   4 digits, bank and IFSC. If one doesn't map, find out why (a replaced card gets a new
   number) instead of forcing it.
5. **Never invent IOUs.** A payment to a person is spending or income unless the owner
   says it's a loan, a repayment, or money passing through.
6. **Never change numbers to make balances agree.** The statement's running balance is
   the check on AI-read figures. Fix the transcription, not the figures.
7. **Protect privacy.** Mask account numbers to the last 4 in notes and messages. Keep
   statement passwords in the OS keychain or a secret store, never in files or chat logs.
8. **Never move money, pay, send email or contact anyone.** Drafts only, and only with
   the owner's approval.
9. **Ask before big balance-sheet changes** (opening balances, deleting history,
   deciding whose money something is). Explain the accounting in plain words, then act.

## 2. The model in five minutes

- **Entity:** one set of books (a person, a company, a family member). Members are
  owner, editor or viewer (an accountant is a viewer). `fin entities`, `fin use <entity>`.
- **Accounts** hold money or debt: bank, cash, wallet, card, investment, fd, property,
  loan, other. Assets show what's held; liabilities show what's owed.
  - `--group` sets the balance-sheet heading.
  - `--joint "Name" --share N`: net worth counts only that share.
  - `--limit` (cards) is capacity, never net worth.
  - `--last4 --bank --ifsc` are how statements find the account.
- **Categories** are income and expense accounts. Every transaction has exactly one.
- **Every transaction balances** (postings sum to zero). Kinds:

  | kind | meaning | posts |
  |---|---|---|
  | `expense` | spent | account → category |
  | `income` | earned or received | category → account |
  | `transfer` | the owner's money moved | account → account (cards, loans, FDs, EMI plans) |
  | `gave` | money out that someone owes back, or that was theirs | account → Lent & borrowed (with contact) |
  | `got` | money in: a repayment, or money held for someone | Lent & borrowed → account |

- **Contacts are tags on postings**, not accounts. Who owes whom lives in one hidden
  *Lent & borrowed* account. `fin owes` lists open balances.
- **Transfers in transit:** a clearing account for self-transfers whose other side
  isn't recorded yet. The other account's statement claims it later. Healthy books keep it at 0.
- **Evidence:** imported statement lines link to transactions (shown as reconciled ✓).
  Re-importing is safe: lines already seen are skipped.
- **EMI plans** (`fin emi`): purchases or loans repaid monthly. Card EMIs keep the
  unbilled principal in a hidden sub-account of the card, which the balance sheet folds into
  the card's line. Plans the card balance already includes (`--in-card`) are estimated
  from the schedule.
- **Subscriptions** (`fin subs`): recurring charges. Not a category: each charge keeps
  its real category. Charges match by contact (or note text) within ±25% of the
  expected amount. Statuses: active, missed (the books cover the due date and no charge
  came), cancelled, new.
- **Flags vs review:** `fin flag` is for the owner. `needsReview` is your own to-do list.

## 3. Commands

```bash
fin whoami                          # server, user, entity
fin ls --month 2026-09              # also --from/--to, -q text, --category, --account, --with
fin ls -a "<account>" --from D --to D
fin --json <any command>            # machine-readable output for scripting
fin summary --month 2026-09         # income, expenses, net
fin accounts [--as-of 2026-03-31]   # balance sheet (aliases: fin balance, fin bs)
fin credit                          # card limits and utilisation
fin owes                            # open IOUs
fin emi [--all] · fin subs [--all] · fin subs suggest
fin flagged · fin review · fin imports · fin categories [--income] · fin contacts
```

IDs: any `<id>` accepts the **last 8 characters** shown by `fin ls`.
Amounts: `250`, `1.5k`, `2L`, `1,20,000`, `120+80`; negative as `--balance=-0.35`.
Dates: `YYYY-MM-DD`, calendar dates in the entity's time zone.

### Writing
```bash
fin add 450 "Food & dining" "Dinner" --account "Bank" --date 2026-10-02 --with Zomato
fin income 50000 "Business income" "Invoice 12" --with "Client Co"
fin transfer 30000 "Bank A" "Bank B" "Top-up" --date 2026-07-02
fin gave 5000 "Friend" "Lent for tickets"
fin got 2000 "Friend" "Paid back"
fin edit <id> --kind transfer --from "Bank" --to "Home loan" --no-contact --note "Home loan EMI" --reviewed
fin edit <id> --category Groceries --with Blinkit --reviewed
fin edit <id> --note ""             # clear a note (the contact becomes the title)
fin rm <id> · fin undo <id>         # soft delete and restore
```
`fin edit` flags:
- `--from`: the money account (expense, income, gave, got) or the source (transfer).
- `--to`: the transfer destination.
- `--kind transfer` clears the contact.
- **Turning a transit line into income or expense? Also pass `--from <the real account>`**, or it stays on transit.

### Accounts, contacts, categories
```bash
fin accounts add "Savings" --type bank --bank "HDFC Bank" --last4 1234 --balance 12,345 --as-of 2026-03-31
fin accounts add "Home loan" --type loan --bank "Some Bank" --last4 5678 --balance 25,00,000 --as-of 2026-03-31
fin accounts edit "<card>" --last4 9876        # replaced card, new number
fin accounts reconcile "<account>" <balance> --date 2026-03-31   # adjustment to hit a statement figure on that date
fin accounts archive "<account>"                # at 0; still shows on past balance sheets where it held money
fin contacts merge "<duplicate>" --into "<keep>"
fin contacts edit "<c>" --name "Readable Name" --aliases "BANK TRUNCATED NAME, other spelling"
fin contacts edit "<c>" --category Groceries --apply    # usual category, applied to past lines too
fin categories add "Software & tools" --icon "🧰" --hint "Apps, SaaS and AI tools"
fin categories archive "<category>"
```
Opening balances and adjustments **can't be edited**: delete (`fin rm`) and re-create
them. `reconcile --date` compares against the balance *on that date*.

### EMIs, subscriptions, flags
```bash
fin emi add "Refurbished laptop" --account "<card>" --principal 40000 --instalment 3600 --months 12 --first 2026-07-08 --merchant "Store" --purchase <tx> --evidence "order #123"
fin emi add "Phone (gift for a parent)" --account "<card>" --in-card --principal 60000 --instalment 3600 --months 18 --first 2025-11-01 --with "<contact>"
fin emi add "Car loan" --account "<bank>" --loan "<loan account>" --instalment 25000 --months 60 --first 2025-05-10
fin emi edit <id|title> [--name …] [--close | --reopen]
fin subs add "Netflix" --amount 649 --with Netflix --account "<card>"
fin subs add "Cloud storage, via Apple" --amount 75 --every monthly --with Apple --note "…"
fin subs edit "<name>" [--amount N] [--every C] [--for "<company>"] [--note N] [--cancel | --restart]
fin flag <id> "One line: what you need from the owner and why" · fin unflag <id>
```
Name EMIs and subscriptions **by what they are, not by who billed them**: "iCloud+ 2 TB, via
Apple", "YouTube channel membership: <channel>", "Final semester fee (<university>)".
Put the evidence (receipt, booking ID, mandate ID) in the note.

## 4. Recipes

### 4.1 Find out what a transaction is
Use whatever search tools you have over the owner's email and documents. Look for the
amount near the date.
- **Bank and card alert emails** name the merchant even when the statement doesn't.
- **Payment gateways** (Razorpay, Stripe, Apple, Google Play, PayU, CRED) send receipts
  that name the actual product.
- **Invoice amounts** often live only in PDF attachments, so download and read them.
- **Your own books:** what the contact usually costs, and who it is usually for.

### 4.2 Import statements
1. **Collect the PDFs.** Statements usually arrive by email monthly. Keep one folder per
   account and keep the originals.
2. **Transcribe** each one into the JSON from `fin import --schema`:
   - every line, in printed order;
   - amounts exactly as printed;
   - debit *or* credit on each line;
   - the printed running balance;
   - opening and closing balances;
   - the masked account number with the last 4 visible.

   Extracting text locally (e.g. `pdftotext -layout`) and sending only the text to a
   model is cheaper and more private than sending the PDF.
3. **Check:** `fin import file.json --account "<name>" --check` verifies the running-balance chain.
   On `invalid_statement Line N`, re-read line N in the source. On `unmapped_account`, link
   the account (`fin accounts link … --last4`); don't guess.
4. **Commit:** `fin import file.json --account "<name>" --yes`. Expect "Books agree with
   the bank: X on <date>". If they don't, find the gap: a missing statement, an old manual
   adjustment covering a period, or a misread line.
5. **Then:** categorise the new lines (4.3), clear transit (4.4), and flag only genuine unknowns.

**Bank quirks seen so far** (Indian banks; add yours):
- **Card EMI conversions:** the purchase is credited back ("EMI CONV", "Purchase to EMI
  Credit", "AGGREGATOR EMI - OFFUS CREDIT"). Each month bills principal ("EMI PRIN",
  "Principal Amount Amortization", "OFFUS EMI,PRIN") plus interest and GST.
- **Some cards fold unbilled EMI into "Previous Balance"** (e.g. YES Bank), so the chain
  fails. Use the previous statement's card-only closing balance as the opening.
- **Some cards keep EMIs inside total outstanding** (e.g. SBI Card): use `--in-card`
  plans. A "(Pay in EMIs)" label alone doesn't mean a purchase was converted; trust the
  plan table.
- **Zero-amount lines** (₹0.00 CR) break validation: drop them.
- **"Outstanding instalment amount" in an EMI table** often includes future interest,
  so it isn't the principal.
- **Replaced cards** come back with a new last 4; old statements keep the old number.
- **Banks don't always email every statement.** Download the missing ones from net banking.

### 4.3 Categorise and clean
- Find the work: `fin review`, plus uncategorised lines from `fin --json ls`.
- Join each line to its raw narration (account + date + amount) and identify it (4.1).
- Merge duplicate contacts and add aliases, so future imports recognise them. Give
  repeat merchants a usual category with `--apply`.
- Booking conventions:
  - **Fees, GST on fees, forex markup, late fees, card EMI interest** → Bank & card charges.
  - **Interest on home, car and personal loans** → Loan interest, booked on the loan account.
  - **Apps, SaaS and AI tools** → Software & tools. **Streaming, music, memberships** → Entertainment.
  - **Small unidentifiable UPI or cash to stalls** → Local & street spends.
  - **Own accounts on both sides** → `transfer`. **Unknown other side** → Transfers in transit.
  - **Money that belongs to someone else passing through** (a company's receipt, a
    flatmate's rent share, a relative's cash) → `got` + `gave` with that contact. It nets
    to zero and is neither income nor spending.
  - **Purchase converted to EMI** → the full price in its real category on the purchase
    date. The conversion credit and each principal instalment are transfers to and from the plan.
- Notes: let the contact be the title. Strip bank jargon ("Value Dt", "Mandate", "via
  Razorpay"); imports already run `tidyNote` for this.
- Bulk edits: build a list of `id → args` and loop over the CLI with a few in parallel.

### 4.4 Clear transfers in transit
List `fin --json ls -a "Transfers in transit"`. For each parked line, find the other
side: same amount, within ±8 days, not touching transit. Turn that line into a transfer
with transit, and the pair cancels out. No other side in the books?
- **The other statement is missing:** point the line straight at the account and say so in the note.
- **It was really spending or income:** change the kind *and* pass `--from <bank>`.

### 4.5 Loans
- **The source of truth** is the loan statement (sanction, EMI, rate, monthly interest).
- **Opening:** the balance on the books' start date.
- **Each EMI:** a `transfer` from the bank to the loan.
- **Each month's interest:** `fin add <interest> "Loan interest" "<period>" --account "<loan>"`.
- **Check:** month-end balances against the statement.
- **Closure:** the payoff is a transfer; the loan reaches 0; archive it.
- **Selling the financed asset:** proceeds are a transfer from the asset account to the bank.

### 4.6 Subscriptions
1. Identify the real product first: app-store receipts, membership emails, invoice PDFs.
2. Add the subscription with the contact that bills it, the expected amount and cadence.
3. Several plans from one biller are separate subscriptions, told apart by amount.
4. Cancel only when you know it ended, or the owner says so.

### 4.7 Charges nobody recognises
1. **Card autopay:** the bank's pre-debit email names the mandate portal and autopay ID.
   The portal shows the merchant, amount and frequency.
2. **UPI autopay (India):** upihelp.npci.org.in, or any UPI app, lists every active mandate.
3. **Google charges:** whichever Google account has that card saved is the payer
   (Payments & subscriptions). For Workspace, check each domain's admin Billing page.
4. **Still unknown:** revoke the mandate. The service usually emails "payment declined"
   and names itself.
5. **Is it worth chasing?** Recurring charges always are. Book small one-offs as unidentified.

### 4.8 Reporting to the owner
- Lead with what changed and what it means, in plain language.
- Use the owner's currency formatting.
- List only the decisions they must make.
- When a booking is new to them, explain the accounting idea behind it.

## 5. Running the app
- **Local:** `npm run dev` (demo, :5180). `npm run real` keeps real books on this
  machine at :5190 (`~/.finance/local`).
- **Hosted:** Cloudflare Worker + D1 on your own domain behind Cloudflare Access. Real
  values go in `wrangler.private.jsonc` (gitignored); run commands with
  `WRANGLER_CONFIG=wrangler.private.jsonc`. See `README.md` → Deploy.
- **CLI behind Access** needs a service token: env `FIN_CF_ACCESS_CLIENT_ID` /
  `FIN_CF_ACCESS_CLIENT_SECRET`, or the macOS Keychain (service `finance.cf-access`,
  accounts `<host>:client-id` / `<host>:client-secret`). An Access HTML or 302 response
  means it's missing or expired.
- **Changing code:** follow `AGENTS.md`. Verify with `npm run check`, the e2e suite on a
  fresh database, and a look in the browser.

## 6. Pitfalls
- `fin edit --kind income|expense` on a transit line keeps transit unless you pass `--from`.
- Opening and adjustment transactions can't be edited; delete and re-create them.
- After deleting or re-creating an opening balance, check month-ends against the statement.
- Agent writes stay needs-review without `--reviewed`.
- Banks truncate names ("Acme Communicat"), so rename those contacts.
- A joint account where the owner's share is set to 0% makes money passing through it
  look like it vanished. Decide shares deliberately.
- Don't trust a low month or a "missed" subscription until statements cover that date.
  The app tracks statement coverage per account.
- D1: at most 100 bound parameters per query, 100 KB per SQL statement.

## 7. Keep this skill current, and keep personal notes out of it
This file belongs to the project. Update it **in the same change** whenever a command,
flag, page, booking convention, bank quirk or pitfall changes.

Owner-specific facts (their accounts, contacts, servers, folders, credentials,
decisions) go in a **private** companion skill outside the repo, e.g.
`~/.claude/skills/fin-local/SKILL.md`. Never put them here.
