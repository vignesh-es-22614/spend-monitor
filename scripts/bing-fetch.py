"""Pull daily Bing campaign spend straight from the Ads API.

Why this exists
---------------
The Microsoft Ads BigQuery transfer runs several days behind Google's and has
twice stalled outright, freezing the whole dashboard at the slower engine. The
Ads account always has the data, so fetch it directly and let build-site.js
splice it in for any day BigQuery is short.

This deliberately reuses the local "Bing Ads Agent" install rather than taking
its own credentials: config/bing-ads.yaml stays where it is and is never read
by this repo. Point BING_AGENT_DIR at that folder (it defaults to the usual
Desktop location) and run it with that project's venv python.

    python scripts/bing-fetch.py --days 14 --out raw/

Writes one JSON file per account, in the same shape the reporting API returns,
which scripts/bing-backfill.js then classifies into data/bing-backfill.json.
"""

import argparse
import datetime
import json
import os
import sys

DEFAULT_AGENT_DIR = os.path.join(
    os.path.expanduser("~"), "Desktop", "Bing Ads Agent"
)

# These are the two accounts that carry spend; DSP has no active campaigns.
# Kept here rather than in the agent's config so this repo stays the single
# source of truth for which accounts the dashboard covers.
ACCOUNTS = ["142002557", "142004499"]

# Must match the campaigns' own TimeZone or report days will not line up with
# the web UI. Every campaign in these accounts is Pacific.
REPORT_TIME_ZONE = "PacificTimeUSCanadaTijuana"

COLUMNS = [
    "TimePeriod", "CampaignId", "CampaignName", "CampaignStatus",
    "CurrencyCode", "Impressions", "Clicks", "Spend", "Conversions", "Revenue",
]


def as_report_date(d):
    return {"Year": d.year, "Month": d.month, "Day": d.day}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14,
                    help="trailing days to fetch, ending yesterday")
    ap.add_argument("--out", required=True, help="directory for the JSON files")
    ap.add_argument("--agent-dir", default=os.environ.get("BING_AGENT_DIR", DEFAULT_AGENT_DIR))
    args = ap.parse_args()

    if not os.path.isdir(args.agent_dir):
        sys.exit(f"Bing Ads Agent not found at {args.agent_dir}\n"
                 f"Set BING_AGENT_DIR or pass --agent-dir.")
    # Import the agent's own client, so credentials never leave that folder.
    sys.path.insert(0, args.agent_dir)
    try:
        from bing.client import BingAdsClient
    except ImportError as e:
        sys.exit(f"Could not import the agent's bing package ({e}).\n"
                 f"Run this with {args.agent_dir}\\venv\\Scripts\\python.exe")

    # Today is excluded: the current day is still partial and would read as a
    # sudden drop.
    end = datetime.date.today() - datetime.timedelta(days=1)
    start = end - datetime.timedelta(days=max(args.days, 1) - 1)
    print(f"Fetching {start} .. {end}")

    os.makedirs(args.out, exist_ok=True)
    client = BingAdsClient()
    total_rows = 0

    for acct in ACCOUNTS:
        request = {
            "Type": "CampaignPerformanceReportRequest",
            "Format": "Csv",
            "ReportName": f"CampaignPerformance {start}..{end}",
            "ReturnOnlyCompleteData": False,
            "ExcludeReportHeader": True,
            "ExcludeReportFooter": True,
            "ExcludeColumnHeaders": False,
            "Aggregation": "Daily",
            "Columns": COLUMNS,
            "Scope": {"AccountIds": [int(acct)]},
            "Time": {
                "CustomDateRangeStart": as_report_date(start),
                "CustomDateRangeEnd": as_report_date(end),
                "ReportTimeZone": REPORT_TIME_ZONE,
            },
        }
        rows = client.run_report(request, account_id=acct)
        payload = {
            "account_id": acct,
            "date_range": {"start": str(start), "end": str(end),
                           "days": args.days},
            "aggregation": "Daily",
            "campaigns": rows,
        }
        path = os.path.join(args.out, f"bing-{acct}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        print(f"  {acct}: {len(rows)} campaign-days -> {path}")
        total_rows += len(rows)

    if not total_rows:
        sys.exit("No rows returned - refusing to write an empty backfill.")
    print(f"{total_rows} campaign-days total")


if __name__ == "__main__":
    main()
