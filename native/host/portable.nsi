; All-In-One Finder — portable launcher (M3).
;
; Extracts the app to a temporary directory, runs it with --portable-dir so the
; session/userdata folders stay next to the exe the user launched, then lets NSIS
; clean $PLUGINSDIR up.
;
; Build: makensis /DAPP_VERSION=0.8.0 /DOUTDIR=<abs release dir> portable.nsi
Unicode true
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef OUTDIR
  !define OUTDIR "..\..\release"
!endif

Name "All-In-One Finder"
Caption "All-In-One Finder"
OutFile "${OUTDIR}\All-In-One Finder ${APP_VERSION}.exe"
Icon "..\..\build\icon.ico"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma
SetCompress force

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "定种多功能搜索器"
VIAddVersionKey /LANG=2052 "FileDescription" "All-In-One Finder"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "SunnySlopes & more"
VIAddVersionKey /LANG=2052 "LegalCopyright" "GPL-3.0-only"
VIAddVersionKey /LANG=1033 "ProductName" "All-In-One Finder"
VIAddVersionKey /LANG=1033 "FileDescription" "All-In-One Finder"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName" "SunnySlopes & more"
VIAddVersionKey /LANG=1033 "LegalCopyright" "GPL-3.0-only"

Section "Main"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /r "stage\*.*"
  ExecWait '"$PLUGINSDIR\All-In-One Finder.exe" --portable-dir "$EXEDIR"'
SectionEnd
