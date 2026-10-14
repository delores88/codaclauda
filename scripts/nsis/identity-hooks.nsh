; First-party CodaClauda installer hooks, MIT. Keep the legacy physical install
; root and its sibling board binding intact while changing display branding.
; These hooks require our pinned Tauri template's INSTALLIDENTITY definition.

; Snapshot in .onInit, before the previous uninstaller can remove the remembered
; registry value. GetFullPathName normalizes absolute path components; LogicLib
; string comparison is case-insensitive. Alternate aliases fail closed.
!macro CODACLAUDA_CAPTURE_INSTALL_ROOT
  ReadRegStr $CodaClaudaPreviousInstallRoot SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $CodaClaudaPreviousInstallRoot != ""
    ClearErrors
    GetFullPathName $CodaClaudaPreviousInstallRoot "$CodaClaudaPreviousInstallRoot"
    ${If} ${Errors}
      Abort "Unable to resolve the recorded CodaClauda installation folder."
    ${EndIf}
  ${EndIf}
!macroend

!macro CODACLAUDA_REQUIRE_EXISTING_INSTALL_ROOT
  Push $R8
  ${If} $CodaClaudaPreviousInstallRoot != ""
    ClearErrors
    GetFullPathName $R8 "$INSTDIR"
    ${If} ${Errors}
      Pop $R8
      Abort "Unable to resolve the selected CodaClauda installation folder."
    ${EndIf}
    ${If} $R8 != $CodaClaudaPreviousInstallRoot
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "CodaClauda must upgrade in its existing folder:$\r$\n$CodaClaudaPreviousInstallRoot$\r$\nRestart setup without choosing another folder."
      Pop $R8
      Abort
    ${EndIf}
  ${EndIf}
  Pop $R8
!macroend

!macro CodaClaudaCheckShortcut DIRECTORY
  ${If} ${FileExists} "${DIRECTORY}\${PRODUCTNAME}.lnk"
    !insertmacro IsShortcutTarget "${DIRECTORY}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R8
    ${If} $R8 != 1
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "A CodaClauda shortcut in ${DIRECTORY} points to another installation. Setup stopped without replacing that shortcut."
      Pop $R8
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Refuse a second location for an existing install: relocating the GUI would
  ; invalidate its board binding and agents' recorded CLI executable path.
  !insertmacro CODACLAUDA_REQUIRE_EXISTING_INSTALL_ROOT
  Push $R8
  !insertmacro CodaClaudaCheckShortcut "$SMPROGRAMS\$AppStartMenuFolder"
  !insertmacro CodaClaudaCheckShortcut "$SMPROGRAMS\${STARTMENUFOLDER}"
  !insertmacro CodaClaudaCheckShortcut "$SMPROGRAMS"
  !insertmacro CodaClaudaCheckShortcut "$DESKTOP"
  Pop $R8
!macroend

; Rename only a shortcut that points at this exact installation. Never delete
; or replace a shortcut owned by another application. If the new shortcut was
; already created by Tauri, remove only the matching obsolete shortcut.
!macro CodaClaudaRenameShortcut DIRECTORY
  !insertmacro IsShortcutTarget "${DIRECTORY}\${INSTALLIDENTITY}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $R8
  ${If} $R8 = 1
    ${If} ${FileExists} "${DIRECTORY}\${PRODUCTNAME}.lnk"
      !insertmacro IsShortcutTarget "${DIRECTORY}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $R8
      ${If} $R8 = 1
        Delete "${DIRECTORY}\${INSTALLIDENTITY}.lnk"
      ${EndIf}
    ${Else}
      ClearErrors
      Rename "${DIRECTORY}\${INSTALLIDENTITY}.lnk" "${DIRECTORY}\${PRODUCTNAME}.lnk"
      ${If} ${Errors}
        Abort "Unable to rename the existing CodaClauda shortcut in ${DIRECTORY}."
      ${EndIf}
      !insertmacro SetLnkAppUserModelId "${DIRECTORY}\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R8
  ; The selected folder, shipped default folder, historical root shortcut, and
  ; desktop cover the locations created by this product's released installers.
  !insertmacro CodaClaudaRenameShortcut "$SMPROGRAMS\$AppStartMenuFolder"
  !insertmacro CodaClaudaRenameShortcut "$SMPROGRAMS\${STARTMENUFOLDER}"
  !insertmacro CodaClaudaRenameShortcut "$SMPROGRAMS"
  !insertmacro CodaClaudaRenameShortcut "$DESKTOP"
  Pop $R8
!macroend
