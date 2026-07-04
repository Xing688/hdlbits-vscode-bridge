# HDLBits VS Code Bridge

**在 VS Code 中编写 Verilog，一键提交到 HDLBits，无缝衔接浏览器与编辑器。**

[English](#english) | [中文](#中文)

---

## 中文

### 这是什么？

HDLBits VS Code Bridge 是一套工具组合，让你在 VS Code 中编写 HDLBits 的 Verilog 代码，并通过状态栏按钮直接提交到 HDLBits 网站。点击 HDLBits 页面上的"Open in VS Code"按钮，题目代码会自动在 VS Code 中打开为 `.v` 文件；在 VS Code 中提交后，HDLBits 页面会自动刷新显示结果。

**组成部分：**

| 组件 | 说明 |
|------|------|
| `vscode-extension/` | VS Code 扩展 — 本地 HTTP 服务器、状态栏提交按钮、Chrome 通信桥接 |
| `chrome-extension/` | Chrome 扩展 — 在 HDLBits 页面注入"Open in VS Code"按钮、自动刷新 |
| `submit-tool/` | C++ 命令行提交工具 — 将 .v 文件通过 HTTPS 提交到 HDLBits |

### 关于 HDLBits

[**HDLBits**](https://hdlbits.01xz.net/) 是一个优秀的在线 Verilog/SystemVerilog 练习平台，由多伦多大学（University of Toronto）的硬件设计课程团队开发维护。它提供从基础组合逻辑到复杂有限状态机的数百道练习题，每道题都配有：

- 📋 **题目描述** — 清晰的功能规格和端口定义
- ✏️ **在线编辑器** — 基于 CodeMirror 的浏览器端 Verilog 编辑器
- ⚡ **即时评测** — 提交后自动编译、仿真、比对结果
- 📊 **波形输出** — 仿真波形可视化，方便调试

HDLBits 是 FPGA/数字 IC 入门最推荐的练习平台之一，全球数万硬件工程师和学生通过它学习 Verilog。然而，HDLBits 的在线编辑器缺少本地 IDE 的代码补全、语法高亮、版本管理等特性——这正是本工具诞生的原因。

### 功能特性

- ✅ HDLBits 页面一键在 VS Code 中打开题目
- ✅ VS Code 状态栏一键提交代码到 HDLBits
- ✅ 提交完成后 HDLBits 页面自动刷新并显示结果
- ✅ 复用已有终端，不创建新窗口
- ✅ 防止 Google 翻译破坏 Verilog 代码（`translate="no"` + `notranslate`）
- ✅ VS Code 窗口自动前置（Win32 API，非 AppActivate）
- ✅ 提交工具零外部依赖（Windows 原生 WinHTTP）
- ✅ 连接状态实时显示（横幅指示器）
- ✅ 提交进度状态栏动画

### 系统要求

- **VS Code** ≥ 1.80.0
- **Chrome** / Edge（支持 Manifest V3 的 Chromium 浏览器）
- **Windows**（提交工具和窗口前置功能为 Win32；macOS/Linux 用户见下方说明）
- **HDLBits 账号**（需登录状态）

### 安装

#### 1. 安装 VS Code 扩展

```bash
# 方法 A：从 VSIX 安装
code --install-extension hdlbits-connector-1.0.0.vsix

# 方法 B：开发模式
cd vscode-extension
npm install   # 无额外依赖，仅用于打包
# 按 F5 启动调试，或复制到 ~/.vscode/extensions/hdlbits-connector/
```

#### 2. 安装 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `chrome-extension/` 目录

#### 3. 编译提交工具

```bash
# Windows (MinGW-w64)
g++ -O2 -std=c++17 -s -municode submit-tool/hdlbits_submit.cpp -lwinhttp -o hdlbits_submit.exe

# 将编译好的 exe 放到 PATH 中，或记下绝对路径
```

#### 4. 配置登录信息

```bash
# 运行登录帮助
hdlbits_submit --login
```

按提示在浏览器控制台运行 JavaScript 获取 `vlgsession` cookie，保存到 `%USERPROFILE%\.hdlbits\cookies.json`（Windows）或 `~/.hdlbits/cookies.json`（Linux/macOS）。

### 配置

VS Code 设置（`Ctrl+,` → 搜索 `hdlbits`）：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `hdlbits.serverPort` | `19876` | 本地 HTTP 服务端口（需与 Chrome 扩展一致） |
| `hdlbits.workspacePath` | (空) | .v 文件存储目录（默认: 首个工作区文件夹） |
| `hdlbits.submitScript` | `hdlbits_submit` | 提交工具路径（如在 PATH 中则直接用命令名） |

### 使用方式

```
┌─────────────────────┐         ┌──────────────────────┐
│   HDLBits (Chrome)  │         │   VS Code            │
│                     │         │                      │
│  [📝 Open in VS Code]│ ──POST─→│  /open 端点           │
│                     │         │  创建 .v 文件         │
│                     │         │  打开编辑器           │
│                     │         │                      │
│                     │         │  [📤 HDLBits] 状态栏  │
│                     │ ←─轮询──│  提交到 HDLBits       │
│  🔄 自动刷新页面     │         │  更新时间戳           │
└─────────────────────┘         └──────────────────────┘
```

1. 打开 HDLBits 题目页面
2. 看到 VS Code Bridge 横幅（绿色表示已连接）
3. 点击 **📝 Open in VS Code** → 代码在 VS Code 中打开
4. 在 VS Code 中编写代码，保存
5. 点击状态栏的 **📤 HDLBits** 按钮（或 `Ctrl+Shift+P` → `HDLBits: Submit Current File`）
6. 提交完成后 HDLBits 页面自动刷新显示结果

### macOS / Linux 用户

提交工具 `hdlbits_submit.cpp` 使用 Windows WinHTTP API，不跨平台。macOS/Linux 用户有两个选择：

**A) 使用 Python 替代脚本：**

```python
#!/usr/bin/env python3
"""HDLBits submit tool (cross-platform fallback)"""
import sys, os, json, re, urllib.request, urllib.parse

def main():
    if len(sys.argv) < 2:
        print("Usage: hdlbits_submit <file.v> [--id problem_id]")
        sys.exit(1)

    filepath = sys.argv[1]
    # ... (见 README 完整代码或查看 submit-tool/ 目录)
```

**B) 自行编写提交脚本：**

HDLBits 提交 API 非常简单：
- **URL**: `https://hdlbits.01xz.net/runsim.php`
- **Method**: `POST`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Body**: `tc=<problem_id>&vlgcode_box=<verilog_code>`
- **Cookie**: `vlgsession=<your_session_cookie>`

### 项目结构

```
hdlbits-vscode-bridge/
├── README.md
├── vscode-extension/          # VS Code 扩展
│   ├── package.json           #   扩展清单 & 配置定义
│   ├── extension.js           #   主逻辑（HTTP 服务、命令、窗口前置）
│   └── .vscodeignore          #   打包排除规则
├── chrome-extension/          # Chrome 扩展
│   ├── manifest.json          #   扩展清单 (Manifest V3)
│   ├── content.js             #   内容脚本（按钮注入、代码保护、自动刷新）
│   ├── background.js          #   Service Worker
│   ├── style.css              #   按钮 & 横幅样式
│   └── icons/                 #   扩展图标
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
└── submit-tool/               # 提交工具
    └── hdlbits_submit.cpp     #   C++ 源码 (WinHTTP)
```

### 协议

MIT License

### 常见问题

**Q: Chrome 扩展显示"未连接"？**
A: 确保 VS Code 已打开且 HDLBits Connector 扩展已激活。检查输出面板（`Ctrl+Shift+U` → HDLBits Connector）。

**Q: 提交后页面没有自动刷新？**
A: 确认 VS Code 扩展的输出面板显示 `[HDLBits] Done → page will auto-refresh`。如果提交工具报错，请先解决提交问题。

**Q: Google 翻译把 Verilog 代码翻译成中文了？**
A: Chrome 扩展运行在 `document_start`，会在 Google 翻译之前保护代码区域。如果已经翻译，点击"Open in VS Code"会通过 XHR 获取原始 HTML 源恢复代码。

**Q: VS Code 窗口没有自动前置？**
A: Windows 对后台进程抢前台焦点有限制。扩展使用了 `SetForegroundWindow` + `AttachThreadInput` 技巧来绕过此限制，但不能保证 100% 成功。

---

## English

### What is this?

HDLBits VS Code Bridge is a tool suite that lets you write HDLBits Verilog code in VS Code and submit it directly to HDLBits via a status bar button. Click "Open in VS Code" on any HDLBits problem page and the code opens as a `.v` file in VS Code; after submitting from VS Code, the HDLBits page auto-refreshes to show results.

**Components:**

| Component | Description |
|-----------|-------------|
| `vscode-extension/` | VS Code extension — local HTTP server, status bar submit button, Chrome bridge |
| `chrome-extension/` | Chrome extension — injects "Open in VS Code" button on HDLBits, auto-refresh |
| `submit-tool/` | C++ CLI submit tool — submits .v files to HDLBits via HTTPS |

### About HDLBits

[**HDLBits**](https://hdlbits.01xz.net/) is an excellent online Verilog/SystemVerilog practice platform developed and maintained by the hardware design course team at the University of Toronto. It offers hundreds of exercises ranging from basic combinational logic to complex finite state machines, each featuring:

- 📋 **Problem Description** — clear functional specification and port definitions
- ✏️ **Online Editor** — CodeMirror-based browser Verilog editor
- ⚡ **Instant Evaluation** — auto-compile, simulate, and compare results on submission
- 📊 **Waveform Output** — simulation waveform visualization for debugging

HDLBits is one of the most recommended practice platforms for FPGA/digital IC beginners, used by tens of thousands of hardware engineers and students worldwide to learn Verilog. However, its online editor lacks the code completion, syntax highlighting, and version control features of a local IDE — which is exactly why this tool exists.

### Features

- ✅ One-click open HDLBits problems in VS Code
- ✅ One-click submit from VS Code status bar to HDLBits
- ✅ Auto-refresh HDLBits page after submission completes
- ✅ Terminal reuse (no new window on every submit)
- ✅ Google Translate protection for Verilog code
- ✅ VS Code window auto-focus (Win32 API)
- ✅ Zero-dependency submit tool (Windows native WinHTTP)
- ✅ Real-time connection status indicator
- ✅ Submit progress animation in status bar

### Requirements

- **VS Code** ≥ 1.80.0
- **Chrome** / Edge (Chromium-based, Manifest V3)
- **Windows** (submit tool and window focusing use Win32; see below for macOS/Linux)
- **HDLBits account** (logged in)

### Installation

#### 1. VS Code Extension

```bash
# Option A: Install from VSIX
code --install-extension hdlbits-connector-1.0.0.vsix

# Option B: Development mode
cd vscode-extension
npm install   # no runtime dependencies, only for packaging
# Press F5 to debug, or copy to ~/.vscode/extensions/hdlbits-connector/
```

#### 2. Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `chrome-extension/` directory

#### 3. Build Submit Tool

```bash
# Windows (MinGW-w64)
g++ -O2 -std=c++17 -s -municode submit-tool/hdlbits_submit.cpp -lwinhttp -o hdlbits_submit.exe

# Place the binary in your PATH, or note its absolute path
```

#### 4. Login Setup

```bash
hdlbits_submit --login
```

Follow instructions to save your `vlgsession` cookie to `~/.hdlbits/cookies.json`.

### Configuration

VS Code settings (`Ctrl+,` → search `hdlbits`):

| Setting | Default | Description |
|---------|---------|-------------|
| `hdlbits.serverPort` | `19876` | Local HTTP server port (must match Chrome extension) |
| `hdlbits.workspacePath` | (empty) | Directory for .v files (default: first workspace folder) |
| `hdlbits.submitScript` | `hdlbits_submit` | Path to submit tool (use command name if in PATH) |

### Usage

1. Open an HDLBits problem page
2. See the VS Code Bridge banner (green = connected)
3. Click **📝 Open in VS Code** → code opens in VS Code
4. Edit in VS Code, save
5. Click **📤 HDLBits** status bar button (or `Ctrl+Shift+P` → `HDLBits: Submit Current File`)
6. HDLBits page auto-refreshes with results

### macOS / Linux

The submit tool (`hdlbits_submit.cpp`) uses Windows WinHTTP. macOS/Linux users can write a simple Python script — the HDLBits submit API is straightforward:

- **URL**: `https://hdlbits.01xz.net/runsim.php`
- **Method**: `POST`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Body**: `tc=<problem_id>&vlgcode_box=<verilog_code>`
- **Cookie**: `vlgsession=<your_session_cookie>`

### Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│   HDLBits (Chrome)  │         │   VS Code            │
│                     │         │                      │
│  [📝 Open in VS Code]│ ──POST─→│  /open endpoint      │
│                     │         │  Creates .v file     │
│                     │         │  Opens editor        │
│                     │         │                      │
│                     │         │  [📤 HDLBits] status  │
│                     │ ←─poll──│  Submits to HDLBits  │
│  🔄 Auto-refresh    │         │  Updates timestamp   │
└─────────────────────┘         └──────────────────────┘
```

### License

MIT License
