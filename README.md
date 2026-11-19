# RunHop

RunHop is a VS Code extension for editing locally with Codex or another coding tool and running and debugging Python on SSH servers. The local editor uses its local project files. The process, interpreter, and dependencies stay on the selected server.

## Configure RunHop

Install the RunHop VSIX using **Extensions → Install from VSIX…** in VS Code. Open a local Python file, then choose **RunHop → Open RunHop Configuration** in the upper-right editor toolbar. The file is `.vscode/runhop.json`. Each target describes an SSH connection and the mapping from local `context` to remote `remotePath`. The file also holds Python interpreters and saved run configurations.

Use **Remote Interpreter** in the same menu to add or select the Python executable for the current script. The first interpreter you add becomes the workspace default. **Script Arguments** edits arguments for the current script. Quote a path with spaces to pass it as one argument. Both controls save directly to `.vscode/runhop.json`, and every launch reads that file again. A manual edit can add settings such as a mapped `cwd`, `env`, or result paths in `download`.

```json
{
  "targets": [
    {
      "name": "GPU A",
      "host": "gpu-a",
      "username": "alice",
      "context": ".",
      "remotePath": "/home/alice/project"
    }
  ],
  "interpreters": {
    "Training": { "path": "/opt/venv/bin/python", "target": "GPU A" }
  },
  "defaultInterpreter": "Training",
  "scripts": {
    "scripts/train.py": {
      "args": ["--data", "/mnt/training set"],
      "download": ["outputs"]
    }
  }
}
```

Script keys are workspace-relative paths with forward slashes. Paths inside `args` and `env` are sent to the remote process as entered. Set a script's `interpreter` to override the workspace default. Run and Debug pass the saved `args` to the remote interpreter. Scripts without an `args` entry receive no command-line arguments.

### Saved run configurations

Click **Select Run Configuration** next to **RunHop** in the editor toolbar. Pick a saved configuration or use **New Run Configuration** to save a script, remote interpreter, mapped working directory and arguments. The selected name is saved as `activeRunConfiguration`. Run and Debug use that configuration as you switch editor tabs, including tabs for other file types. Choose **Current Python File** to restore file-based launches.

Use **RunHop → Edit Run Configuration** to edit the selected configuration, or edit `runConfigurations` in `.vscode/runhop.json`. Named configurations can share a script and use different arguments or interpreters. Here is an example of the two fields in the same file as the SSH targets and interpreters.

```json
{
  "activeRunConfiguration": "Train",
  "runConfigurations": {
    "Train": {
      "program": "scripts/train.py",
      "interpreter": "Training",
      "cwd": ".",
      "args": ["--data", "/mnt/training set"]
    }
  }
}
```

Both `program` and `cwd` are relative to the local workspace. The target maps them to the server.

### Run or debug a file from its context menu

Right-click a Python file in Explorer or the editor and select **RunHop: Run** or **RunHop: Debug**. RunHop uses the clicked file. If a saved configuration points to that file, RunHop uses it. It prefers the active configuration when it points to the file and asks which preset to use if several other presets match.

A file covered by an SSH target uses remote Python. RunHop reads the interpreter name from the matched preset, the file's entry in `scripts`, or the project's `defaultInterpreter`. Without a named interpreter, the matched target uses `python3`. Files outside the mapped targets and projects without RunHop settings use the interpreter selected in VS Code. Local launches use the Python Debugger extension.

Set `runOn` to `local` or `remote` in a script or saved configuration to choose explicitly. For example, this RunHop configuration keeps a utility local and gives it one argument.

```json
{
  "scripts": {
    "scripts/check.py": {
      "runOn": "local",
      "args": ["--check"]
    }
  }
}
```

### Source synchronization

Right-click a project, folder, or file in Explorer and choose **RunHop → Upload to Server** or **Download from Server**. Transfers cover the selected item and use the applicable target and profile. An upload compares the selected folder and sends changes. A download saves a separate copy under `.vscode/runhop-downloads/`. Both modes honor project excludes and skip symbolic links. **SFTP** uses the bundled client. **rsync** uses the system binaries on both ends and an OpenSSH key or agent. Manual rsync uses size and modification time to select files and can transfer only changed blocks. Use SFTP for RunHop SSH hops.

Right-click a project folder and choose **RunHop → Project Sync Mode**. Set `syncMode` to `incremental` (the default), `full`, or `off`. Saved run configurations, scripts, and native launch entries can override the project mode. The separate `uploadOnSave` setting defaults to `true`.

**Sync Changed Files** sets `syncMode` to `incremental` and enables `uploadOnSave`. The first launch synchronizes the project and saves a local metadata baseline for that remote target. A manual upload of the entire mapped project also establishes the baseline. Later launches inspect local file metadata only and transfer new or changed files. This includes edits made outside VS Code, such as Codex writes and Git changes, even after reopening the window. Saved files that already reached the same target are recorded in the baseline. Use a full project sync to reconcile edits made on the server or to deploy a replacement checkout.

**Upload on Save** sends the saved file to the target and profile selected by the active RunHop configuration, or by the applicable interpreter for the current file. Run and Debug wait for pending save uploads to the same target. Use the project upload command to deploy changes made outside a VS Code save in this mode. The existing `download` setting retrieves declared results after a run.

Set `ignore` on the target or profile to exclude paths using Gitignore patterns relative to the target's local context. An optional `ignoreFile` supplies additional patterns. Both startup sync and save uploads apply the rules. RunHop already excludes common dependency and environment folders such as `node_modules`, `.venv`, `__pycache__`, `.git`, `.vscode`, and `.env` files. For project data, add rules such as `"/datasets/"`, `"/data/raw/"`, or `"*.parquet"` to the target's `ignore` array.

### Native VS Code launch entry

A `.vscode/launch.json` entry with type `runhop-python` reads interpreters and script settings from `.vscode/runhop.json`. Set `program` to the Python file to run.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "RunHop · Current File",
      "type": "runhop-python",
      "request": "launch",
      "program": "${file}"
    }
  ]
}
```

To link a native launch entry to a named RunHop configuration, use `"runConfiguration": "Train"` in place of `program`.

Use `module` for a Python module instead of a script. Native launch options such as `args`, `cwd` or `syncMode` can override the project defaults for that entry.

## Run and debug

1. Open a local Python file and set a breakpoint.
2. Click **RunHop** at the top right of the editor to open the controls. The popup shows the selected interpreter and offers **Debug on Server**, **Run on Server**, and access to configuration and logs. You can also open it with **RunHop** in the Command Palette.
   Starting from this menu keeps the Explorer available through breakpoints. After you use the RunHop controls to run or configure a script, F5 and Ctrl+F5 use the selected RunHop configuration or the current Python file.
3. The **RunHop** panel opens the debug workbench with execution controls, **Threads & Frames**, and **Variables**. Select a frame to open its source and inspect its scopes. Expand objects on demand and use **Preview** for a supported image, array, table, or bounded representation. **Debug Console** evaluates Python in the selected paused frame.
4. **Program Output** shows stdout and stderr delivered to RunHop. After the process stops, RunHop downloads the paths in `download` to a new subdirectory under `.vscode/runhop-results/`. The **RunHop** output channel reports where they were saved.

Select a session in the top tab bar. **View Breakpoints** opens a separate editor tab with a searchable list grouped by breakpoint type and file, and an editor for condition, hit condition, and logging. Use **Ctrl+Shift+F8** (**Cmd+Shift+F8** on macOS), the RunHop menu, or the bottom panel toolbar to open it before starting a session. Double-click a line breakpoint or press **F4** to reveal its source. **Quick Breakpoints** in the debug toolbar shows the count and opens a compact list for enabling, disabling and locating breakpoints. Line and function breakpoint definitions are shared with VS Code. Verification belongs to the selected live adapter.

**Python Exceptions** shows the filters advertised by the selected adapter. The checkboxes apply to the selected live, unmuted RunHop debug session. Changes to the native VS Code filters and session restart restore the workspace settings. Use **Configure workspace filters in VS Code** to make persistent changes. **Mute Breakpoints** applies to the selected RunHop debug session and restores its filters when you unmute it.

**Watches** supports manual evaluation and automatic evaluation on pause or frame selection. RunHop asks how to evaluate a watch that is more than a simple name. Drag the dividers to resize the panes. The panel restores their sizes when reopened. **More Actions** includes expression evaluation and Smart Step Into when the selected debug adapter provides targets.

### Parallel sessions

The bottom **RunHop** panel lists Run, Debug, and SSH terminal sessions in tabs. Run and Debug can run in parallel against the same remote project. The tabs show each session's state and exit code. **Stop** targets the selected live execution. **Restart** or **Rerun** waits for the selected process to exit and starts a fresh process in the same tab. Program Output keeps its scrollback with a separator for each rerun. Completed sessions can be closed individually, and hiding the panel leaves live sessions running.

RunHop queues syncs and result downloads for the same project while the programs run independently. Parallel sessions can share the remote checkout and working directory. Configure distinct output paths for tasks that write results concurrently. RunHop saves each confirmed session's requested downloads in its own local results directory.

For a plain Run, the remote supervisor reaps the Python process and stops descendants in its process group. Debug continues to use debugpy's launch and termination protocol. A session without a confirmed Python exit after losing SSH is marked **Disconnected**. Deliberately detached processes are outside the Run supervisor's process group.

The workbench reads scopes and a bounded number of children from the debug adapter. Array and tensor metadata appears when the adapter returns it. RunHop does not evaluate extra tensor expressions automatically. RunHop remote debugging tracks the main Python process. The workbench can also observe separate Python debug sessions started by VS Code, and sees their output only when the adapter sends it.

**Open Terminal on Server** is available from the top-right RunHop menu and the title bar of the bottom RunHop panel. It allocates an SSH pseudo-terminal and opens the account's Bash or Zsh as an interactive login shell. After the shell loads its usual startup files, RunHop activates the selected Conda or virtual environment and enters the mapped working directory. On servers with a separate Conda installation that the login shell cannot discover, set the absolute `condaExecutable` path on the RunHop interpreter. Use the bottom panel title bar's **Terminal Sessions** menu to switch or close sessions.

When the selected RunHop debug session is paused, **F7** steps into, **F8** steps over, **Shift+F8** steps out and **F9** resumes. **Ctrl+F2** (**Cmd+F2** on macOS) stops the selected session. After enabling RunHop's editor shortcuts, **Shift+F9** starts a debug session and **Shift+F10** runs the active RunHop configuration.

**Run on Server** starts the selected remote Python directly. **Debug on Server** uses the debugger bundled in the VSIX. On the first Debug with a given bundle, RunHop sends it over SFTP to `~/.cache/runhop/debugpy/` and prepares it with Python's standard library. Later sessions reuse that cache. Debug requires Python 3.8 or newer and a writable remote home cache. The project's Conda environment, virtual environment and dependency files require no modifications.

To place the toolbar in the VS Code window's title bar, run the native **View: Move Editor Actions to Title Bar** command.
The **Use VS Code Default Shortcuts** choice restores the workspace folder's native F5 shortcuts.

When launch sync is enabled, the session and the VS Code progress notification show the connection, directory scan, content comparison, and upload. Uploads and result downloads show file counts, transferred bytes, and the active file. Content comparison uses remote hashes when available and can read remote files over SFTP to compute hashes. RunHop skips configured result paths during source sync and never deletes remote files during that sync. Use a dedicated remote deployment directory for each project. The VSIX includes the SFTP client and requires no local `rsync` binary.

This version launches the main Python process on a POSIX SSH server. Run and Debug sessions display process output, and VS Code's Stop action ends the session. An SSH terminal accepts input independently of those sessions.

## Develop

Run from the repository root:

```sh
npm ci
npm run lint
npm test -- --runInBand
npm run package
```

The VSIX is written to `dist/`. Use **Launch RunHop** in VS Code to open the Extension Development Host. RunHop's implementation lives under `runhop/`. Its SSH, SFTP, and transfer code is under `runhop/transport/`.

## License

The bundled [debugpy](https://github.com/microsoft/debugpy) wheel includes its license and third-party notices.
