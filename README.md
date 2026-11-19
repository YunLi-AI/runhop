# RunHop

English · [简体中文](README.zh-CN.md)

**Local Code. Remote Runtime.**

RunHop is a VS Code extension that lets you write Python locally and run and debug it using the Python, Conda, and GPU environment on a remote server. The workflow feels like using a PyCharm SSH interpreter.

## Why RunHop?

**We love VS Code. We just hate the remote Python debugging workflow.**

We got tired of juggling Remote-SSH, Conda, code sync, remote paths, and debugpy just to run and debug Python on a server.

More importantly, we want **our development environment to stay local**.

We already have VS Code, Git, Claude Code, and Codex on our machines. Why move the entire workspace to a server just to use a remote GPU?

Installing and signing in to AI coding tools on every server takes time and can add authentication, security verification, and network hurdles.

We want to use remote compute while keeping the workspace local.

**Why move your workspace just to run Python?**

## Features

- **SSH Interpreter** — Use remote Python, Conda, and venv environments directly.
- **Remote Run & Debug** — Sync local code automatically, run it remotely, and debug with breakpoints.
- **PyCharm-like Debugger** — Step through code, inspect variables and the call stack, use watches and the Debug Console, and manage breakpoints.
- **Multiple Sessions** — Manage concurrent Run and Debug sessions and view each one's output and status independently.
- **Remote Terminal** — Open an interactive remote shell that initializes and activates the selected environment.
- **Local-First** — Keep VS Code, Git, and AI coding agents in your local workspace.

## How It Works

```text
Local VS Code
├── Code / Git / Codex / Claude Code
└── RunHop
     ├── SSH Interpreter
     ├── Run / Debug
     └── Sessions
           │
           ▼
    Remote Linux Server
    Python / Conda / CUDA / GPU
```

## What's Next?

- A more complete PyCharm-style debugging experience
- Better debugging support for NumPy arrays and PyTorch tensors
- Multiprocess and distributed Python debugging
- **Agent-Friendly CLI** (planned) — Let Codex and other AI tools reuse configured remote execution environments without opening separate SSH sessions.

---

**Write here. Run there. Debug anywhere.**
