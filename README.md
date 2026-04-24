# Hive Burn Post Voter

Automatically votes on [@buildawhale](https://peakd.com/@buildawhale)'s daily burn post (and its burn comments) using one or more Hive accounts. Runs as a GitHub Actions workflow — no server needed.

---

## How it works

- A GitHub Actions cron fires once a day at the time set in the workflow YAML.
- It finds the latest burn post, fetches its burn comments, and votes with each configured account — checking Voting Power (VP) before every single vote.

---

## Quick start

### 1. Fork or clone this repo to your GitHub account

### 2. Add the required secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Required | Description |
|---|---|---|
| `ACCOUNT_1_USERNAME` | **yes** | Hive username for account 1 (no `@`) |
| `ACCOUNT_1_POSTING_KEY` | **yes** | Posting key for account 1 |
| `ACCOUNT_1_VOTE_POST` | **yes** | `true` = vote post + comments · `false` = comments only |
| `ACCOUNT_2_USERNAME` | no | Hive username for account 2 |
| `ACCOUNT_2_POSTING_KEY` | no | Posting key for account 2 |
| `ACCOUNT_2_VOTE_POST` | no | `true` or `false` |
| `TARGET_AUTHOR` | no | Burn account to target (default: `buildawhale`) |
| `MIN_VOTING_POWER` | no | Minimum VP in basis points to vote (default: `8000` = 80%) |
| `VOTE_WEIGHT` | no | Vote weight in basis points (default: `10000` = 100%) |
| `HOURS_BACK` | no | How far back to look for the burn post (default: `24` hours) |

> Add more accounts by repeating the pattern with `ACCOUNT_3_*`, `ACCOUNT_4_*`, etc., and uncommenting the matching lines in the workflow YAML.

### 3. Enable Actions

GitHub may disable Actions on forked repos. Go to the **Actions** tab and click **"I understand my workflows, go ahead and enable them"**.

### 4. Test it manually

Use **Actions → Hive Burn Post Voter → Run workflow** to trigger a run immediately (manual dispatches bypass the hour check and always execute).

---

## Secrets reference

### Scheduling (GitHub Actions)

Edit the cron line in `.github/workflows/hive_burn_voter.yml`:

```yaml
- cron: '50 23 * * *'   # 23:50 UTC
- cron: '0 17 * * *'    # 17:00 UTC (5 PM)
- cron: '30 0 * * *'    # 00:30 UTC
```

Format is `MINUTE HOUR * * *` (always UTC). Manual `workflow_dispatch` runs always execute immediately.

### Scheduling (local / self-hosted)

Set `RUN_HOUR_UTC` and optionally `RUN_MINUTE_UTC` in your `.env`:

```env
RUN_HOUR_UTC=23
RUN_MINUTE_UTC=50   # defaults to 0 if omitted
```

### Multiple accounts

```
ACCOUNT_1_USERNAME=alice
ACCOUNT_1_POSTING_KEY=5J...
ACCOUNT_1_VOTE_POST=true       # votes on the burn post AND all burn comments

ACCOUNT_2_USERNAME=bob
ACCOUNT_2_POSTING_KEY=5K...
ACCOUNT_2_VOTE_POST=false      # votes on burn comments only (preserves VP)
```

Accounts are processed sequentially. If an account's VP drops below `MIN_VOTING_POWER` mid-run, it stops immediately for that account and moves on.

---

## Local / self-hosted usage

```bash
npm install

# Copy and fill in your config
cp .env.example .env

# Run once immediately
node hive_burn_voter.js --run-once

# Start the built-in cron scheduler (uses RUN_HOUR_UTC from .env)
node hive_burn_voter.js
```

Create a `.env` file (never commit it):

```env
RUN_HOUR_UTC=0
TARGET_AUTHOR=buildawhale
MIN_VOTING_POWER=8000
VOTE_WEIGHT=10000
HOURS_BACK=24

ACCOUNT_1_USERNAME=alice
ACCOUNT_1_POSTING_KEY=5J...
ACCOUNT_1_VOTE_POST=true

ACCOUNT_2_USERNAME=bob
ACCOUNT_2_POSTING_KEY=5K...
ACCOUNT_2_VOTE_POST=false
```

---

## VP safety

Two layers of protection prevent over-spending VP:

1. **Pre-run check** — if VP is already below `MIN_VOTING_POWER` when an account's turn starts, the entire account is skipped.
2. **Pre-vote check** — VP is re-fetched live from the chain before every individual vote. If it dropped (e.g. because of votes cast between accounts), the loop stops immediately.

---

## Dependencies

- [`@hiveio/dhive`](https://github.com/openhive-network/dhive) — Hive blockchain client
- [`dotenv`](https://github.com/motdotla/dotenv) — `.env` loader for local runs
- [`node-cron`](https://github.com/node-cron/node-cron) — cron scheduler for self-hosted mode
