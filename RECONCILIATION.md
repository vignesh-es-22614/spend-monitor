# Reconciliation notes

Everything in `lib/config.js` was derived by matching BigQuery against the
`SIEM_Weekwise` export for **6 Jul – 23 Aug 2026**. Do not change these values
without re-running `node scripts/dry_run.js --verify`.

## Scope

The workbook tracks **US-targeted campaigns, denominated in USD**. BigQuery holds
all geographies in INR. Missing either half makes the numbers look 96×–211× apart.

## FX

`FX_INR_PER_USD = 95.6`. Solved from the export — it lands on exactly 95.6 for
ADAP (both engines), ADMP Bing, DSP, MMP, RMP, AD360 and SPMP Bing.

## The US rule (counter-intuitive)

A campaign is **US unless its name names another country**. It is *not* "contains
the token US". Getting this backwards drops campaigns like
`MMP Search Branding - Bing` (~$1,548), which carries no geo token but is counted
as US in the report.

## ELA includes L3C — on Google only

| | ELA alone | ELA + L3C | Export |
|---|---:|---:|---:|
| Google | $150,132 | **$161,450** | $161,492 |

Applying the same fold on Bing overstates ELA by ~15.5%, so `Log360`/`L3C` are
excluded there. The asymmetry is deliberate and encoded in `bigquery.js`.

## Result

| Product | Google | Bing | All |
|---|---:|---:|---:|
| ADAP | 0.0% | 0.0% | 0.0% |
| ELA | −0.0% | +0.1% | 0.0% |
| SPMP | 0.0% | 0.0% | 0.0% |
| DSP | +0.1% | 0.0% | +0.1% |
| MMP | +0.1% | +0.1% | +0.1% |
| ADMP | −0.8% | +0.3% | −0.7% |
| ADSSP | +1.0% | 0.0% | +0.8% |
| RMP | 0.0% | +14.8% | +5.9% |
| **TOTAL** | **−0.2%** | **+0.5%** | **−0.1%** |

## Known open item

**RMP Bing** is the one outlier. BigQuery shows $6,296, the export shows $5,487.
The whole $809 gap is one campaign — `RMP Search US Imp - Exact` ($811) — which is
live US spend in Bing but absent from the export. That looks like a gap in the
export rather than a classification difference, so the spend is retained here.

**AD360 Google** is absent from the export entirely; BigQuery does carry it.

## BigQuery gotchas encoded in `bigquery.js`

1. `ads_Campaign_*` is a daily-snapshot dimension table. Read the **latest**
   partition per campaign — `ANY_VALUE` returns stale names and inflates joins.
2. Impressions double-count across `segments_click_type` (the same impression
   repeats on SITELINKS, AD_IMAGE, CALLS). Cost and clicks sum cleanly. Only
   `URL_CLICKS` gives correct impressions.
3. `p_ads_*` tables key on `segments_date`, not `_DATA_DATE`.
4. Conversions are **not** in `CampaignStats` (always 0) — they live in
   `p_ads_CampaignConversionStats_*`, which lags spend by ~10 days.
