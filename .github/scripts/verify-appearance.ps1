param([long] $HandleValue, [string] $OutputDirectory)
$ErrorActionPreference = 'Stop'
$WindowHandle = [IntPtr]$HandleValue
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InvoicerAppearanceCheck {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
$null = [InvoicerAppearanceCheck]::SetProcessDpiAwarenessContext([IntPtr](-4))
$null = [InvoicerAppearanceCheck]::SetForegroundWindow($WindowHandle)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
function Activate-InvoicerButton([string] $Name) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $button = $null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($button) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $button) { throw "The accessible $Name button is missing." }
  try { $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  catch { $button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle() }
}
function Get-DwmAttribute([uint32] $Attribute) {
  [int] $value = 0
  if ([InvoicerAppearanceCheck]::DwmGetWindowAttribute($WindowHandle, $Attribute, [ref]$value, 4) -lt 0) { return -1 }
  return $value
}
function Wait-DwmAttribute([uint32] $Attribute, [int] $Expected) {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ((Get-DwmAttribute $Attribute) -eq $Expected) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "DWM attribute $Attribute did not become $Expected."
}
function Save-InvoicerScreenshot([string] $Name) {
  Start-Sleep -Milliseconds 400
  $bounds = New-Object InvoicerAppearanceCheck+Rect
  if (-not [InvoicerAppearanceCheck]::GetWindowRect($WindowHandle, [ref]$bounds)) { throw 'Could not capture the app bounds.' }
  $bitmap = [System.Drawing.Bitmap]::new($bounds.Right-$bounds.Left, $bounds.Bottom-$bounds.Top)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path $OutputDirectory $Name), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Wait-DwmAttribute 38 3
Write-Host 'Native Desktop Acrylic is active.'
Save-InvoicerScreenshot 'light-glass.png'
Activate-InvoicerButton 'Dark'
Wait-DwmAttribute 20 1
Wait-DwmAttribute 38 3
Save-InvoicerScreenshot 'dark-glass.png'
Activate-InvoicerButton 'Glass appearance'
Wait-DwmAttribute 38 1
Write-Host 'Performance mode cleared Native Desktop Acrylic.'
Save-InvoicerScreenshot 'dark-performance.png'
Activate-InvoicerButton 'Glass appearance'
Wait-DwmAttribute 38 3
Activate-InvoicerButton 'Light'
Wait-DwmAttribute 20 0
Write-Host 'Glass, Performance and theme controls passed through Windows accessibility.'
