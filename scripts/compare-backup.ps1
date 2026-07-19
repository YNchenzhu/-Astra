param(
  [Parameter(Mandatory=$true)][string]$Backup,
  [string]$Current = (Split-Path -Parent $PSScriptRoot),
  [string]$Roots = 'electron'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rootList = $Roots -split ','

$excludeDirs = @('node_modules','dist','dist-electron','.git','.claude','build','bundled-lsp','release','out','coverage','.vite')

function Should-Skip([string]$rel) {
  foreach ($d in $excludeDirs) {
    if ($rel -like "$d\*" -or $rel -like "*\$d\*") { return $true }
  }
  return $false
}

function Collect-Map([string]$baseDir, [string[]]$subs) {
  $map = @{}
  foreach ($r in $subs) {
    $root = Join-Path $baseDir $r
    if (-not (Test-Path -LiteralPath $root)) { Write-Host ("  skip(missing): {0}" -f $root); continue }
    $files = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($baseDir.Length).TrimStart('\')
      if (Should-Skip $rel) { continue }
      $map[$rel] = @{ full = $f.FullName; size = [int64]$f.Length }
    }
  }
  return ,$map
}

Write-Host "Scanning backup..."
$bMap = Collect-Map $Backup  $rootList
Write-Host ("  backup files  = {0}" -f $bMap.Count)

Write-Host "Scanning current..."
$cMap = Collect-Map $Current $rootList
Write-Host ("  current files = {0}" -f $cMap.Count)

$onlyBackup  = @()
$onlyCurrent = @()
$differList  = @()
$sameCount   = 0

foreach ($k in $bMap.Keys) {
  if (-not $cMap.ContainsKey($k)) { $onlyBackup += $k; continue }
  $bf = $bMap[$k]; $cf = $cMap[$k]
  if ($bf.size -ne $cf.size) {
    $differList += [pscustomobject]@{ path=$k; backup_size=$bf.size; current_size=$cf.size; delta=($cf.size - $bf.size) }
    continue
  }
  $bh = (Get-FileHash -LiteralPath $bf.full -Algorithm SHA1).Hash
  $ch = (Get-FileHash -LiteralPath $cf.full -Algorithm SHA1).Hash
  if ($bh -ne $ch) {
    $differList += [pscustomobject]@{ path=$k; backup_size=$bf.size; current_size=$cf.size; delta=0 }
  } else { $sameCount++ }
}
foreach ($k in $cMap.Keys) {
  if (-not $bMap.ContainsKey($k)) { $onlyCurrent += $k }
}

$differSorted = $differList | Sort-Object { [math]::Abs($_.delta) } -Descending

$result = [ordered]@{
  only_in_backup  = ($onlyBackup  | Sort-Object)
  only_in_current = ($onlyCurrent | Sort-Object)
  differ          = $differSorted
  same            = $sameCount
}

$out = "$Current\docs\backup-compare-report.json"
$result | ConvertTo-Json -Depth 6 | Out-File -LiteralPath $out -Encoding utf8

Write-Host ""
Write-Host ("only_in_backup  : {0}" -f $onlyBackup.Count)
Write-Host ("only_in_current : {0}" -f $onlyCurrent.Count)
Write-Host ("differ          : {0}" -f $differList.Count)
Write-Host ("same            : {0}" -f $sameCount)
Write-Host ""
Write-Host "Top 30 files where CURRENT is SMALLER than backup (likely content deleted):"
$differSorted | Where-Object { $_.delta -lt 0 } | Select-Object -First 30 | Format-Table path,backup_size,current_size,delta -AutoSize
Write-Host ""
Write-Host "report -> $out"
