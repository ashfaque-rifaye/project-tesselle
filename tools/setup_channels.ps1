# Connect Tesselle's outreach channels (email + AI phone calls) and create the owner key.
# Run in PowerShell from the project folder:   powershell -ExecutionPolicy Bypass -File tools\setup_channels.ps1
# Nothing typed here is written to disk or to the repo: each value goes straight into Secret Manager in
# the tesselle-demandfoundry project, readable only by the Cloud Run service account.

$ErrorActionPreference = "Stop"
$Project = "tesselle-demandfoundry"
$Runtime = "serviceAccount:tesselle-runtime@tesselle-demandfoundry.iam.gserviceaccount.com"

function Put-Secret($name, $value) {
    $exists = $false
    try { gcloud secrets describe $name --project $Project --format="value(name)" 2>$null | Out-Null; $exists = ($LASTEXITCODE -eq 0) } catch { $exists = $false }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $value, (New-Object System.Text.UTF8Encoding($false)))
        if ($exists) { gcloud secrets versions add $name --data-file=$tmp --project $Project | Out-Null }
        else { gcloud secrets create $name --data-file=$tmp --replication-policy=automatic --project $Project --labels=app=tesselle | Out-Null }
    } finally { Remove-Item $tmp -Force }
    gcloud secrets add-iam-policy-binding $name --member=$Runtime --role=roles/secretmanager.secretAccessor --project $Project | Out-Null
    Write-Host "  saved $name" -ForegroundColor Green
}

function Read-Plain($prompt) {
    $s = Read-Host $prompt -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

Write-Host "Using Google account:" (gcloud config get-value account) "- project $Project"
gcloud services enable secretmanager.googleapis.com --project $Project | Out-Null

# 1. Owner key: lets YOUR browsers send from your inbox / phone line; the public demo can't.
if ((Read-Host "Create a new owner key? (y/n)") -eq "y") {
    $bytes = New-Object byte[] 18
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")
    Put-Secret "tesselle-owner-key" $key
    Write-Host "  Owner key (paste it in Tesselle > menu > Connections on each of your devices):" -ForegroundColor Yellow
    Write-Host "  $key" -ForegroundColor Yellow
}

# 2. Email: Gmail app password (Google Account > Security > 2-Step Verification on > App passwords).
if ((Read-Host "Connect Gmail for sending and reading replies? (y/n)") -eq "y") {
    $addr = Read-Host "  Gmail address"
    $pw = Read-Plain "  16-character app password (input hidden)"
    $name = Read-Host "  Sender name shown to makers (Enter for 'Tesselle shopping agent')"
    if (-not $name) { $name = "Tesselle shopping agent" }
    $json = @{ address = $addr.Trim(); app_password = ($pw -replace "\s", ""); name = $name } | ConvertTo-Json -Compress
    Put-Secret "tesselle-mail" $json
}

# 3. Calls: Twilio Programmable Voice (console.twilio.com > Account info; Phone Numbers > your number).
if ((Read-Host "Connect Twilio for AI phone calls? (y/n)") -eq "y") {
    $sid = Read-Host "  Account SID (AC...)"
    $tok = Read-Plain "  Auth token (input hidden)"
    $from = Read-Host "  Your Twilio phone number in +E.164 form, e.g. +15551234567"
    $json = @{ account_sid = $sid.Trim(); auth_token = $tok.Trim(); from_number = $from.Trim() } | ConvertTo-Json -Compress
    Put-Secret "tesselle-twilio" $json
}

Write-Host "Done. Tesselle picks the new settings up within 5 minutes - no redeploy needed." -ForegroundColor Green
