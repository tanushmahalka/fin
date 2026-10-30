# fin

**Give your agent a surface to manage your finances.**

Soon everyone will have a personal AI agent. Agents are good at the tedious part of
money: reading bank statements and receipts, categorising hundreds of lines, chasing
an unknown charge through your email, keeping loans and EMIs straight. What they lack
is a trustworthy place to write it all down that a human can check at a glance.

`fin` is that place:

- **A real ledger.** Double-entry books on Cloudflare Workers + D1, with balances that
  can't drift, an append-only audit log, and statement imports verified line by line
  against the bank's running balance.
- **A CLI built for agents.** Every action is a `fin` command with `--json` output, agent
  sign-in that attributes every write ("added by Claude (agent)"), and safe re-imports and undo.
- **A read-only web app for you.** Net worth, balance sheet, spending by month with a
  projection, EMIs, subscriptions, who owes whom. Installable on your phone.
  When the agent needs you, it flags a transaction with one line of why, and you answer in chat.
- **A skill file for your agent** (`skills/fin/SKILL.md`): how to run the books, the
  accounting conventions, statement quirks and pitfalls.

```
you:    "categorise last month and tell me what I'm paying for every month"
agent:  fin import … → fin edit … → fin subs add … → "₹3,850/mo across 8 subscriptions.
         One app's payment mandate expires next week; renew it or it stops."
```

Built for Indian money first (INR, April–March financial year, UPI, Indian bank and card
statements), but the ledger is currency-agnostic.

## Install the skill into your agent

Give your agent the operating manual before it touches your books. From the repo root:

```bash
# Claude Code / Claude Agent SDK
mkdir -p ~/.claude/skills && ln -s "$PWD/skills/fin" ~/.claude/skills/fin
# Any agent that reads ~/.agents/skills or a project skills folder
mkdir -p ~/.agents/skills && ln -s "$PWD/skills/fin" ~/.agents/skills/fin
```

Agents working inside this repo already find it at `.claude/skills/fin` (a link to
`skills/fin`). Keep your own details (accounts, servers, credentials, decisions) in a
**private** companion skill such as `~/.claude/skills/fin-local/SKILL.md`, never in the repo.

## Quick start

```bash
npm install
npm run db:reset                 # fresh local D1 database
npm run dev                      # http://localhost:5180
npm run seed:demo                # optional: two months of demo data (demo@example.com / demo-password-123)
npm run build:cli && npm link    # installs `fin`
fin login --url http://localhost:5180 --agent "My agent"   # approve in the browser
```

The first visit to a fresh instance shows **Setup**, which creates the owner account.
After that, people join only by invite.

**Smart add and questions** ("chai 40 cash", "spent on food last month?") use
[TypeSafe](https://www.npmjs.com/package/@typesafe-ai/sdk)'s Jev model. Put
`TYPESAFE_API_KEY=…` in `.dev.vars` to turn it on. Without it, everything else works the
same and smart add falls back to simple rules; an agent using the CLI doesn't need it.

**Real books on this machine:** `npm run real` serves http://localhost:5190 from
`~/.finance/local` (localhost only, untouched by dev resets). `npm run real:backup`
keeps consistent SQLite copies in `~/.finance/backups`.

## How it works

### Entities and members
An **entity** is anyone whose money is kept separately. Every account, category, transaction, budget and audit entry belongs to exactly one entity. Access is per entity:

| Role | Can |
| --- | --- |
| Owner | Everything, including members and settings |
| Editor | Add and edit transactions, accounts, categories, budgets |
| Viewer | Read, ask, export. This is the right role for a CA |

People who aren't members get a 404, not a 403, so entity ids can't be probed. Viewers are refused every write at the middleware level, before any handler runs.

Invites are single-use links bound to one email, stored only as a hash, and they expire in 7 days. No email service is needed: copy the link and send it.

### Accounts, categories, contacts
Every transaction answers three questions:

| Question | Concept | Example |
| --- | --- | --- |
| Where did the money sit? | **Account** (yours) | HDFC Savings, Cash, Credit card, Car loan |
| What was it for? | **Category** | Groceries |
| Who was on the other side? | **Contact** | Blinkit, Rahul, Acme Retail |

A contact is a tag, not an account: you never hold money "at Blinkit". Each contact shows what you've **sent** and **received**. Picking one in the add sheet fills the category and account you usually use with them.

**Who owes whom** lives in one *Lent & borrowed* account per entity, split by contact. This works like Khatabook:
- **You gave / You got** records lending, borrowing and paying back. It is never income or spending.
- **Split:** you paid ₹3,000 for dinner. Your ₹1,500 is spending and Rahul owes you ₹1,500.
- **They paid:** Priya bought your movie ticket, so you owe her.
- **Settle up** pre-fills the payment that clears a balance.

The **Balance sheet** shows what you own against what you owe:
- Own: cash, bank, investments, and money owed to you.
- Owe: cards, loans, and money you owe people.
- Pick any date (for example 31 March for the CA) to see balances as they were then.

### Statements, sources and deduplication
Your agent transcribes a bank or card statement into JSON (`fin import --schema`, playbook in `docs/import-bank-statement.md` and `skills/fin/SKILL.md`), then:

```
fin import statement.json --check   # verify + map, writes nothing
fin import statement.json           # preview
fin import statement.json --yes     # commit
```

1. **Map the account by exact identifiers.** The statement's last 4 digits (and bank or IFSC, when given) must match exactly one account's *statement details*. Otherwise the import errors out and says how to link the account. Account identity is never guessed.
2. **Verify the balance chain.** Every printed balance must equal the previous one plus or minus the line, and the lines must add up to the closing balance. A misread digit stops the import and names the line. This is what makes AI extraction safe.
3. **Deduplicate per account.** A line is checked against what's already recorded in that account:
   - Seen before (same fingerprint): skipped, so re-importing is safe.
   - Same reference number: matched.
   - Exactly one recorded transaction with the same amount within ±3 days (±5 for cards): matched.
   - Several identical-amount candidates that differ: Jev judges each pair ("same payment?").
   - Amounts that differ slightly: held for you, never auto-matched.
   - Each recorded transaction can be matched by only one line.
   - A failed UPI and its reversal pair off with nothing recorded.
   - Recorded entries missing from the statement are listed.
4. **Classify new lines with code first.** Learned UPI IDs, your other accounts' numbers (transfers), ATM and card-payment patterns, and who owes whom all come before Jev. Jev only handles what's left, 6 lines per call. Unclear lines are saved as *Uncategorised* and flagged for review.
5. **Commit as one batch.** The whole import can be undone.

**Provenance.** Each transaction records *where it came from* (`origin`: manual, smart, statement, sms, email, api) and *who* entered it: a person, or an agent token such as "added by Claude (agent)". *Evidence* rows record every outside sighting. A transaction you typed and the bank later reported is one transaction with statement evidence, shown with a green ✓ (reconciled). When you confirm a statement-matched transaction that has a contact, its UPI ID is learned, so next month's import knows it.

Uncertain lines go on the agent's own review list (`fin review`). Only what genuinely needs a human is flagged (`fin flag`) and shows on the web app's *Flagged* page with a one-line reason.

### The ledger: double entry under a simple UI
You see Expense, Income and Transfer. Underneath, every transaction is a set of **postings that sum to zero**, which is how accountants keep books:

| What you enter | Postings |
| --- | --- |
| ₹40 chai, paid cash | Food +40, Cash −40 |
| ₹80,000 salary into HDFC | HDFC +80,000, Salary −80,000 |
| ₹5,000 card bill from HDFC | Card +5,000, HDFC −5,000 |
| Lent Rahul ₹2,000 | Lent & borrowed +2,000 [Rahul], HDFC −2,000 |
| ₹3,000 dinner, Rahul's half | Food +1,500, Lent & borrowed +1,500 [Rahul], Card −3,000 |

Why this matters:
- **Balances are computed, never stored**, so they can't drift. Edit last month's transaction and every balance and report is still right.
- **Transfers and opening balances never count as income or spending.** Moving ₹25,000 into a SIP isn't an expense.
- **Credit cards behave correctly.** A card purchase is spending when you swipe; paying the bill later is just a transfer.
- **The CA gets real books.** *Export → Journal* gives debit and credit columns per posting, ready for Tally or Zoho.
- **Reconcile** sets an account to what the bank app shows and records the difference as an adjustment, so nothing is silently overwritten.

Other finance rules the app enforces:
- Money is stored as integer paise, never floats.
- Dates are calendar dates in the entity's time zone.
- The financial year runs April–March by default for INR.
- Deletes are soft (you can undo).
- The audit log is append-only: the database itself refuses edits and deletes.
- A database trigger stops a posting from ever linking two entities.

### Jev (TypeSafe) — where it helps
Jev handles judgments over closed sets. Code handles numbers, dates and policy. Jev proposes; it never writes.

| Feature | Jev decides | Code decides |
| --- | --- | --- |
| **Smart add** (add sheet, `/` bar, `fin "…"`) | expense/income/transfer/gave/got; which category; which account was named; which of the found numbers is the amount; which contact, or which words name a new one | finding amount, date and contact candidates; resolving "yesterday" or "3/10"; the note; the category and account you usually use with that contact; saving |
| **Contacts in old notes** (*Contacts → Find in past notes*) | one yes/no per word: is this a business or a person? | collecting candidate words, matching known contacts, tagging only what you approve |
| **Category suggestion** while you type a note | which category | only when no category is picked yet |
| **Personal-vs-business guard** (business entities) | is this a personal expense? | warns (never blocks) above 0.7 |
| **Ask** ("spent on food last month?", "who owes me?") | intent, period, category, account or contact | every number, straight from the ledger |

- **Confidence gates** live in `worker/jev.ts` (`BAR`). Anything below the bar stays blank, with suggestion chips, so you choose.
- **What Jev sees:** only the typed text, the entity name and kind, your category and account names with their descriptions, and the names of the few contacts that plausibly match. No balances, no history.
- **Code shortlists contacts first.** Code narrows hundreds of contacts down to a handful by fuzzy name match, then Jev picks among those. A wide choice over every contact would always name *someone*.
- **Getting better picks:** category **descriptions** (*Settings → Categories*) are what Jev reads to tell options apart. Name the merchants you use there.
- **Regression check:** `npm run eval:jev` runs 35 entries and 9 questions against an instance seeded by the e2e script. The last run had 126 fields right, 29 left for you, and 9 counted as misses, at about 350 ms per call. Most of those misses are deliberate: the account you usually use with a contact gets filled even when the text doesn't name one. The genuinely ambiguous misses are "food budget" (groceries or eating out?) and "show transport" (answered as a total, with the list).

### Interfaces
- **Web**: `/` opens *Ask or add*. Shortcuts: `N` new expense, `I` income, `T` transfer, `←`/`→` change month. In the add sheet, `Enter` saves and `Shift+Enter` saves and starts the next entry.
- **iPhone**: open the site in Safari, then *Share → Add to Home Screen*. It runs full-screen with its own icon, and nothing goes through the App Store.
- **CLI**: see below.
- **HTTP API**: everything the UI does is under `/api`. Send `Authorization: Bearer <token>` with a token from *Account → Command line*. Client-generated transaction ids make retries idempotent.

## CLI

```bash
fin login --url https://finance.example.com --agent Claude   # approve in the browser; no password in the terminal
fin entities add "Acme Studio" --business
fin accounts add "HDFC Savings" --type bank --balance 1,80,550 --as-of 2026-10-01 --bank "HDFC Bank" --last4 4821
fin accounts add "Joint savings" --type bank --joint "Meera Rao" --share 50
fin accounts add "SBI FD" --type fd --balance 1L            # also: property, investment, card, loan, wallet, cash, other
fin contacts add "Northwind Labs" --owes-you 25000 --as-of 2026-03-31
fin "chai 40 cash"                       # smart add, asks before saving (--yes to skip)
fin add 250 food "lunch" --account cash --date yesterday
fin transfer 5k hdfc cash ATM
fin add 640 groceries --with blinkit      # tag a contact
fin add 3000 food dinner --split rahul    # you paid; Rahul owes half (or --split rahul:1200)
fin add 400 transport cab --paid-by priya # Priya paid; you owe her
fin gave 2000 rahul "Goa advance"  ·  fin got 500 rahul
fin owes                                 # who owes whom
fin accounts --as-of 2026-03-31          # balance sheet on a date
fin accounts link "HDFC Savings" --last4 4821 --bank "HDFC Bank"
fin import statement.json [--yes]        # bank/card statement; fin imports · fin import undo <id> · fin review
fin emi · fin subs · fin credit          # EMIs, subscriptions, card limits
fin flag <id> "why"  ·  fin flagged      # ask the owner about one transaction
fin edit <id> --category Groceries --reviewed
fin ls --month last    ·  fin summary --fy
fin ask "how much on ads this FY"
fin export --fy --journal > books.csv
fin --profile work login --url https://books.example.org   # a second server
```

Every command takes `--json`. Tokens live in `~/.config/fin/config.json` (mode 600) and
can be revoked from the web app. The full operating guide is `skills/fin/SKILL.md`.

## Deploy to Cloudflare (private, behind your email)

One deployment per person or company. Separate databases mean a bug or a leaked
accountant password can't reach anyone else's data; each deployment can still hold
several entities. Your domain's DNS must be on Cloudflare.

1. **Keep real values out of git:** `cp wrangler.jsonc wrangler.private.jsonc` (gitignored)
   and `export WRANGLER_CONFIG=wrangler.private.jsonc` for the steps below.
2. `npx wrangler d1 create finance`, then put the id, your domain and your email
   (`OWNER_EMAIL`: only this email can run Setup) in `env.production`.
3. `npx wrangler secret put TYPESAFE_API_KEY --env production` (optional).
4. `npm run db:migrate:remote && npm run deploy`.
5. **Lock it with Cloudflare Access** (Zero Trust → Access → Applications):
   - a self-hosted application on your domain, with the One-time PIN login;
   - an *Allow* policy for your email;
   - a *Service Auth* policy with a service token, for the CLI.

   Then copy the application's AUD tag and your team domain (`<team>.cloudflareaccess.com`)
   into `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`, and deploy again. The Worker then rejects any
   request without a valid Access token, so nothing reaches the app without your email PIN.
6. **Give the CLI the service token**, via `FIN_CF_ACCESS_CLIENT_ID` /
   `FIN_CF_ACCESS_CLIENT_SECRET`, or on macOS the Keychain:
   `security add-generic-password -s finance.cf-access -a <host>:client-id -w <id>`
   (and `<host>:client-secret`).
7. Open your domain, pass the email PIN, complete Setup, then
   `fin login --url https://<your domain> --agent "<agent name>"`.

Backups: `npm run cloud:backup` exports the remote database to `~/.finance/backups`. D1
Time Travel can also restore it to a recent point.

## Project layout

```
shared/     money, dates, ledger, statements, EMIs, subscriptions, forecasting: used by worker, web and CLI
worker/     Hono API on Cloudflare Workers + D1 (routes/, jev.ts, access.ts, auth.ts, audit.ts)
src/        React web app (read-only pages, styles.css design tokens)
cli/        `fin` (single file, no dependencies)
migrations/ D1 schema (additive only)
skills/     the agent operating manual
scripts/    e2e.mjs (API checks), jev-eval.mjs (Jev calibration), seed-demo.mjs
```

Checks: `npm run check` (types) and `npm run test:e2e` against a fresh dev database
(isolation, roles, CSRF, idempotency, contacts, statement import, dedup, undo, EMIs).

## Ideas
- SMS and email capture: an agent that reads bank alerts and records or matches transactions as they happen.
- Receipts stored in R2, linked to transactions.
- GST fields on business expenses, and period locking once the accountant closes a year.

## License

MIT
