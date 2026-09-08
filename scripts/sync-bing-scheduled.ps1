# Unattended Bing sync: fetch from the Ads API, rebuild, commit, push.
#
# Runs on this machine rather than in GitHub Actions on purpose. Microsoft
# rotates the refresh token on every use and the Bing Ads Agent writes the new
# one back to config/bing-ads.yaml. A copy of that token living in GitHub
# secrets could not be updated, so it would fail on the second run and would
# invalidate the local copy as well. Keeping the fetch here avoids all of it.
#
# Install (run once, in a normal PowerShell window):
#
#   schtasks /create /tn "SEM Bing sync" /sc daily /st 08:30 ^
#     /tr "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\Users\vignesh-22614.VIGNESH-22614\Downloads\Bigquery connector\sem-spend-pacing\scripts\sync-bing-scheduled.ps1\""
#
# 08:30 is deliberate: it lands before the 09:00 IST GitHub Action, so the
# workflow's own rebuild already sees the fresh Bing data.
#
#   schtasks /run /tn "SEM Bing sync"      test it now
#   schtasks /delete /tn "SEM Bing sync"   remove it
#
# Every run appends to logs/sync-bing.log.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logDir = Join-Path $repo 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir 'sync-bing.log'

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
    Write-Output $line
}

try {
    Write-Log '--- sync starting ---'

    # BigQuery credentials, from the same .env.deploy the deploy script uses.
    $envFile = Join-Path $repo '.env.deploy'
    if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
    $keyLine = Select-String -Path $envFile -Pattern '^\s*GCP_SERVICE_ACCOUNT_KEY_FILE=(.+)$'
    if (-not $keyLine) { throw 'GCP_SERVICE_ACCOUNT_KEY_FILE not set in .env.deploy' }
    $keyPath = $keyLine.Matches[0].Groups[1].Value.Trim()
    if (-not (Test-Path $keyPath)) { throw "Service account key not found: $keyPath" }
    $env:GCP_SERVICE_ACCOUNT_JSON = Get-Content $keyPath -Raw

    # Rebase BEFORE building, so the workflow's own docs/ commit never
    # conflicts with the one we are about to make. Skipped when the tree is
    # dirty - rebase refuses outright, and a half-finished edit sitting in the
    # repo must not stop the sync. The push retry below covers the race.
    git fetch origin main --quiet
    $dirty = git status --porcelain
    if ($dirty) {
        Write-Log 'working tree dirty - skipping rebase'
    } else {
        git rebase origin/main --quiet
        if ($LASTEXITCODE -ne 0) {
            git rebase --abort 2>$null
            Write-Log 'rebase failed - continuing without it'
        }
    }

    node scripts/sync-bing.js --days 16
    if ($LASTEXITCODE -ne 0) { throw 'sync-bing.js failed' }

    git add data/bing-backfill.json docs/
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Log 'no change - nothing to commit'
    } else {
        $stamp = Get-Date -Format 'yyyy-MM-dd'
        git commit -m "Sync Bing from the Ads API - $stamp" --quiet
        git push --quiet
        if ($LASTEXITCODE -ne 0) {
            # Lost a race with the workflow; rebase and try once more.
            Write-Log 'push rejected, rebasing and retrying'
            git pull --rebase --quiet
            git push --quiet
            if ($LASTEXITCODE -ne 0) { throw 'push failed twice' }
        }
        Write-Log "pushed - $stamp"
    }
    Write-Log '--- sync done ---'
}
catch {
    Write-Log "FAILED: $($_.Exception.Message)"
    exit 1
}
