' One-click silent launcher for Dreaming Angels desktop pet (DESKTOP mode).
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run Chr(34) & base & "\start-dreaming-angels.cmd" & Chr(34), 0, False
