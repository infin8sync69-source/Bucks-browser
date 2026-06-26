# Bucks Browser Launcher
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

Write-Host "--- Initializing Bucks Web3 Browser ---" -ForegroundColor Gold

if (!(Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    & "C:\Program Files\nodejs\npm.cmd" install
}

# The shadowing issue: ensure we use the correct Electron executable
$electronPath = ".\node_modules\electron\dist\electron.exe"
if (!(Test-Path $electronPath)) {
    Write-Host "Electron executable not found. Retrying install..."
    & "C:\Program Files\nodejs\npm.cmd" install
}

Write-Host "Launching Bucks..." -ForegroundColor Cyan
& $electronPath .
