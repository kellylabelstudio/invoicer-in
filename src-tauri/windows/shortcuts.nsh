!define LEGACY_PRODUCT_KEY "Software\Kelly Label Studio\Invoicer-in"
!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Invoicer-in"
Var LegacyInstallDir

!macro NSIS_HOOK_PREINSTALL
  ; Install over a verified beta 2–4 installation so the renamed app keeps
  ; its existing location. A different explicit destination takes precedence.
  ReadRegStr $LegacyInstallDir SHCTX "${LEGACY_PRODUCT_KEY}" ""
  ReadRegStr $0 SHCTX "${LEGACY_UNINSTALL_KEY}" "MainBinaryName"
  ReadRegStr $1 SHCTX "${LEGACY_UNINSTALL_KEY}" "UninstallString"
  ReadRegStr $2 SHCTX "${MANUPRODUCTKEY}" ""
  ClearErrors
  ${If} $LegacyInstallDir != ""
  ${AndIf} $0 == "${MAINBINARYNAME}.exe"
  ${AndIf} $1 == '$\"$LegacyInstallDir\uninstall.exe$\"'
  ${AndIf} ${FileExists} "$LegacyInstallDir\${MAINBINARYNAME}.exe"
  ${AndIf} ${FileExists} "$LegacyInstallDir\uninstall.exe"
    ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    ${AndIf} $2 == ""
      StrCpy $INSTDIR $LegacyInstallDir
      SetOutPath $INSTDIR
    ${EndIf}
  ${Else}
    StrCpy $LegacyInstallDir ""
  ${EndIf}
!macroend

!macro RenameLegacyShortcut folder
  !insertmacro IsShortcutTarget "${folder}\Invoicer-in.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    ${If} ${FileExists} "${folder}\${PRODUCTNAME}.lnk"
      !insertmacro IsShortcutTarget "${folder}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 1
        Delete "${folder}\Invoicer-in.lnk"
      ${EndIf}
    ${Else}
      Rename "${folder}\Invoicer-in.lnk" "${folder}\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend

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
    ${If} $LegacyInstallDir == $INSTDIR
      !insertmacro RenameLegacyShortcut "$SMPROGRAMS"
      !insertmacro RenameLegacyShortcut "$DESKTOP"
    ${EndIf}
    Pop $0
  ${EndIf}
  ${If} $LegacyInstallDir == $INSTDIR
    ; The new uninstaller already owns these files. Drop only old metadata.
    DeleteRegKey SHCTX "${LEGACY_UNINSTALL_KEY}"
    DeleteRegKey SHCTX "${LEGACY_PRODUCT_KEY}"
  ${EndIf}
!macroend
