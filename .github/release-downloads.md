### Which file do I download?

**Windows**

| File | What it is |
| --- | --- |
| `Kanbini.Setup.{{VERSION}}.exe` | **Installer.** Installs Kanbini for your user (no admin needed), with a Start menu entry and an uninstaller. |
| `Kanbini-{{VERSION}}-win-x64-portable.zip` | **Portable folder.** Nothing to install: extract it anywhere and run `Kanbini.exe` inside. Opens right away. To update, replace the folder. |
| `Kanbini-{{VERSION}}-win-x64-portable-single-file.exe` | **Portable, one file.** Just run it. It unpacks itself into a temporary folder every time, so it takes a few seconds longer to open, and it cleans that folder up when you close it. Connecting an AI to it needs Node.js installed. |

All three keep your boards in the same place (`%APPDATA%\Kanbini`), so you can switch between them anytime. The builds aren't signed, so Windows SmartScreen may warn you the first time: click "More info", then "Run anyway".

**macOS**

| File | What it is |
| --- | --- |
| `Kanbini-{{VERSION}}-mac-universal.dmg` | **The app, for Apple Silicon and Intel Macs.** Open it and drag Kanbini into Applications. |

The app isn't notarized by Apple, so the first time you open it macOS says it can't verify it. Click "Done", then open System Settings, go to Privacy & Security, scroll down and click "Open Anyway" next to Kanbini. You only do this once. Your boards live in `~/Library/Application Support/Kanbini`.

**Linux** (x64)

| File | What it is |
| --- | --- |
| `Kanbini-{{VERSION}}-linux-amd64.deb` | **For Debian and Ubuntu.** Install it with `sudo apt install ./Kanbini-{{VERSION}}-linux-amd64.deb`. Adds Kanbini to your app menu. The best pick on Ubuntu 24.04 and newer. |
| `Kanbini-{{VERSION}}-linux-x86_64.AppImage` | **For any distro.** Nothing to install: `chmod +x` it and run it. Needs FUSE 2 (`libfuse2`). On Ubuntu 24.04 and newer, start it with `--no-sandbox` or use the `.deb`. Connecting an AI to it needs Node.js installed. |

Both keep your boards in `~/.config/Kanbini`.

The "Source code" downloads are for developers.
