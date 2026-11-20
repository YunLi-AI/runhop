# RunHop

[English](README.md) · 简体中文

**Local Code. Remote Runtime.**

RunHop 是一个 VS Code 扩展，让你在本地编写 Python 代码，直接使用远程服务器上的 Python、Conda 和 GPU 环境运行与调试程序，获得接近 PyCharm SSH Interpreter 的开发体验。

## Why RunHop?

**We love VS Code. We just hate the remote Python debugging workflow.**

我们受够了为了在服务器上运行和调试 Python，就不得不折腾 Remote-SSH、Conda、代码同步、远程路径和 debugpy 的过程。

更重要的是，我们希望**开发环境始终留在本地**。

本地已经有 VS Code、Git、Claude Code 和 Codex。为什么只是想使用远程 GPU，就要把整个工作区迁移到服务器？

在不同服务器上重复安装和登录 AI 编程工具，不仅麻烦，还可能带来额外的认证、安全验证和网络环境问题。

我们需要的是远程计算资源，而不是远程开发工作区。

**Why move your workspace just to run Python?**

## Features

- **SSH Interpreter** — 直接使用远程 Python、Conda 和 venv 环境。
- **Remote Run & Debug** — 本地代码自动同步，远程执行和断点调试。
- **Local Run & Debug** — 直接用本地 Python 运行，并使用 RunHop 随包提供的 debugpy 调试。本地调试需要 Python 3.8 或更高版本。可在 **RunHop 配置中心 → 本地解释器** 指定可执行文件，或留空自动检测。
- **PyCharm-like Debugger** — 单步执行、变量、调用栈、Watches、Debug Console 和断点管理。
- **Multiple Sessions** — 同时管理多个 Run / Debug 任务，独立查看输出和状态。
- **Remote Terminal** — 远程交互式 Shell，自动初始化并激活对应环境。
- **Local-First** — 保留本地 VS Code、Git 和 AI Coding Agent，无须迁移整个开发环境。

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

- 更完善的 PyCharm 风格调试体验
- NumPy / PyTorch Tensor 调试增强
- 多进程与分布式 Python 调试
- **Agent-Friendly CLI** — 让 Codex 等 AI 工具复用已配置的远程执行环境，无需重复 SSH（规划中）

---

**Write here. Run there. Debug anywhere.**
