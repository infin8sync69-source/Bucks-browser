# Bucks Web3 Browser - Cluster Runner
# Launches the Social Gateway, Blockchain Node, and Browser in a single orchestration.

param (
    [string]$Secret = "BUCKS_DEFAULT_CLUSTER",
    [string]$CIDN = "mainnet",
    [switch]$DevMode
)

Write-Host "--- Bucks Swarm: Launching Cluster ---" -ForegroundColor Gold
Write-Host "Identity Key: $Secret" -ForegroundColor Cyan
Write-Host "Cluster ID:   $CIDN" -ForegroundColor Cyan

# 1. Start Social Gateway (Port 8000)
Write-Host "Starting Social Gateway (8000)..." -ForegroundColor Gray
Start-Process python -ArgumentList "main.py" -WorkingDirectory "C:\Users\shafe\.gemini\antigravity\scratch\Bucks-global\backend" -WindowStyle Hidden

# 2. Start Blockchain Node (Port 8080)
$chainScript = "C:\Users\shafe\OneDrive\Desktop\Blockchain\run.ps1"
if (Test-Path $chainScript) {
    Write-Host "Starting Blockchain Node (8080)..." -ForegroundColor Gray
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$chainScript`"" -WindowStyle Hidden
}

# 3. Wait for ports to warm up (optional)
Start-Sleep -Seconds 2

# 4. Launch Browser with Cluster Params
Write-Host "Launching Browser Cluster Node..." -ForegroundColor Green
$env:BUCKS_CLUSTER_SECRET = $Secret
$env:BUCKS_CLUSTER_CIDN = $CIDN
if ($DevMode) { $env:BUCKS_DEV = "true" }

Set-Location "C:\Users\shafe\.gemini\antigravity\scratch\bucks-browser"
$electronPath = ".\node_modules\electron\dist\electron.exe"
if (Test-Path $electronPath) {
    & $electronPath .
} else {
    Write-Error "Browser executable not found. Run install.ps1 first."
}

Write-Host "Swarm Node Terminated." -ForegroundColor Gold
