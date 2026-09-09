; NSIS hooks for the Aether installer.
;
; Only one job, and it is not optional: release the WinDivert kernel driver
; before touching files.
;
; Windows locks the image of a loaded kernel driver, so `WinDivert64.sys` cannot
; be overwritten while the WinDivert service is running -- the installer stops
; with "Error opening file for writing" and, if the user clicks Ignore, leaves a
; new executable beside an old driver.
;
; The driver gets loaded by Aether's own startup check: probing WinDivert means
; calling WinDivertOpen, which creates and starts the service, and closing the
; handle afterwards does not unload it. So on any machine that has run Aether
; once, the file is locked by the time the next update installs.
;
; Stopping is not quite enough either. The service registration points at a
; specific path and survives an uninstall, so it is deleted as well; WinDivert
; recreates it on the next open.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Releasing the WinDivert driver..."
  nsExec::ExecToLog 'sc.exe stop WinDivert'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete WinDivert'
  Pop $0
  ; Unloading is asynchronous; give the kernel a moment to drop the file lock.
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Releasing the WinDivert driver..."
  nsExec::ExecToLog 'sc.exe stop WinDivert'
  Pop $0
  ; Otherwise the service is left registered against a path that is about to
  ; stop existing.
  nsExec::ExecToLog 'sc.exe delete WinDivert'
  Pop $0
  Sleep 800
!macroend
