# Importing a bank or card statement (for agents)

You've been handed a statement (PDF, CSV, XLS or a screenshot) for one of the user's accounts. Your job is to transcribe it faithfully. Matching, deduplication and categorising happen in the app.

## Steps

1. **Get the format:** `fin import --schema` prints the JSON schema (`version: 1`).
2. **Transcribe the statement into that JSON.** Rules:
   - Copy every transaction line, in the order printed. Don't merge, skip, sort or "clean up" lines.
   - Amounts as strings, exactly as printed (`"1,23,456.78"`). Each line has **either** `debit` (money out / charged) **or** `credit` (money in / payment received).
   - `balance` is the running balance printed on that line. Include it whenever the statement shows one: it's what proves your transcription is right.
   - `openingBalance` and `closingBalance` are from the statement summary. For a card, they're the amount owed.
   - `description` is the narration verbatim (UPI IDs, reference numbers and all). Put the reference / UTR / cheque number in `reference` if it has its own column.
   - `account`: bank name, the account or card number as printed (masked is fine; the last 4 digits must be visible), IFSC if shown, and `type` `bank` or `card`.
   - Dates as `YYYY-MM-DD`. Indian statements are day-first: `03/10/26` is 3 October 2026.
   - Password-protected PDF: ask the user for the password. Never store it.
3. **Check it:** `fin import statement.json --check`. This verifies every running balance and maps the account, without writing anything.
   - `invalid_statement … Line N …`: you misread that line or a balance. Re-read the statement around line N and fix it. Never "fix" a number so the balances add up. Copy what's printed.
   - `unmapped_account`: no account has these last 4 digits. Tell the user, and suggest `fin accounts link "<account>" --last4 NNNN --bank "<bank>"`. Don't pick an account yourself unless they tell you which one (`--account "<name>"`).
4. **Preview:** `fin import statement.json` shows each line as `matched` (already recorded), `new`, `needs you`, `seen` (imported before) or `reversal` (a failed payment and its reversal). It also lists recorded transactions that weren't on the statement.
5. **Commit:** `fin import statement.json --yes`. Then report to the user:
   - how many lines were new, matched, and need review;
   - whether the books now agree with the statement's closing balance;
   - any "not on statement" items.

   Clear what you can yourself (`fin review`); flag only genuine unknowns for the owner with `fin flag <id> "why"`.

The full operating manual, including bank quirks and booking conventions, is `skills/fin/SKILL.md`.

## Good to know
- **Re-importing is safe.** Lines seen before are skipped, and an overlapping statement only adds what's new.
- **Undo** a whole import with `fin import undo <id>`.
- **Log in as an agent:** `fin login --profile <p> --url <server> --agent "<your name>"`. It prints a code and a link; the user approves it in their browser, so you never handle their password. Everything you add then shows "added by <you> (agent)".
- **Setting up:** `fin entities add`, `fin accounts add "<name>" --type bank|card|loan|fd|property|… --balance N --as-of D --bank B --last4 NNNN [--joint "Name" --share 50]`, `fin contacts add "<name>" --owes-you N`.
- **Other sources:** for things you read in an SMS or email, use `fin add … --source sms` (or `--source email`), or smart add with `--source sms`.
- **Don't categorise lines yourself or edit the JSON to match the ledger.** The app compares lines with what's already recorded (exact amount, ±3 days, or ±5 for cards), learns UPI IDs from the user's own labels, and asks the user about anything uncertain.
