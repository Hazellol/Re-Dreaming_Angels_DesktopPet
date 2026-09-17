# 覆盖窗口模拟：一个最大化的普通窗口（非置顶），用于复现"桌宠被最大化窗口完全覆盖"
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'COVER-WINDOW'
$f.WindowState = 'Maximized'
$f.BackColor = '#224466'
$f.TopMost = $false
[System.Windows.Forms.Application]::Run($f)
