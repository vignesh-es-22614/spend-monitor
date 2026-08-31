# SEM Spend Pacing

Scheduled spend-pacing digest for ManageEngine SEM. Queries BigQuery for
US-targeted Google + Bing spend, computes pacing against the Q3 budgets,
emails the digest, and refreshes the hosted dashboard.

Reconciled to the `SIEM_Weekwise` export within **0.1%** — see
[RECONCILIATION.md](RECONCILIATION.md) before changing any classifier.

```
sem-spend-pacing/
├── catalyst.json
├── client/                          # hosted dashboard (Web Client Hosting)
│   ├── client-package.json
│   └── index.html
├── functions/
│   └── spend_pacing_cron/           # Cron function
│       ├── catalyst-config.json
│       ├── index.js
│       └── lib/
│           ├── config.js            # scope, FX, budgets, thresholds
│           ├── bigquery.js          # SQL + classifiers
│           ├── pacing.js            # benchmark, projection, insights
│           └── email.js             # HTML digest + Catalyst Mail
├── scripts/dry_run.js               # local preview, sends nothing
└── .github/workflows/deploy.yml
```

## 1. Prerequisites

- A Catalyst project (console.catalyst.zoho.com) — note its **Project ID**
- A GCP service account with `roles/bigquery.jobUser` on
  `it-security-online-marketing` and `roles/bigquery.dataViewer` on
  `Google_ads_data_ajay` and `microsoft_ads_data`
- A **verified sender** in Catalyst Mail (Catalyst → Mail → Email Configuration).
  Mail will not send from an unverified address.

## 2. Local dry run

```bash
cd functions/spend_pacing_cron && npm install && cd ../..
export GCP_SERVICE_ACCOUNT_JSON="$(cat /path/to/key.json)"
node scripts/dry_run.js --verify
```

Writes `preview.html` and `preview.txt`, prints the digest, and checks the
computed percentages against the workbook. It sends nothing. If `--verify`
reports drift above 5 points, the classifier has broken — start with
RECONCILIATION.md.

## 3. Environment variables

Set these in Catalyst → Settings → Environment Variables:

| Variable | Required | Example | Notes |
|---|---|---|---|
| `GCP_SERVICE_ACCOUNT_JSON` | yes | `{"type":"service_account",...}` | Whole key file, one line |
| `MAIL_FROM` | yes | `sem-reports@zohocorp.com` | Must be Catalyst-verified |
| `MAIL_TO` | yes | `a@zohocorp.com,b@zohocorp.com` | Comma-separated |
| `EMAIL_DAYS` | no | `MON` | `MON,THU` / `DAILY` / `NEVER`. Default `MON` |
| `DASHBOARD_URL` | no | `https://<project>.catalystserverless.com/app` | Adds a button to the email |
| `CATALYST_FOLDER_ID` | no | `123456789` | File Store folder for `data.json` |
| `REFRESH_TOKEN` | no | long random string | Enables `POST /refresh` |
| `RECENT_WINDOW_DAYS` | no | `21` | Trailing window for the projection |
| `FX_INR_PER_USD` | no | `95.6` | Override only if the rate changes |
| `AS_OF` | no | `2026-08-23` | Pin the end date; otherwise today |
| `BQ_LOCATION` | no | `US` | Dataset location |

## 4. Deploy

```bash
npm install -g zcatalyst-cli
catalyst login
catalyst deploy
```

Or push to `main` and let the GitHub Action do it. Add two repository secrets:

- `CATALYST_TOKEN` — from `catalyst login --no-localhost`
- `CATALYST_PROJECT_ID`

## 5. Schedule it — daily refresh, weekly email

The cron runs **every day**. Each run refreshes the dashboard data; the email
goes out only on the days named in `EMAIL_DAYS`. So the numbers are always
current without mailing people every morning.

Catalyst does not take the cron expression from source — create it once:

**Catalyst → Cron → Create Cron**

| Field | Value |
|---|---|
| Name | `spend-pacing-daily` |
| Type | Cron Expression |
| Expression | `0 30 3 * * ? *` — every day 09:00 IST |
| Function | `spend_pacing_cron` |

Catalyst cron runs in **UTC**; 09:00 IST is 03:30 UTC.

Control the email cadence with `EMAIL_DAYS` (evaluated in IST):

| `EMAIL_DAYS` | Effect |
|---|---|
| `MON` (default) | Refresh daily, email Mondays |
| `MON,THU` | Refresh daily, email twice a week |
| `DAILY` | Refresh and email every day |
| `NEVER` | Refresh only, no email |

Because the ads transfer lags ~2 days, a run reports through roughly two days
ago. The digest and the dashboard both state their own `as of` date.

### How the dashboard stays fresh

```
cron (daily) ──> BigQuery ──> Cache (36h TTL) ──┐
                          └─> File Store         ├─> GET /server/spend_data/data ──> dashboard
                                                 ┘
```

The page renders its embedded snapshot instantly, then swaps in live data when
the fetch returns — so it is never blank and never blocks on the network. If the
endpoint is unreachable it keeps the snapshot and shows
*"live refresh unavailable, showing last build"* rather than failing.

The 36-hour cache TTL means one failed cron run still serves yesterday's numbers.

### Forcing a refresh

Set `REFRESH_TOKEN`, then:

```bash
curl -X POST https://<project>.catalystserverless.com/server/spend_data/refresh \
  -H "X-Refresh-Token: $REFRESH_TOKEN"
```

## 6. Verify

Trigger the function once from the console, then check:

1. The email arrives and the numbers match the dashboard
2. Function logs show `Sent "..." to ...`
3. `data.json` is refreshed in File Store, if configured

## How projection works

```
benchmark       = days elapsed / days in quarter   (54/92 = 58.7%)
used %          = spend / budget
projected %     = used % / benchmark
projected spend = spend / benchmark
over / under    = projected spend - budget
```

A straight run-rate carried to quarter end. It assumes the remaining days look
like the days so far — no seasonality, no planned pauses. It can never land
below spend already incurred; if it does, the formula is wrong.
