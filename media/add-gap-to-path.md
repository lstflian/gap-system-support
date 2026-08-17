Running a GAP file needs the `gap` command on the PATH. Add the GAP root directory (which holds `gap.exe`) and the `runtime/bin` directory (which holds the required DLLs).

**Windows**

For an `.exe` installer installation, run this in PowerShell, replacing the paths with your actual installation paths:

```powershell
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
[Environment]::SetEnvironmentVariable('PATH', $userPath + ';C:\Program Files\GAP-4.16.0\runtime\opt\gap-4.16.0;C:\Program Files\GAP-4.16.0\runtime\bin', 'User')
```

**Linux / macOS**

Add the GAP root directory to the PATH, for example in `~/.bashrc`:

```bash
export PATH="$PATH:/opt/gap-4.16.0"
```

Restart the terminal (or VS Code) afterwards, then open a new terminal and run `gap --version` to confirm it works.
