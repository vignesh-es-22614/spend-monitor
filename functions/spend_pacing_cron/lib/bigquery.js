'use strict';
/**
 * BigQuery access. Returns daily spend in INR per product / engine / geo flag.
 *
 * Three traps are handled here and must stay handled:
 *  1. ads_Campaign_* is a daily-snapshot dimension table — read the LATEST
 *     partition per campaign, never ANY_VALUE, or names and joins go stale.
 *  2. Cost and clicks sum cleanly across segments_click_type; impressions do
 *     NOT (the same impression repeats per click type). We only need cost here.
 *  3. p_ads_* tables key on segments_date, not _DATA_DATE.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const {
  GOOGLE_ACCOUNTS, BING_ACCOUNTS, NON_US_PATTERN,
} = require('./config');

const PROJECT = process.env.BQ_PROJECT_ID || 'it-security-online-marketing';
const DS_GOOGLE = process.env.BQ_DATASET_GOOGLE || 'Google_ads_data_ajay';
const DS_BING = process.env.BQ_DATASET_BING || 'microsoft_ads_data';
const MCC = process.env.BQ_MCC || '5419501619';

function client() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (raw) {
    return new BigQuery({ projectId: PROJECT, credentials: JSON.parse(raw) });
  }
  // Local convenience: an installed-app OAuth token (client_id / client_secret /
  // refresh_token) works too, so a dry run needs no service account.
  const tokenPath = process.env.BQ_TOKEN_PATH;
  if (tokenPath) {
    const info = JSON.parse(require('fs').readFileSync(tokenPath, 'utf8'));
    if (info.refresh_token && info.client_id && info.client_secret) {
      const { UserRefreshClient } = require('google-auth-library');
      const authClient = new UserRefreshClient({
        clientId: info.client_id,
        clientSecret: info.client_secret,
        refreshToken: info.refresh_token,
      });
      return new BigQuery({ projectId: PROJECT, authClient });
    }
    return new BigQuery({ projectId: PROJECT, credentials: info });
  }
  // Otherwise Application Default Credentials.
  return new BigQuery({ projectId: PROJECT });
}

/**
 * Product classifier, shared shape across both engines.
 * ELA folds in L3C / Log360 / Shield on GOOGLE ONLY — the Bing export keeps
 * them out, and applying the fold there overstates ELA by ~15%.
 */
function googleProductCase() {
  return `
    CASE
      WHEN customer_id=1259940298 AND REGEXP_CONTAINS(campaign_name, r'(?i)^AD(AP|Audit)') THEN 'ADAP'
      WHEN customer_id=6843070472 AND REGEXP_CONTAINS(campaign_name, r'(?i)^AD360') THEN 'AD360'
      WHEN customer_id=6843070472 AND REGEXP_CONTAINS(campaign_name, r'(?i)^ADMP') THEN 'ADMP'
      WHEN customer_id=8573832901 AND REGEXP_CONTAINS(campaign_name, r'(?i)^ADS(SP|elfservice|elf.?Service)') THEN 'ADSSP'
      WHEN customer_id=1913132799 AND REGEXP_CONTAINS(campaign_name, r'(?i)^(ELA|L3C|Log360|Shield)') THEN 'ELA'
      WHEN customer_id=6158218545 THEN 'DSP'
      WHEN customer_id=8094989745 AND REGEXP_CONTAINS(campaign_name, r'(?i)^(SPMP|Sharepoint)') THEN 'SPMP'
      WHEN customer_id=1343295076 THEN 'MMP'
      WHEN customer_id=1650818176 THEN 'RMP'
    END`;
}

function bingProductCase() {
  return `
    CASE
      WHEN AccountId='${BING_ACCOUNTS.ADAP}' THEN 'ADAP'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^ADMP') THEN 'ADMP'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^AD360') THEN 'AD360'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^ADS(SP|elfservice|elf.?Service)') THEN 'ADSSP'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^ELA') THEN 'ELA'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^DSP') THEN 'DSP'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^SPMP') THEN 'SPMP'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^MMP') THEN 'MMP'
      WHEN AccountId='${BING_ACCOUNTS.MAIN}' AND REGEXP_CONTAINS(CampaignName, r'(?i)^RMP') THEN 'RMP'
    END`;
}

function googleSql(from, to) {
  return `
WITH latest AS (
  SELECT customer_id, campaign_id, campaign_name,
         ROW_NUMBER() OVER (PARTITION BY customer_id, campaign_id
                            ORDER BY _PARTITIONDATE DESC) AS rn
  FROM \`${PROJECT}.${DS_GOOGLE}.p_ads_Campaign_${MCC}\`
  WHERE customer_id IN (${GOOGLE_ACCOUNTS.join(',')})
),
cur AS (SELECT * FROM latest WHERE rn = 1),
tag AS (
  SELECT customer_id, campaign_id,
         ${googleProductCase()} AS product,
         NOT REGEXP_CONTAINS(campaign_name, r'${NON_US_PATTERN}') AS is_us
  FROM cur
)
SELECT CAST(s.segments_date AS STRING) AS date,
       t.product, t.is_us,
       ROUND(SUM(s.metrics_cost_micros)/1e6, 2) AS cost_inr
FROM \`${PROJECT}.${DS_GOOGLE}.p_ads_CampaignStats_${MCC}\` s
JOIN tag t
  ON t.campaign_id = s.campaign_id AND t.customer_id = s.customer_id
WHERE s.segments_date BETWEEN DATE(@from) AND DATE(@to)
  AND t.product IS NOT NULL
GROUP BY date, t.product, t.is_us`;
}

function bingSql(from, to) {
  return `
WITH tagged AS (
  SELECT event_date,
         SAFE_CAST(Spend AS FLOAT64) AS cost,
         ${bingProductCase()} AS product,
         NOT REGEXP_CONTAINS(CampaignName, r'${NON_US_PATTERN}') AS is_us
  FROM \`${PROJECT}.${DS_BING}.keyword_performance\`
  WHERE event_date BETWEEN @from AND @to
)
SELECT CAST(event_date AS STRING) AS date, product, is_us,
       ROUND(SUM(cost), 2) AS cost_inr
FROM tagged
WHERE product IS NOT NULL
GROUP BY date, product, is_us`;
}

async function fetchSpend(from, to) {
  const bq = client();
  const opts = (sql) => ({
    query: sql,
    params: { from, to },
    location: process.env.BQ_LOCATION || 'US',
  });

  const [google, bing] = await Promise.all([
    bq.query(opts(googleSql(from, to))).then((r) => r[0]),
    bq.query(opts(bingSql(from, to))).then((r) => r[0]),
  ]);

  const rows = [];
  for (const r of google) {
    rows.push({ date: r.date, product: r.product, engine: 'google',
                isUs: !!r.is_us, costInr: Number(r.cost_inr) || 0 });
  }
  for (const r of bing) {
    rows.push({ date: r.date, product: r.product, engine: 'bing',
                isUs: !!r.is_us, costInr: Number(r.cost_inr) || 0 });
  }
  return rows;
}

module.exports = { fetchSpend };
