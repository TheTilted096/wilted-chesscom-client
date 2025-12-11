# Unified Launcher for Wilted Chess.com Client
# Starts Edge, API Server, and Test Client all in one command

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Wilted Chess.com Client - All-in-One"
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Configuration
$PORT = 9223
$API_PORT = 3000
$EdgeUrl = "https://www.chess.com/play/computer"

# Step 1: Kill existing Edge instances
Write-Host "[1/4] Closing existing Edge instances..." -ForegroundColor Yellow
$edgeProcesses = Get-Process msedge -ErrorAction SilentlyContinue
if ($edgeProcesses) {
    Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "      Edge closed" -ForegroundColor Green
} else {
    Write-Host "      No existing Edge instances found" -ForegroundColor Gray
}
Write-Host ""

# Step 2: Find and Start Edge
Write-Host "[2/4] Starting Edge with remote debugging..." -ForegroundColor Yellow

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
    Write-Host "      ERROR: Edge not found!" -ForegroundColor Red
    exit 1
}

$UserDataDir = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
$EdgeArgs = @(
    "--remote-debugging-port=$PORT",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$UserDataDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--app=$EdgeUrl"
)

$edgeProcess = Start-Process -FilePath $EdgePath -ArgumentList $EdgeArgs -PassThru
Write-Host "      Edge started (PID: $($edgeProcess.Id))" -ForegroundColor Green
Write-Host "      Waiting for Edge to initialize..." -ForegroundColor Gray
Start-Sleep -Seconds 4

# Verify Edge is running
$test = Test-NetConnection -ComputerName localhost -Port $PORT -WarningAction SilentlyContinue
if (-not $test.TcpTestSucceeded) {
    Write-Host "      WARNING: Edge debugging port not detected" -ForegroundColor Red
}
Write-Host ""

# Step 3: Start API Server
Write-Host "[3/4] Starting API server..." -ForegroundColor Yellow

# Start the API server as a background job
$apiJob = Start-Job -ScriptBlock {
    param($scriptPath)
    Set-Location $scriptPath
    node src/api-server.js
} -ArgumentList $PSScriptRoot

Write-Host "      API server starting (Job ID: $($apiJob.Id))..." -ForegroundColor Green
Write-Host "      Waiting for API server to initialize..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# Verify API server is running
$apiTest = Test-NetConnection -ComputerName localhost -Port $API_PORT -WarningAction SilentlyContinue
if ($apiTest.TcpTestSucceeded) {
    Write-Host "      API server ready on http://localhost:$API_PORT" -ForegroundColor Green
} else {
    Write-Host "      WARNING: API server port not detected yet" -ForegroundColor Yellow
}
Write-Host ""

# Step 4: Launch Test Client
Write-Host "[4/4] Launching interactive test client..." -ForegroundColor Yellow
Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  System Ready!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  Edge:       Port $PORT" -ForegroundColor White
Write-Host "  API Server: http://localhost:$API_PORT" -ForegroundColor White
Write-Host "  Test Client: Running below" -ForegroundColor White
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Press Ctrl+C to stop all services" -ForegroundColor Yellow
Write-Host ""

# Run the test client in the foreground
try {
    node src/test-api.js
} finally {
    # Cleanup: Stop API server and Edge when test client exits
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Yellow
    Write-Host "  Shutting down..." -ForegroundColor Yellow
    Write-Host "=========================================" -ForegroundColor Yellow

    Write-Host "Stopping API server..." -ForegroundColor Gray
    Stop-Job -Job $apiJob -ErrorAction SilentlyContinue
    Remove-Job -Job $apiJob -ErrorAction SilentlyContinue

    Write-Host "Closing Edge..." -ForegroundColor Gray
    Stop-Process -Id $edgeProcess.Id -Force -ErrorAction SilentlyContinue

    Write-Host "Cleanup complete." -ForegroundColor Green
}
