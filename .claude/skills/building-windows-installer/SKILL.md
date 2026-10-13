---
name: building-windows-installer
description: Builds the Alethe Windows installer (MSI/NSIS) inside the MSVC environment and reports where it landed. Use when asked to build, package, or bundle the installer, or to run `npm run tauri build`.
---

# Building the Windows installer

The build requires the MSVC environment (`vcvars64`):

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >NUL && npm run tauri build'
```

The folder depends on the Build Tools version: `2022\BuildTools` for Visual Studio 2022,
`18\BuildTools` for Visual Studio 2026. `vswhere -products * -property installationPath` (in
`C:\Program Files (x86)\Microsoft Visual Studio\Installer`) prints the installed one.

The Rust toolchain on `C:` can be corrupted by Windows Defender — prefer building from `D:`.

When returning the path of a generated installer, always report the **full absolute path on the PC**
(for example, `D:\project\src-tauri\target\release\bundle\nsis\Alethe_setup.exe`), never just the
path relative to the repository.
