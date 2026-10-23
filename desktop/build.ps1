# Builds dist\video-to-gif.exe (Windows, amd64).
# Requires Go and go-winres: go install github.com/tc-hib/go-winres@latest
# Kept ASCII-only so Windows PowerShell 5.1 reads it correctly without a BOM.
param(
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    # Copy the web app into .\web (embedded into the exe) and swap the CDN font for the bundled one.
    go run ./tools/prepare
    if ($LASTEXITCODE -ne 0) { throw "prepare failed" }

    $winres = Join-Path (go env GOPATH) "bin\go-winres.exe"
    & $winres make --in winres\winres.json --out rsrc --arch amd64 --product-version $Version --file-version $Version
    if ($LASTEXITCODE -ne 0) { throw "go-winres failed" }

    go test ./...
    if ($LASTEXITCODE -ne 0) { throw "tests failed" }

    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -trimpath -ldflags "-s -w -H windowsgui" -o dist\video-to-gif.exe .
    if ($LASTEXITCODE -ne 0) { throw "go build failed" }

    Get-Item dist\video-to-gif.exe | Select-Object Name, Length, LastWriteTime
}
finally {
    Pop-Location
}
