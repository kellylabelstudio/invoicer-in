!macro NSIS_HOOK_POSTINSTALL
  ; Tauri skips new shortcuts in update mode. Restore a missing or stale
  ; per-user Start menu entry, while honoring an explicit /NS install.
  ${If} $NoShortcutMode != 1
    Push $0
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 != 1
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend
