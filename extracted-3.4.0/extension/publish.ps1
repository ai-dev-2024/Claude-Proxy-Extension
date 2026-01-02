# Publish Script
# Usage: .\publish.ps1

# Load .env variables
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        $name, $value = $_.Split('=', 2)
        Set-Content env:\$name $value
    }
}

$token = $env:OVSX_TOKEN

if (-not $token) {
    Write-Error "Token not found in .env or environment variables."
    exit 1
}

# Package
Write-Host "Packaging Extension..."
npx -y @vscode/vsce package --allow-missing-repository

# Publish
Write-Host "Publishing to Open VSX..."
npx -y ovsx publish -p $token

Write-Host "Done!"
