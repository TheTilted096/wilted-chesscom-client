# Script to start Microsoft Edge in "Bot Mode" (Clean Window)
# Bypasses Chrome restrictions by using Edge on Port 9223

Write-Host "---------------------------------" -ForegroundColor Cyan
Write-Host "  Edge Bot Launcher (Clean Mode)"
Write-Host "---------------------------------" -ForegroundColor Cyan
Write-Host ""

# 1. Configuration
$PORT = 9223
$EdgeUrl = "https://www.chess.com/play/computer"

# 2. Kill existing Edge instances
Write-Host "Step 1: Closing existing Edge instances..." -ForegroundColor Yellow
$edgeProcesses = Get-Process msedge -ErrorAction SilentlyContinue
if ($edgeProcesses) {
    Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Write-Host "Edge closed" -ForegroundColor Green
Write-Host ""

# 3. Find Edge Executable
$EdgePaths = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

$EdgePath = $null
foreach ($path in $EdgePaths) {
    if (Test-Path $path) {
        $EdgePath = $path
        break
    }
}

if (-not $EdgePath) {
    Write-Host "Edge not found!" -ForegroundColor Red
    exit 1
}

# 4. Start Edge
Write-Host "Step 2: Starting Edge on Port $PORT..." -ForegroundColor Yellow
$UserDataDir = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"

# FIXED: Added triple quotes around UserDataDir to handle the space in "User Data"
# ADDED: --app flag for a clean, single-window experience
$EdgeArgs = @(
    "--remote-debugging-port=$PORT",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$UserDataDir`"", 
    "--no-first-run",
    "--no-default-browser-check",
    "--app=$EdgeUrl"
)

$process = Start-Process -FilePath $EdgePath -ArgumentList $EdgeArgs -PassThru
Write-Host "Edge started (PID: $($process.Id))" -ForegroundColor Green

# 5. Verification
Start-Sleep -Seconds 4
$test = Test-NetConnection -ComputerName localhost -Port $PORT -WarningAction SilentlyContinue

if ($test.TcpTestSucceeded) {
    Write-Host ""
    Write-Host "---------------------------------" -ForegroundColor Green
    Write-Host "  SUCCESS! Edge is ready." -ForegroundColor Green
    Write-Host "---------------------------------" -ForegroundColor Green
    Write-Host "  - Window Mode: App (Clean)"
    Write-Host "  - Port: $PORT"
    Write-Host ""
} else {
    Write-Host "Failed to detect open port." -ForegroundColor Red
}