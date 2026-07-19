param(
  [Parameter(Mandatory=$true)][string]$Backup,
  [string]$Current = (Split-Path -Parent $PSScriptRoot),
  [Parameter(Mandatory=$true)][string]$FilesCsv
)

$Files = $FilesCsv -split ','

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-Exports([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  $names = New-Object System.Collections.Generic.List[string]
  $patterns = @(
    'export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)',
    'export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)',
    'export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)',
    'export\s+(?:abstract\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)',
    'export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)',
    'export\s+enum\s+([A-Za-z_$][A-Za-z0-9_$]*)',
    'export\s+default\s+(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)'
  )
  foreach ($p in $patterns) {
    $matches = [regex]::Matches($text, $p)
    foreach ($m in $matches) { [void]$names.Add($m.Groups[1].Value) }
  }
  return ($names | Sort-Object -Unique)
}

foreach ($f in $Files) {
  $bp = Join-Path $Backup  $f
  $cp = Join-Path $Current $f
  $bExp = Get-Exports $bp
  $cExp = Get-Exports $cp
  $onlyCurrent = $cExp | Where-Object { $_ -notin $bExp }
  $onlyBackup  = $bExp | Where-Object { $_ -notin $cExp }
  Write-Host ("=== {0} ===" -f $f)
  Write-Host ("  backup exports  : {0}" -f $bExp.Count)
  Write-Host ("  current exports : {0}" -f $cExp.Count)
  if ($onlyCurrent.Count -gt 0) {
    Write-Host ("  only in current : {0}" -f ($onlyCurrent -join ', '))
  }
  if ($onlyBackup.Count -gt 0) {
    Write-Host ("  only in backup  : {0}" -f ($onlyBackup -join ', '))
  }
  Write-Host ""
}
