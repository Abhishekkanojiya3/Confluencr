<#
.SYNOPSIS
  Denies Windows Graphics Capture access and browser screen sharing.

.DESCRIPTION
  This applies machine policies. Run PowerShell as Administrator.

  It blocks:
    - Windows apps using the Windows Graphics Capture API
    - Microsoft Edge tab/window/display capture
    - Windows Snipping Tool screen recording

  It cannot guarantee blocking every native Win32 recorder (for example OBS)
  because those programs may capture through their own implementation or driver.

  Use -Undo to remove the policies created by this script.
#>

[CmdletBinding()]
param(
    [switch]$Undo
)

$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    throw 'Run this script from an elevated PowerShell window (Run as administrator).'
}

$policyRoots = @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge',
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Policies\SnippingTool'
)

if ($Undo) {
    # Remove only the values created by this script; preserve other policy values.
    $values = @(
        @{ Path = $policyRoots[0]; Name = 'LetAppsAccessGraphicsCaptureProgrammatic' },
        @{ Path = $policyRoots[1]; Name = 'ScreenCaptureAllowed' },
        @{ Path = $policyRoots[1]; Name = 'WindowCaptureAllowed' },
        @{ Path = $policyRoots[1]; Name = 'TabCaptureAllowed' },
        @{ Path = $policyRoots[2]; Name = 'AllowScreenRecorder' }
    )

    foreach ($item in $values) {
        if (Test-Path $item.Path) {
            Remove-ItemProperty -Path $item.Path -Name $item.Name -ErrorAction SilentlyContinue
        }
    }

    Write-Host 'Screen-capture policies removed. Restart affected apps.'
    exit 0
}

New-Item -Path $policyRoots[0] -Force | Out-Null
New-Item -Path $policyRoots[1] -Force | Out-Null
New-Item -Path $policyRoots[2] -Force | Out-Null

# 0 = user controlled, 1 = force allow, 2 = force deny.
New-ItemProperty -Path $policyRoots[0] -Name 'LetAppsAccessGraphicsCaptureProgrammatic' -PropertyType DWord -Value 2 -Force | Out-Null

# Microsoft Edge: deny display, window, and tab capture APIs.
New-ItemProperty -Path $policyRoots[1] -Name 'ScreenCaptureAllowed' -PropertyType DWord -Value 0 -Force | Out-Null
New-ItemProperty -Path $policyRoots[1] -Name 'WindowCaptureAllowed' -PropertyType DWord -Value 0 -Force | Out-Null
New-ItemProperty -Path $policyRoots[1] -Name 'TabCaptureAllowed' -PropertyType DWord -Value 0 -Force | Out-Null

# Disable recording in Windows Snipping Tool.
New-ItemProperty -Path $policyRoots[2] -Name 'AllowScreenRecorder' -PropertyType DWord -Value 0 -Force | Out-Null

Write-Host 'Screen-capture policies applied.'
Write-Host 'Restart Edge, Snipping Tool, and other affected apps (or restart Windows).'
Write-Host 'This does not guarantee blocking native Win32 recorders that use their own capture path.'
