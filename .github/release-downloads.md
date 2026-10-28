### Which file do I download? (Windows)

| File | What it is |
| --- | --- |
| `Kanbini.Setup.{{VERSION}}.exe` | **Installer.** Installs Kanbini for your user (no admin needed), with a Start menu entry and an uninstaller. |
| `Kanbini-{{VERSION}}-win-x64-portable.zip` | **Portable folder.** Nothing to install: extract it anywhere and run `Kanbini.exe` inside. Opens right away. To update, replace the folder. |
| `Kanbini-{{VERSION}}-win-x64-portable-single-file.exe` | **Portable, one file.** Just run it. It unpacks itself into a temporary folder every time, so it takes a few seconds longer to open, and it cleans that folder up when you close it. Connecting an AI to it needs Node.js installed. |

All three keep your boards in the same place (`%APPDATA%\Kanbini`), so you can switch between them anytime. The builds aren't signed, so Windows SmartScreen may warn you the first time: click "More info", then "Run anyway". The "Source code" downloads are for developers.

