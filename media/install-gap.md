# Install GAP and Configure the PATH

First, make sure GAP is installed and added to the system `PATH`. If it is not on the `PATH`, you can follow the steps below to configure it.

**Windows**: If GAP was installed via the `.exe` installer, run the following in PowerShell:

```powershell
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
[Environment]::SetEnvironmentVariable('PATH', $userPath + ';C:\Program Files\GAP-4.16.1\runtime\opt\gap-4.16.1;C:\Program Files\GAP-4.16.1\runtime\bin', 'User')
```

After running the commands above, open a new PowerShell terminal and run `gap --version`. If it prints the GAP version, your environment is configured successfully.

**Linux / macOS**: Run the following in a terminal (on macOS, replace `~/.bashrc` with `~/.zshrc`):

```bash
echo 'export PATH="/opt/gap-4.16.1:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Finally, run `gap --version` to verify that it is configured correctly.

**Note**: If your installation path differs from the examples, replace it with your actual installation path.
