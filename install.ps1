# Bucks Web3 Browser - Unified Installer
# Ensures all dependencies for the Swarm are met.

Write-Host "--- Bucks Swarm: Initializing Environment ---" -ForegroundColor Gold

# 1. Path Management
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

# 2. Dependency Check: Node.js
try {
    & node -v | Out-Null
    Write-Host "[✓] Node.js found." -ForegroundColor Green
} catch {
    Write-Error "Node.js not found. Please install it from nodejs.org"
    exit 1
}

# 3. Dependency Check: Python (for Social Backend)
try {
    & python --version | Out-Null
    Write-Host "[✓] Python found." -ForegroundColor Green
} catch {
    Write-Error "Python not found. Please install it with 'pip' support."
    exit 1
}

# 4. Install Browser Dependencies
Write-Host "Checking Browser dependencies..." -ForegroundColor Cyan
Set-Location "C:\Users\shafe\.gemini\antigravity\scratch\bucks-browser"
if (!(Test-Path "node_modules")) {
    & npm install
}

# 5. Install Social Backend Dependencies
Write-Host "Checking Social Backend dependencies..." -ForegroundColor Cyan
Set-Location "C:\Users\shafe\.gemini\antigravity\scratch\Bucks-global\backend"
& pip install -r requirements.txt

# 6. Initialize Data Directories
Write-Host "Initializing Local Storage..." -ForegroundColor Cyan
$userData = "$env:APPDATA\bucks-browser"
if (!(Test-Path $userData)) { New-Item -ItemType Directory -Path $userData }

# 7. Check for Blockchain Script
$chainPath = "C:\Users\shafe\OneDrive\Desktop\Blockchain\run.ps1"
if (!(Test-Path $chainPath)) {
    Write-Warning "Blockchain startup script not found at $chainPath"
}

Write-Host "--- Environment Ready ---" -ForegroundColor Gold
Write-Host "Run 'run_cluster.ps1' to start the swarm." -ForegroundColor Cyan
