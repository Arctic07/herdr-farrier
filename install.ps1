# Farrier installer for Windows.
#   powershell -ExecutionPolicy Bypass -File install.ps1              install everything
#   powershell -ExecutionPolicy Bypass -File install.ps1 --list       what there is
#   powershell -ExecutionPolicy Bypass -File install.ps1 --dry-run    print, touch nothing
#   powershell -ExecutionPolicy Bypass -File install.ps1 --update     only what is installed
#   powershell -ExecutionPolicy Bypass -File install.ps1 --remove     take it all back out
#   powershell -ExecutionPolicy Bypass -File install.ps1 --keys       add the layout's keys
#   ... farrier-mod                                                  only these ids
#
# Copies real files into the Herdr home, never symlinks: Herdr's watcher ignores
# paths outside it. Files are replaced in place and kept under
# <home>/backup/<time>/; a mod folder is staged beside its destination and moved
# into place in one rename, so an open Herdr never sees a half-copied mod.
# Everything is validated before anything is written: ids, destinations, the
# names Herdr ships (reserved.txt), the JSON, and the mods a layout references.

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
if (-not $Root) {
  Write-Host "Run this from its file: powershell -ExecutionPolicy Bypass -File install.ps1"
  exit 1
}

$Argv = @($args | ForEach-Object { [string]$_ })
$DryRun = $Argv -contains "--dry-run"
$Update = $Argv -contains "--update"
$Remove = $Argv -contains "--remove"
$WantList = $Argv -contains "--list"
$WantKeys = $Argv -contains "--keys"
$Select = @($Argv | Where-Object { $_ -notin @("--dry-run", "--update", "--remove", "--list", "--keys", "-y") })

$Version = (Get-Content -LiteralPath (Join-Path $Root "VERSION") -Raw -Encoding UTF8).Trim()
Write-Host "Farrier $Version"

$Fail = {
  param($message)
  Write-Host $message
  Write-Host "Nothing was written."
  exit 1
}

# ---- catalogue --------------------------------------------------------------
$Rows = @()
foreach ($line in Get-Content -LiteralPath (Join-Path $Root "install.tsv") -Encoding UTF8) {
  if (-not $line.Trim() -or $line.StartsWith("#")) { continue }
  $parts = $line -split "`t"
  $Rows += [pscustomobject]@{
    Id   = $parts[0]
    Kind = if ($parts.Count -gt 1) { $parts[1] } else { "" }
    Src  = if ($parts.Count -gt 2) { $parts[2] } else { "" }
    Dest = if ($parts.Count -gt 3) { $parts[3] } else { "" }
    Desc = if ($parts.Count -gt 4) { $parts[4] } else { "" }
  }
}

$LegacyTheme = "themes/farrier.json"
$ThemeId = "farrier-theme"
$LayoutId = "farrier-layout"
$ModId = "farrier-mod"

$Reserved = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $Root "reserved.txt") -Encoding UTF8) {
  if (-not $line.Trim() -or $line.StartsWith("#")) { continue }
  $parts = $line -split "`t"
  if ($parts.Count -ge 2) { $Reserved[($parts[0] + ":" + $parts[1])] = $true }
}

# A theme named like a layout is that layout's own in Herdr: Settings offers it
# only there. Farrier's themes stay selectable in every layout.
$LayoutNames = @($Rows | Where-Object { $_.Kind -eq "layout" } | ForEach-Object { [System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileName($_.Dest.TrimEnd("/"))) })
foreach ($key in $Reserved.Keys) { if ($key.StartsWith("layout:")) { $LayoutNames += $key.Substring("layout:".Length) } }

# ---- validation, before anything is written ---------------------------------
$seen = @{}
foreach ($row in $Rows) {
  if (-not $row.Id -or -not $row.Kind -or -not $row.Src -or -not $row.Dest) { & $Fail "install.tsv: a row needs id, kind, src and dest: $($row.Id)" }
  if (@("layout", "theme", "mod", "file") -notcontains $row.Kind) { & $Fail "install.tsv: $($row.Id) has an unknown kind: $($row.Kind)" }
  if ($seen.ContainsKey($row.Id)) { & $Fail "install.tsv: $($row.Id) appears twice" }
  $seen[$row.Id] = $true

  $name = [System.IO.Path]::GetFileName($row.Dest.TrimEnd("/"))
  $place = $row.Dest.Substring(0, $row.Dest.Length - $name.Length)
  $expected = @("layouts/", "themes/")
  if ($row.Kind -eq "layout") { $expected = @("layouts/") }
  if ($row.Kind -eq "theme") { $expected = @("themes/") }
  if ($row.Kind -eq "mod") { $expected = @("mods/") }
  if ($expected -notcontains $place) { & $Fail "install.tsv: $($row.Id) goes to $($row.Dest), which is the wrong place for a $($row.Kind)" }
  $reservedName = $name
  if ($row.Kind -eq "layout" -or $row.Kind -eq "theme") { $reservedName = [System.IO.Path]::GetFileNameWithoutExtension($name) }
  if ($row.Kind -ne "file" -and $Reserved.ContainsKey($row.Kind + ":" + $reservedName)) {
    & $Fail "install.tsv: '$reservedName' is a name Herdr ships; pick another one (reserved.txt)"
  }
  if ($row.Kind -eq "theme") {
    $themeName = [System.IO.Path]::GetFileNameWithoutExtension($name)
    if ($LayoutNames -contains $themeName) {
      & $Fail "install.tsv: theme '$themeName' has a layout's name; Herdr would offer it only in that layout"
    }
  }

  $source = Join-Path $Root $row.Src
  if (-not (Test-Path -LiteralPath $source)) { & $Fail "install.tsv: $($row.Id) points at a missing source: $($row.Src)" }

  if ($row.Kind -eq "mod") {
    foreach ($file in @("main.js", "mod.json")) {
      if (-not (Test-Path -LiteralPath (Join-Path $source $file))) { & $Fail "$($row.Src) has no $file" }
    }
  }
  if ($row.Kind -eq "layout" -or $row.Kind -eq "theme") {
    try { $json = Get-Content -LiteralPath $source -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { & $Fail "$($row.Src) is not valid JSON: $($_.Exception.Message)" }
  }
  if ($row.Kind -eq "theme") {
    foreach ($key in @("background", "foreground", "selection", "ansi")) {
      if (-not $json.$key) { & $Fail "$($row.Src) has no '$key'" }
    }
    if (@($json.ansi).Count -ne 16) { & $Fail "$($row.Src): ansi needs 16 colors, has $(@($json.ansi).Count)" }
    foreach ($color in @($json.ansi)) { if ($color -notmatch "^#[0-9a-fA-F]{6}$") { & $Fail "$($row.Src): '$color' is not #rrggbb" } }
    if ($json.colors) {
      foreach ($p in $json.colors.PSObject.Properties) { if ($p.Value -notmatch "^#[0-9a-fA-F]{6}$") { & $Fail "$($row.Src): colors.$($p.Name) is not #rrggbb" } }
    }
  }
  if ($row.Kind -eq "layout") {
    if (-not $json.id -or -not $json.type) { & $Fail "$($row.Src) needs a root id and type" }
    if ($json.preview -and -not (Test-Path -LiteralPath (Join-Path $Root $json.preview))) { & $Fail "$($row.Src): preview '$($json.preview)' is missing" }
  }
}

# A layout may reference only its own mods or the ones Herdr ships.
function Get-ModRefs($node) {
  $found = @()
  if ($null -eq $node) { return $found }
  if ($node.content -and $node.content.mod) { $found += $node.content.mod }
  if ($node.terminal_menu) { $found += $node.terminal_menu }
  if ($node.children) { foreach ($child in $node.children) { $found += Get-ModRefs $child } }
  return $found
}
$OwnMods = @($Rows | Where-Object { $_.Kind -eq "mod" } | ForEach-Object { [System.IO.Path]::GetFileName($_.Dest.TrimEnd("/")) })
foreach ($row in $Rows) {
  if ($row.Kind -ne "layout") { continue }
  $json = Get-Content -LiteralPath (Join-Path $Root $row.Src) -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($ref in (Get-ModRefs $json)) {
    if ($OwnMods -contains $ref) { continue }
    if ($Reserved.ContainsKey("mod:" + $ref)) { continue }
    & $Fail "$($row.Src) uses mod '$ref', which is neither Farrier's nor a mod Herdr ships"
  }
}

# ---- selection --------------------------------------------------------------
if ($WantList) {
  foreach ($row in $Rows) { Write-Host ("  {0,-16} {1,-8} {2}" -f $row.Id, $row.Kind, $row.Desc) }
  exit 0
}

$AppHome = $env:HERDR_APP_HOME
if (-not $AppHome) { $AppHome = Join-Path $HOME ".config\herdr-app" }

if ($Select.Count -gt 0) {
  $Chosen = @($Rows | Where-Object { $Select -contains $_.Id })
  $unknown = @($Select | Where-Object { $Rows.Id -notcontains $_ })
  if ($unknown.Count -gt 0) { & $Fail ("Unknown id: " + ($unknown -join ", ") + " (see --list)") }
} else {
  $Chosen = @($Rows)
}

$Herdr = $null
$found = Get-Command herdr-app -ErrorAction SilentlyContinue
if ($found) { $Herdr = $found.Source }
if (-not $Herdr -and (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "Programs\herdr-app\herdr-app.exe"))) {
  $Herdr = Join-Path $env:LOCALAPPDATA "Programs\herdr-app\herdr-app.exe"
}
if (-not $Herdr) { & $Fail "herdr-app is not on PATH and not in $env:LOCALAPPDATA\Programs\herdr-app. Install the Herdr app first (https://herdr.dev)." }

if (-not (Test-Path -LiteralPath $AppHome -PathType Container)) { & $Fail "No Herdr home at $AppHome. Open Herdr once, or set HERDR_APP_HOME to its folder." }

if ($Update -and -not $Remove) {
  # An older install kept the theme under the layout's name. Treat it as
  # installed so --update brings the renamed theme in and then removes it.
  $Chosen = @($Chosen | Where-Object {
    (Test-Path -LiteralPath (Join-Path $AppHome $_.Dest)) -or
    ($_.Id -eq $ThemeId -and (Test-Path -LiteralPath (Join-Path $AppHome $LegacyTheme)))
  })
  if ($Chosen.Count -eq 0) { & $Fail "Nothing from Farrier is installed yet: run install.ps1 to pick." }
}

# ---- compare and write ------------------------------------------------------
function Get-SourceHash($path) {
  $Ignore = @("gpui-kit.d.ts", "herdr.d.ts", "jsconfig.json")
  if (Test-Path -LiteralPath $path -PathType Leaf) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
  $sb = New-Object System.Text.StringBuilder
  $files = Get-ChildItem -LiteralPath $path -Recurse -File | Where-Object { $Ignore -notcontains $_.Name } | Sort-Object FullName
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($path.Length).Replace("\", "/")
    [void]$sb.Append($rel + ":" + (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash + ";")
  }
  return $sb.ToString()
}

function Add-PackKeys {
  $keysPath = Join-Path $AppHome "keys.json"
  $packPath = Join-Path $Root "keys.pack.json"
  if (-not (Test-Path -LiteralPath $packPath)) { Write-Host "No keys.pack.json in this repository."; return }
  if (Test-Path -LiteralPath $keysPath) {
    try { $keys = Get-Content -LiteralPath $keysPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Write-Host "keys.json is not valid JSON: fix it or move it aside. Keys were not changed."; return }
  } else { $keys = [pscustomobject]@{} }
  if (-not $keys) { $keys = [pscustomobject]@{} }
  $pack = Get-Content -LiteralPath $packPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false
  foreach ($section in $pack.PSObject.Properties) {
    $name = $section.Name
    $have = $keys.PSObject.Properties[$name]
    if (-not $have) {
      $keys | Add-Member -MemberType NoteProperty -Name $name -Value ([pscustomobject]@{})
      $have = $keys.PSObject.Properties[$name]
    }
    foreach ($binding in $section.Value.PSObject.Properties) {
      $current = $have.Value.PSObject.Properties[$binding.Name]
      if ($current) {
        if ($current.Value -ne $binding.Value) { Write-Host ("  ! " + $binding.Name + " in " + $name + " is " + $current.Value + ", kept yours") }
        continue
      }
      $have.Value | Add-Member -MemberType NoteProperty -Name $binding.Name -Value $binding.Value
      Write-Host ("  + key " + $binding.Name + " -> " + $binding.Value + "  (" + $name + ")")
      $changed = $true
    }
  }
  if (-not $changed) { Write-Host "  = keys already bound"; return }
  if ($DryRun) { Write-Host "  (dry run: keys.json not written)"; return }
  New-Item -ItemType Directory -Path $Backup -Force | Out-Null
  if (Test-Path -LiteralPath $keysPath) { Copy-Item -LiteralPath $keysPath -Destination (Join-Path $Backup "keys.json") -Force }
  $json = $keys | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($keysPath, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("  ~ keys.json (the old one is in " + $Backup + ")")
}

function Remove-PackKeys {
  $keysPath = Join-Path $AppHome "keys.json"
  $packPath = Join-Path $Root "keys.pack.json"
  if (-not (Test-Path -LiteralPath $keysPath) -or -not (Test-Path -LiteralPath $packPath)) { return }
  try { $keys = Get-Content -LiteralPath $keysPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return }
  $pack = Get-Content -LiteralPath $packPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false
  foreach ($section in $pack.PSObject.Properties) {
    $have = $keys.PSObject.Properties[$section.Name]
    if (-not $have) { continue }
    foreach ($binding in $section.Value.PSObject.Properties) {
      $current = $have.Value.PSObject.Properties[$binding.Name]
      if (-not $current) { continue }
      if ($current.Value -ne $binding.Value) { continue }   # yours now: leave it
      $have.Value.PSObject.Properties.Remove($binding.Name)
      Write-Host ("  - key " + $binding.Name + "  (" + $section.Name + ")")
      $changed = $true
    }
    if (-not $have.Value.PSObject.Properties) { $keys.PSObject.Properties.Remove($section.Name) }
  }
  if (-not $changed) { Write-Host "  = no key of ours left"; return }
  if ($DryRun) { Write-Host "  (dry run: keys.json not written)"; return }
  New-Item -ItemType Directory -Path $Backup -Force | Out-Null
  if (Test-Path -LiteralPath $keysPath) { Copy-Item -LiteralPath $keysPath -Destination (Join-Path $Backup "keys.json") -Force }
  $json = $keys | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($keysPath, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("  ~ keys.json (the old one is in " + $Backup + ")")
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Stage = Join-Path $AppHome ".farrier-stage"
$Backup = Join-Path $AppHome ("backup\" + $Stamp)

if ($Remove) {
  $removed = 0
  foreach ($row in $Chosen) {
    $target = Join-Path $AppHome $row.Dest
    if (-not (Test-Path -LiteralPath $target)) { Write-Host ("  = " + $row.Dest + " (not there)"); continue }
    if (-not $DryRun) { Remove-Item -LiteralPath $target -Recurse -Force }
    Write-Host ("  - " + $row.Dest)
    $removed++
  }
  $legacy = Join-Path $AppHome $LegacyTheme
  if (($Select.Count -eq 0 -or $Select -contains $ThemeId) -and (Test-Path -LiteralPath $legacy)) {
    if (-not $DryRun) { Remove-Item -LiteralPath $legacy -Force }
    Write-Host ("  - " + $LegacyTheme + "  (old theme name)")
    $removed++
  }
  $KeyParts = @("farrier-layout", "farrier-mod")
  $RemoveKeysHere = ($Select.Count -eq 0) -or (@($Chosen | Where-Object { $KeyParts -contains $_.Id }).Count -gt 0)
  if ($RemoveKeysHere -and ($WantKeys -or ($removed -gt 0))) { Remove-PackKeys }
  if (-not $DryRun) {
    Write-Host ""
    Write-Host "Removed $removed of $($Chosen.Count). Switch to another layout first if Farrier is the shown one."
  }
  exit 0
}

$LayoutInstalled = Test-Path -LiteralPath (Join-Path $AppHome "layouts/farrier.json")
# An old install left the theme under the layout's name. Update the layout and
# bring the new theme with it; a theme-only update keeps the old file while the
# installed layout still names it.
if ((@($Chosen | Where-Object { $_.Id -eq $LayoutId }).Count -gt 0) -and -not (@($Chosen | Where-Object { $_.Id -eq $ThemeId }).Count -gt 0) -and (Test-Path -LiteralPath (Join-Path $AppHome $LegacyTheme))) {
  $ids = @($Chosen | ForEach-Object { $_.Id }) + $ThemeId
  $Chosen = @($Rows | Where-Object { $ids -contains $_.Id })
} else {
  $ids = @($Chosen | ForEach-Object { $_.Id })
  $Chosen = @($Rows | Where-Object { $ids -contains $_.Id })
}

if (-not $DryRun) {
  if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
  New-Item -ItemType Directory -Path $Stage -Force | Out-Null
}

$changed = 0
foreach ($row in $Chosen) {
  $source = Join-Path $Root $row.Src
  $target = Join-Path $AppHome $row.Dest
  $there = Test-Path -LiteralPath $target
  if ($there -and (Get-SourceHash $source) -eq (Get-SourceHash $target)) { Write-Host ("  = " + $row.Dest); continue }
  $changed++
  if ($DryRun) {
    if ($there) { Write-Host ("  ~ " + $row.Dest + "  (the old one is kept)") }
    else { Write-Host ("  + " + $row.Dest) }
    continue
  }

  $staged = Join-Path $Stage $row.Id
  $isFile = Test-Path -LiteralPath $source -PathType Leaf
  New-Item -ItemType Directory -Path (Split-Path -Parent $staged) -Force | Out-Null
  if ($isFile) { Copy-Item -LiteralPath $source -Destination $staged -Force }
  else { Copy-Item -LiteralPath $source -Destination $staged -Recurse -Force }

  $kept = Join-Path $Backup $row.Dest
  New-Item -ItemType Directory -Path (Split-Path -Parent $kept) -Force | Out-Null
  if ($isFile) {
    if ($there) { Copy-Item -LiteralPath $target -Destination $kept -Force }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $staged -Destination $target -Force
  } else {
    if ($there) { Move-Item -LiteralPath $target -Destination $kept -Force }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Move-Item -LiteralPath $staged -Destination $target
  }
  if ($there) { Write-Host ("  ~ " + $row.Dest) } else { Write-Host ("  + " + $row.Dest) }
}

$legacy = Join-Path $AppHome $LegacyTheme
$ThemeChosen = @($Chosen | Where-Object { $_.Id -eq $ThemeId }).Count -gt 0
$LayoutChosen = @($Chosen | Where-Object { $_.Id -eq $LayoutId }).Count -gt 0
if ($ThemeChosen -and (Test-Path -LiteralPath $legacy)) {
  if ($LayoutChosen -or -not $LayoutInstalled) {
    $changed++
    if ($DryRun) {
      Write-Host ("  - " + $LegacyTheme + "  (old theme name)")
    } else {
      New-Item -ItemType Directory -Path (Join-Path $Backup "themes") -Force | Out-Null
      Copy-Item -LiteralPath $legacy -Destination (Join-Path $Backup $LegacyTheme) -Force
      Remove-Item -LiteralPath $legacy -Force
      Write-Host ("  - " + $LegacyTheme + "  (old theme name)")
    }
  } else {
    Write-Host ("  ! " + $LegacyTheme + " kept: the installed layout still names it")
  }
}

if (-not $DryRun -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force }

$failed = @()
if (-not $DryRun) {
  foreach ($row in $Chosen) {
    if ($row.Kind -ne "mod") { continue }
    & $Herdr check (Join-Path $AppHome $row.Dest) | Out-Host
    if ($LASTEXITCODE -ne 0) { $failed += $row.Id }
  }
}

if ($WantKeys -and (@($Chosen | Where-Object { $_.Id -eq $LayoutId }).Count -gt 0) -and (@($Chosen | Where-Object { $_.Id -eq $ModId }).Count -gt 0)) {
  Add-PackKeys
}

if (-not $DryRun) {
  Write-Host ""
  if ($changed -eq 0) {
    Write-Host "Everything was already up to date."
  } elseif (@($Chosen | Where-Object { $_.Id -eq $LayoutId }).Count -gt 0) {
    Write-Host "Next: open Herdr and pick farrier in Settings > Layout (Ctrl+Shift+L cycles layouts)."
  }
  if (-not $WantKeys -and (@($Chosen | Where-Object { $_.Id -eq $LayoutId }).Count -gt 0) -and (@($Chosen | Where-Object { $_.Id -eq $ModId }).Count -gt 0)) {
    Write-Host "      Add this layout's key with: install.ps1 --keys"
  }
  if (Test-Path -LiteralPath $Backup) { Write-Host "Replaced files are in $Backup" }
}

if ($failed.Count -gt 0) {
  Write-Host ("herdr-app check failed for: " + ($failed -join ", "))
  exit 1
}
if (-not $DryRun) { Write-Host "Done. Herdr reloads mods live." }
