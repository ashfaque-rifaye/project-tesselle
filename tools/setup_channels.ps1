# Connect Tesselle's outreach channels (email, real-time AI phone calls, WhatsApp) and create the owner key.
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
    $addr = Read-Host "  Gmail address to send from"
    $pw = Read-Plain "  16-character app password (input hidden)"
    $name = Read-Host "  Sender name shown to makers (Enter for 'Tesselle shopping agent')"
    if (-not $name) { $name = "Tesselle shopping agent" }
    $json = @{ address = $addr.Trim(); app_password = ($pw -replace "\s", ""); name = $name } | ConvertTo-Json -Compress
    Put-Secret "tesselle-mail" $json
}

# 3. Calls + WhatsApp: Twilio (console.twilio.com > Account info).
#    Caller ID: a Twilio number, or your own mobile after verifying it in Twilio > Phone Numbers > Verified Caller IDs.
#    The number stays in Secret Manager - the app never shows it.
#    WhatsApp: the Twilio sandbox number (whatsapp:+14155238886) for demos - each recipient first sends the sandbox's
#    "join <code>" message - or your approved WhatsApp Business sender. Set the sandbox's "When a message comes in"
#    webhook to https://tesselle-448771854429.asia-southeast1.run.app/api/whatsapp/inbound so replies flow back.
if ((Read-Host "Connect Twilio for real-time AI calls and WhatsApp? (y/n)") -eq "y") {
    $sid = Read-Host "  Account SID (AC...)"
    $tok = Read-Plain "  Auth token (input hidden)"
    $from = Read-Plain "  Caller ID in +E.164 form - a Twilio number or your verified mobile, e.g. +9198XXXXXXXX (input hidden)"
    $wa = Read-Host "  WhatsApp sender (Enter for the sandbox whatsapp:+14155238886, or type 'none')"
    if (-not $wa) { $wa = "whatsapp:+14155238886" }
    $cfg = @{ account_sid = $sid.Trim(); auth_token = $tok.Trim(); from_number = $from.Trim() }
    if ($wa -ne "none") { $cfg.whatsapp_from = $wa.Trim() }
    Put-Secret "tesselle-twilio" ($cfg | ConvertTo-Json -Compress)
}

Write-Host "Done. Tesselle picks the new settings up within 5 minutes - no redeploy needed." -ForegroundColor Green
