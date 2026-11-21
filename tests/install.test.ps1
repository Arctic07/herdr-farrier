# Checks install.ps1 against throwaway Herdr homes.
#   powershell -ExecutionPolicy Bypass -File tests/install.test.ps1
#   pwsh -NoProfile -File tests/install.test.ps1
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $PSScriptRoot
$install = Join-Path $here "install.ps1"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("farrier-ps-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$oldHome = $env:HERDR_APP_HOME
$oldPath = $env:PATH
$pass = 0
function Ok([string]$message) { $script:pass++; Write-Host "  ok  $message" }
function Fail([string]$message) { throw "FAIL: $message" }
function FreshHome {
  $HerdrHome = Join-Path $tmp ("home-" + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $HerdrHome -Force | Out-Null
  $env:HERDR_APP_HOME = $HerdrHome
  return $HerdrHome
}
function Run([string[]]$arguments) {
  $output = & $shell -NoProfile -ExecutionPolicy Bypass -File $install @arguments 2>&1
  $code = $LASTEXITCODE
  $output | Write-Host
  return $code
}
function RunOutput([string[]]$arguments) {
  $output = & $shell -NoProfile -ExecutionPolicy Bypass -File $install @arguments 2>&1
  $output | Write-Host
  return ($output | Out-String)
}
function Set-LayoutTheme([string]$HerdrHome, [string]$theme) {
  $path = Join-Path $HerdrHome "layouts/farrier.json"
  $text = (Get-Content -LiteralPath $path -Raw) -replace '"theme": "[^"]+"', ('"theme": "' + $theme + '"')
  [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Has-OldTheme([string]$HerdrHome) {
  return [bool](Get-ChildItem -LiteralPath (Join-Path $HerdrHome "backup") -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'themes[/\\]farrier\.json$' })
}

try {
  $stubDir = Join-Path $tmp "bin"
  New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    $stub = Join-Path $stubDir "herdr-app.cmd"
    Set-Content -LiteralPath $stub -Value "@exit /b 0" -Encoding ASCII
  } else {
    $stub = Join-Path $stubDir "herdr-app"
    Set-Content -LiteralPath $stub -Value "#!/bin/sh`nexit 0"
    & chmod +x $stub
  }
  $env:PATH = $stubDir + [IO.Path]::PathSeparator + $oldPath
  $shell = if ($PSVersionTable.PSEdition -eq "Core") { Join-Path $PSHOME "pwsh" } else { Join-Path $PSHOME "powershell.exe" }

  # ---- a fresh install writes what install.tsv lists -------------------------
  $HerdrHome = FreshHome
  if ((Run @("-y")) -ne 0) { Fail "fresh install exited non-zero" }
  foreach ($path in @("themes/farrier-charcoal.json", "layouts/farrier.json", "layouts/farrier.svg", "mods/farrier/main.js", "mods/farrier-git/main.js", "mods/farrier-files/main.js")) {
    if (-not (Test-Path -LiteralPath (Join-Path $HerdrHome $path))) { Fail "fresh install missed $path" }
  }
  Ok "fresh install writes every row"

  # ---- a second run changes nothing ------------------------------------------
  $out = Run @("--dry-run", "-y")
  if ($out -ne 0) { Fail "second dry run exited non-zero" }
  Ok "second run is a no-op"

  # ---- an old layout and theme name are migrated on update --------------------
  $HerdrHome = FreshHome
  if ((Run @("-y")) -ne 0) { Fail "install before migration failed" }
  Set-LayoutTheme $HerdrHome "farrier"
  Move-Item -LiteralPath (Join-Path $HerdrHome "themes/farrier-charcoal.json") -Destination (Join-Path $HerdrHome "themes/farrier.json")
  if ((Run @("--update", "-y")) -ne 0) { Fail "migration update exited non-zero" }
  if (-not (Test-Path -LiteralPath (Join-Path $HerdrHome "themes/farrier-charcoal.json"))) { Fail "update did not install the renamed theme" }
  if (Test-Path -LiteralPath (Join-Path $HerdrHome "themes/farrier.json")) { Fail "update left the old theme behind" }
  if (-not ((Get-Content -LiteralPath (Join-Path $HerdrHome "layouts/farrier.json") -Raw) -match '"theme": "farrier-charcoal"')) { Fail "update did not rewrite the layout's theme" }
  if (-not (Has-OldTheme $HerdrHome)) { Fail "update did not back up the old theme" }
  Ok "an old layout and theme name are migrated by update"

  # ---- a theme-only update keeps the old file while the layout names it ------
  $HerdrHome = FreshHome
  if ((Run @("-y")) -ne 0) { Fail "install before theme-only migration failed" }
  Set-LayoutTheme $HerdrHome "farrier"
  Move-Item -LiteralPath (Join-Path $HerdrHome "themes/farrier-charcoal.json") -Destination (Join-Path $HerdrHome "themes/farrier.json")
  if ((Run @("--update", "-y", "farrier-theme")) -ne 0) { Fail "theme-only update exited non-zero" }
  if (-not (Test-Path -LiteralPath (Join-Path $HerdrHome "themes/farrier-charcoal.json"))) { Fail "theme-only update did not install the new theme" }
  if (-not (Test-Path -LiteralPath (Join-Path $HerdrHome "themes/farrier.json"))) { Fail "theme-only update removed the old theme while the layout names it" }
  if (-not ((Get-Content -LiteralPath (Join-Path $HerdrHome "layouts/farrier.json") -Raw) -match '"theme": "farrier"')) { Fail "theme-only update rewrote the layout" }
  Ok "a theme-only update keeps the old theme"

  # ---- a layout update brings the new theme and drops the old one ------------
  if ((Run @("--update", "-y", "farrier-layout")) -ne 0) { Fail "layout update exited non-zero" }
  if (-not (Test-Path -LiteralPath (Join-Path $HerdrHome "themes/farrier-charcoal.json"))) { Fail "layout update did not install the new theme" }
  if (Test-Path -LiteralPath (Join-Path $HerdrHome "themes/farrier.json")) { Fail "layout update left the old theme behind" }
  if (-not ((Get-Content -LiteralPath (Join-Path $HerdrHome "layouts/farrier.json") -Raw) -match '"theme": "farrier-charcoal"')) { Fail "layout update did not rewrite the layout's theme" }
  if (-not (Has-OldTheme $HerdrHome)) { Fail "layout update did not back up the old theme" }
  Ok "a layout update migrates the theme"

  # ---- removing the Changes panel keeps the layout's key ---------------------
  $HerdrHome = FreshHome
  if ((Run @("--keys", "-y")) -ne 0) { Fail "install with keys failed" }
  $keysPath = Join-Path $HerdrHome "keys.json"
  $keys = Get-Content -LiteralPath $keysPath -Raw | ConvertFrom-Json
  if (-not $keys.'layout:farrier'.'ctrl-shift-a') { Fail "install did not add the layout key" }
  if ((Run @("--remove", "-y", "farrier-git")) -ne 0) { Fail "remove of the Changes panel failed" }
  if (Test-Path -LiteralPath (Join-Path $HerdrHome "mods/farrier-git")) { Fail "remove left the Changes panel behind" }
  $keys = Get-Content -LiteralPath $keysPath -Raw | ConvertFrom-Json
  if (-not $keys.'layout:farrier'.'ctrl-shift-a') { Fail "removing the Changes panel removed the layout key" }
  Ok "removing the Changes panel keeps the layout key"

  # ---- a dry run names blocks, pane headers, floating blocks and toast ------
  $HerdrHome = FreshHome
  if ((Run @("-y")) -ne 0) { Fail "install before the extra-block check failed" }
  $layoutPath = Join-Path $HerdrHome "layouts/farrier.json"
  $layout = Get-Content -LiteralPath $layoutPath -Raw | ConvertFrom-Json
  $layout.children += [pscustomobject]@{ id = "extra-test"; type = "block"; content = [pscustomobject]@{ mod = "herdr-extra-test" }; size = [pscustomobject]@{ px = 200 } }
  $layout.children += [pscustomobject]@{ id = "extra-pane"; type = "block"; content = [pscustomobject]@{ tab = "active"; pane = [pscustomobject]@{ header = [pscustomobject]@{ content = [pscustomobject]@{ mod = "herdr-extra-pane" } } } } }
  $layout | Add-Member -NotePropertyName floating -NotePropertyValue @([pscustomobject]@{ id = "extra-float"; content = [pscustomobject]@{ mod = "herdr-extra-floating" } }) -Force
  $layout | Add-Member -NotePropertyName toast -NotePropertyValue "herdr-extra-toast" -Force
  $layout | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $layoutPath -Encoding UTF8
  $text = RunOutput @("--update", "-y", "--dry-run", "farrier-layout")
  foreach ($name in @("herdr-extra-test", "herdr-extra-pane", "herdr-extra-floating", "herdr-extra-toast")) {
    if ($text -notmatch $name) { Fail "dry run did not name $name" }
  }
  if ($text -notmatch "also places mods") { Fail "dry run did not use the plural" }
  if (-not ((Get-Content -LiteralPath $layoutPath -Raw) -match "herdr-extra-test")) { Fail "dry run wrote the layout" }
  $real = RunOutput @("--update", "-y", "farrier-layout")
  if ($real -match "also places") { Fail "real update printed the dry-run note" }
  Ok "a dry run names blocks, pane headers, floating blocks and toast"

  # ---- a corrupt installed layout does not crash the dry run ----------------
  $HerdrHome = FreshHome
  if ((Run @("-y")) -ne 0) { Fail "install before the corrupt-layout check failed" }
  $layoutPath = Join-Path $HerdrHome "layouts/farrier.json"
  [IO.File]::WriteAllText($layoutPath, "{broken")
  $text = RunOutput @("--update", "-y", "--dry-run", "farrier-layout")
  if ($text -notmatch "could not be read") { Fail "dry run did not say the layout could not be read" }
  Ok "a corrupt installed layout does not crash the dry run"

  # ---- uninstall takes out what it put in, and leaves the rest ---------------
  $HerdrHome = FreshHome
  if ((Run @("-y")) -ne 0) { Fail "install before remove failed" }
  [IO.File]::WriteAllText((Join-Path $HerdrHome "settings.json"), '{"keep":true}')
  if ((Run @("--remove", "-y")) -ne 0) { Fail "remove exited non-zero" }
  foreach ($path in @("themes/farrier-charcoal.json", "layouts/farrier.json", "mods/farrier", "mods/farrier-git", "mods/farrier-files")) {
    if (Test-Path -LiteralPath (Join-Path $HerdrHome $path)) { Fail "remove left $path behind" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $HerdrHome "settings.json"))) { Fail "remove touched settings.json" }
  Ok "remove takes back only what Farrier installed"

  Write-Host ""
  Write-Host "$pass checks passed"
}
finally {
  $env:PATH = $oldPath
  if ($null -ne $oldHome) { $env:HERDR_APP_HOME = $oldHome } else { Remove-Item Env:HERDR_APP_HOME -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
