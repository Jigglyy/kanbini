; M5-B / ADR-0049 — opt-in "remove my data on uninstall" hook.
;
; The renderer's Settings → Uninstall toggle writes
;   HKCU\Software\Kanbini\RemoveDataOnUninstall = 0 | 1
; via reg.exe (see apps/desktop/src/main/index.ts). NSIS reads it
; here during uninstall. Default behaviour (key missing OR set to 0)
; is to LEAVE the user's data alone — they may be reinstalling, or
; the toggle never fired (registry write failed, fresh install where
; the user never opened Settings).
;
; Why HKCU + reg.exe (not a file in the install dir or %APPDATA%):
;  - The install dir is gone before this script runs — the
;    uninstaller deletes program files first, then invokes us for
;    cleanup, so any marker file inside the install dir is unreadable
;    at this point.
;  - A marker file in %APPDATA%\Kanbini would be inside the very
;    folder we're deciding whether to delete — chicken-and-egg.
;  - HKCU works regardless of perMachine; matches NSIS's
;    `perMachine: false` choice in electron-builder.yml.
;
; electron-builder defines two macros that fire inside its own
; uninstaller section: `customUnInit` (runs first) and
; `customUnInstall` (runs after the program files are removed). We
; use `customUnInstall` so the user's data is the LAST thing to go,
; and only if they opted in.

; --- Opt-in desktop shortcut --------------------------------------
;
; electron-builder's `createDesktopShortcut` is a binary always/never
; flag — no built-in checkbox or prompt. To let the user opt in or
; out at install time we set `createDesktopShortcut: false` in
; electron-builder.yml (so electron-builder skips its own desktop
; shortcut step) and ask here via a simple Yes/No MessageBox. The
; default is YES — silent installs (`/S`) and pressing Enter on the
; dialog both keep a shortcut, matching the previous always-create
; behaviour for users who had grown used to it.
;
; `${SHORTCUT_NAME}` + `${APP_EXECUTABLE_FILENAME}` are the same
; defines electron-builder's own shortcut step uses, so the .lnk we
; create here is indistinguishable from the one electron-builder
; would have made on its own.

!macro customInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Create a desktop shortcut for ${PRODUCT_NAME}?" \
    /SD IDYES IDNO kanbini_no_desktop_shortcut
  CreateShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  kanbini_no_desktop_shortcut:

  ; Force Explorer to refresh its icon cache. Windows caches icons by
  ; file path: if a prior install (or test build) put a different .exe
  ; at this path before the brand-mark icon shipped in ADR-0051,
  ; Explorer keeps showing the cached icon even though the new
  ; Kanbini.exe carries the correct embedded icon resource. Same story
  ; for the shortcuts above — they cache the target's icon at .lnk
  ; creation time. `ie4uinit.exe -show` is Microsoft's documented
  ; per-user icon-cache refresh, ships with every Windows install at
  ; %SystemRoot%\system32. Fire-and-forget (`Exec`, not `ExecWait`) —
  ; the refresh is cosmetic and shouldn't block the install
  ; completion screen.
  Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!macro customUnInstall
  ; Read the toggle's value into $0. ReadRegDWORD returns 0 + sets
  ; $0 = "" if the key doesn't exist — the IntCmp branch below maps
  ; both "" (default) and 0 to "leave the data alone".
  ReadRegDWORD $0 HKCU "Software\Kanbini" "RemoveDataOnUninstall"

  ; IntCmp $0 1 equal less greater
  ;   - equal:   $0 == 1  → user opted in, delete %APPDATA%\Kanbini
  ;   - less:    $0 <  1  → opt-out / missing → skip
  ;   - greater: $0 >  1  → unexpected value → skip (safe default)
  ; We use Goto explicitly so a future maintainer can add steps to
  ; either branch without rethinking the cmp arms.
  IntCmp $0 1 do_remove skip_remove skip_remove

  do_remove:
    ; $APPDATA on the uninstaller's user context = %APPDATA% = the
    ; same folder Electron's app.getPath('userData') resolves to when
    ; productName is "Kanbini" (electron-builder.yml line 11).
    ; RMDir /r recursively removes; /REBOOTOK queues anything still
    ; locked for delete-on-next-reboot, which matters if the user
    ; uninstalls while a leftover Electron helper is still draining.
    RMDir /r /REBOOTOK "$APPDATA\Kanbini"
    DetailPrint "Removed user data at $APPDATA\Kanbini"
    Goto remove_done

  skip_remove:
    DetailPrint "Leaving user data at $APPDATA\Kanbini (re-install will pick up where you left off)"

  remove_done:
    ; Always clean up our own HKCU subtree — the uninstaller's job
    ; isn't done leaving stray registry keys around. DeleteRegKey
    ; on a non-existent key is a silent no-op, so this is safe even
    ; when the toggle never fired.
    DeleteRegKey HKCU "Software\Kanbini"

    ; Clean up the opt-in desktop shortcut. Because we set
    ; `createDesktopShortcut: false` in YAML, electron-builder's
    ; uninstall code doesn't know about this .lnk — we have to
    ; delete it ourselves. `Delete` on a non-existent path is a
    ; silent no-op, so this is safe whether the user opted in or
    ; out at install time; `/REBOOTOK` queues it for next-boot
    ; cleanup if something has it open.
    Delete /REBOOTOK "$DESKTOP\${SHORTCUT_NAME}.lnk"

    ; Clean up the orphaned `@kanbinidesktop-updater` staging
    ; directory under %LOCALAPPDATA%. electron-builder's NSIS
    ; template creates it from the package.json `name` field
    ; (`@kanbini/desktop` → `@kanbinidesktop` + `-updater`) as a
    ; partial-download staging area for its self-update mechanism,
    ; even though we don't ship `electron-updater` and never call
    ; the auto-update code path. Without this line it sits there
    ; forever as a few-KB orphan after every uninstall. `RMDir /r`
    ; on a non-existent path is a silent no-op, so this is safe
    ; on first uninstall too.
    RMDir /r /REBOOTOK "$LOCALAPPDATA\@kanbinidesktop-updater"
!macroend
