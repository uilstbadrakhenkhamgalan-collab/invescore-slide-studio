Set-Location -Path $PSScriptRoot
Compress-Archive -Path "manifest.json", "color.png", "outline.png" -DestinationPath "slide-studio-teams.zip" -Force
Write-Host "slide-studio-teams.zip created successfully."
