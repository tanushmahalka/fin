# Working on Finance

Read `README.md` first. These rules protect the money; don't trade them for convenience.

**Operating manual: `skills/fin/SKILL.md`** (how to use `fin` and run the books). Update it in the same commit whenever a command, flag, page, booking convention or bank quirk changes. The web app is read-only for the owner; all writes go through the CLI.

## Invariants
- **Money is integer minor units (paise).** Parse user input with `shared/money.ts → parseAmount`, display with `formatMoney`. Never use floats for stored or summed amounts.
- **Every transaction's postings sum to zero.** Build them with `shared/ledger.ts` (`buildPostings`, `assertBalanced`). `GET /api/entities/:id/integrity` must stay `ok: true`.
- **Balances and reports are derived from postings.** Never add a stored balance column.
- **Everything is entity-scoped.** Every query filters by `entity_id`, and entity routes sit behind `requireMember`. Writes call `need(c, "editor" | "owner")`. Non-members get 404.
- **Audit in the same batch.** Each write includes `audit(db, …)` in the same `db.batch([...])` as the change. `audit_log` is append-only by trigger.
- **Soft delete only** for transactions (`deleted_at`). Accounts, categories and contacts are archived, never removed. A contact with a non-zero balance can't be archived.
- **Contacts are tags, not accounts.** The contact is stored on each posting (`postings.contact_id`). Who-owes-whom lives only in the entity's Lent & borrowed account (`entities.iou_account_id`). Every posting to that account must carry a contact, and the account is never picked directly. "gave" and "got" are API kinds, stored as `transfer`.
- **Dates are calendar strings** (`YYYY-MM-DD`) in the entity's time zone. Never derive them from `toISOString()`.

## Statements and provenance
- `origin` (where it came from) is set once at creation: imports set `statement`, the API accepts manual/smart/sms/email/api. *Who* is `created_by` plus `agent_name` (from tokens with `agent = 1`).
- Evidence rows are every outside sighting (`statement`, `sms`, `email`). Dedup links evidence to an existing transaction rather than creating a second one. Statement evidence marks a transaction reconciled. Unique indexes enforce one fingerprint per line and one statement line per transaction per account.
- Account mapping uses exact identifiers only (`accounts.number_last4`, bank, IFSC). Never let a model pick the account.
- The running-balance chain in `shared/statement.ts → verifyStatement` is the guard on AI-transcribed numbers. Don't loosen it.
- Learn UPI IDs (`contact_identifiers`) only from labels a person gave, never from an agent's or Jev's guess.
- Agent playbook: `docs/import-bank-statement.md`.

## Migrations
- Additive only (`ALTER TABLE … ADD COLUMN`, new tables). D1 runs migrations in a transaction with foreign keys on, so a table rebuild's `DROP TABLE` triggers `ON DELETE CASCADE` and silently deletes children (budgets). Express new kinds as data, not CHECK changes.
- Before migrating real books: `npm run real:backup` (local) or `npm run cloud:backup` (hosted).

## Jev (TypeSafe)
- Jev **proposes, code decides**. It picks from closed sets (kind, category, account, amount candidate, intent, period). Code finds candidates, does all arithmetic and dates, applies the confidence bars (`BAR` in `worker/jev.ts`), and never saves without a person confirming.
- Never let a model decide access, amounts, balances or anything that writes.
- Send only what the question needs. Never include balances or history in `state`.
- After changing questions, criteria, hints or bars, run `npm run eval:jev` against a seeded dev instance and compare the right, empty and wrong counts. Wrong counts are what matter. The rate limit is 60/min per user, so wait a minute between runs.

## Checks before you finish
No unit tests, by design: verify end to end instead.
```
npm run check                                        # tsc -b
npm run db:reset && npm run dev  &  npm run test:e2e # API scenarios on a fresh DB
npm run build && npm run build:cli
```

## Conventions
- **API:** Hono routes in `worker/routes/*`, zod validation via `parseBody`, errors as `AppError` → `{ error: { code, message } }`.
- **Web:** TanStack Query hooks in `src/api.ts`. Mutations invalidate `["e", entityId]`. Design tokens live in `src/styles.css`: Geist, 600-weight tight-tracked headlines, tabular numbers.
- **Copy:** plain, short, sentence case. Say what happened and what to do next.
- **Deploys:** real deployment values live in the gitignored `wrangler.private.jsonc` (`WRANGLER_CONFIG=wrangler.private.jsonc`); never commit domains, database ids, Access ids or emails. `@cloudflare/vite-plugin` writes the deploy config to `dist/finance/wrangler.json`. Keep `routes` out of the top level of `wrangler.jsonc`, or environments inherit them. Deploy scripts `rm -rf dist` first.
