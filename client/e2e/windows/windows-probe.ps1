# Read-only. Run: powershell -ExecutionPolicy Bypass -File client\e2e\windows\windows-probe.ps1
# Writes tolktak-probe.txt to the Desktop.
$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'tolktak-probe.txt'
function Section($t) { "`n===== $t =====" }
& {
  Section 'Windows'
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  "Product: $($cv.ProductName)  DisplayVersion: $($cv.DisplayVersion)  Build: $($cv.CurrentBuild).$($cv.UBR)"
  "Edition: $($cv.EditionID)  Arch: $env:PROCESSOR_ARCHITECTURE"
  Section 'CPU / RAM'
  Get-CimInstance Win32_Processor | ForEach-Object { "$($_.Name)  cores=$($_.NumberOfCores) threads=$($_.NumberOfLogicalProcessors)" }
  "RAM GB: {0:N1}" -f ((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
  Section 'GPU'
  Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)  driver=$($_.DriverVersion) ($($_.DriverDate))  $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)@$($_.CurrentRefreshRate)Hz" }
  "Hardware-accelerated GPU scheduling (HwSchMode): " + (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers').HwSchMode
  Section 'Displays'
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.DeviceName) $($_.Bounds.Width)x$($_.Bounds.Height) primary=$($_.Primary)" }
  Section 'Audio devices'
  Get-CimInstance Win32_SoundDevice | ForEach-Object { "$($_.Name) [$($_.Status)]" }
  Section 'Tools'
  foreach ($t in 'node','npm','git','go','winget') { $c = Get-Command $t; "{0,-7} {1}" -f $t, ($(if ($c) { $c.Source } else { 'not found' })) }
} *>&1 | Out-File -Encoding utf8 $out
Write-Host "Done: $out"
