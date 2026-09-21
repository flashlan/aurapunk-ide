param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [Parameter(Mandatory = $true)] [string] $IdentityName,
  [Parameter(Mandatory = $true)] [string] $Publisher,
  [Parameter(Mandatory = $true)] [string] $PublisherDisplayName,
  [string] $ApplicationId = 'App',
  [string] $Version,
  [string] $OutputDirectory = 'msstore-output'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauri = Join-Path $repo 'crates\tauri-app'
$binary = Join-Path $repo "target\$Target\release\aurapunk-tauri.exe"

if (-not (Test-Path $binary)) { throw "Tauri binary not found: $binary" }
if (-not $Version) { $Version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+([-.].*)?$') { throw "Invalid version: $Version" }
$msixVersion = (($Version -replace '-.*$', '') + '.0')
$arch = if ($Target -like 'aarch64-*') { 'arm64' } elseif ($Target -like 'x86_64-*') { 'x64' } else { throw "Unsupported target: $Target" }

$out = Join-Path $repo $OutputDirectory
$stage = Join-Path $out "stage-$arch"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage 'Assets'), (Join-Path $stage 'resources') | Out-Null

Copy-Item $binary (Join-Path $stage 'aurapunk-tauri.exe')
Copy-Item (Join-Path $tauri 'resources\*') (Join-Path $stage 'resources') -Recurse -Force

$icons = Join-Path $tauri 'icons'
foreach ($icon in 'StoreLogo.png', 'Square44x44Logo.png', 'Square71x71Logo.png', 'Square150x150Logo.png', 'Square310x310Logo.png') {
  Copy-Item (Join-Path $icons $icon) (Join-Path $stage "Assets\$icon")
}
# The project has no dedicated wide tile; reuse the 310px artwork at the exact
# dimensions Store validation expects, without changing the application's icon.
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile((Join-Path $icons 'Square310x310Logo.png'))
$wide = New-Object System.Drawing.Bitmap 310, 150
$graphics = [System.Drawing.Graphics]::FromImage($wide)
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.DrawImage($source, 80, 0, 150, 150)
$wide.Save((Join-Path $stage 'Assets\Wide310x150Logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $wide.Dispose(); $source.Dispose()

$manifest = Get-Content (Join-Path $tauri 'msstore\AppxManifest.xml.template') -Raw
$manifest = $manifest.Replace('__IDENTITY_NAME__', $IdentityName).Replace('__PUBLISHER__', $Publisher).Replace('__PUBLISHER_DISPLAY_NAME__', $PublisherDisplayName).Replace('__APPLICATION_ID__', $ApplicationId).Replace('__VERSION__', $msixVersion).Replace('__ARCH__', $arch)
[System.IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

$makeAppx = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\MakeAppx.exe' | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $makeAppx) { throw 'MakeAppx.exe was not found. Install the Windows 10 SDK.' }

New-Item -ItemType Directory -Force -Path $out | Out-Null
$msix = Join-Path $out "Aurapunk-IDE-$Version-$arch.msix"
& $makeAppx pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE" }
Write-Host "Created $msix"
