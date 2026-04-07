<p align="center">The open source AI coding agent.</p>

---

### Installation

#### npm (recommended)

```bash
npm install -g aboocode-ai
```

Then run:

```bash
aboo
```

#### Quick Install (from source)

```bash
git clone https://github.com/cytsaiap-xyz/aboocode.git
cd aboocode
./install.sh
```

This will install dependencies, build the binary, and add `aboo` to your PATH.

You can customize the install location:

```bash
# Change where the binary is linked (default: /usr/local/bin)
ABOOCODE_BIN_DIR=~/.local/bin ./install.sh
```

#### Manual Install (from source)

##### Prerequisites

- **Bun 1.3+** — [install Bun](https://bun.sh)

##### Quick Start

```bash
# Clone the repo
git clone https://github.com/cytsaiap-xyz/aboocode.git
cd aboocode

# Install dependencies
bun install

# Run in development mode (TUI)
bun dev
```

#### Run Against a Specific Directory

```bash
bun dev /path/to/your/project

# Run against the aboocode repo itself
bun dev .
```

#### Build a Standalone Binary

```bash
# Compile for your platform
./packages/aboocode/script/build.ts --single

# Run it
./packages/aboocode/dist/aboocode-<platform>/bin/aboo
```

Replace `<platform>` with your platform (e.g., `darwin-arm64`, `linux-x64`).

#### Use `aboo` Command Globally

After installing from source, you can make the `aboo` command available system-wide:

**Option 1: Bun link (recommended for development)**

```bash
cd packages/aboocode
bun link
```

**Option 2: Symlink the standalone binary**

```bash
# Build first
./packages/aboocode/script/build.ts --single

# Symlink to your PATH
ln -s $(pwd)/packages/aboocode/dist/aboocode-<platform>/bin/aboo /usr/local/bin/aboo
```

**Option 3: Shell alias**

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
alias aboo="bun run --cwd /path/to/aboocode dev"
```

Then run `aboo` from anywhere to start Aboocode.

#### Available Commands

| Command | Description |
|---------|-------------|
| `bun dev` | Start TUI (interactive terminal UI) |
| `bun dev <directory>` | Start TUI in a specific directory |
| `bun dev serve` | Start headless API server |
| `bun dev serve --port 8080` | Start API server on custom port |
| `bun dev web` | Start server + open web interface |

### Agents

Aboocode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

### Publishing to npm

To publish all packages (`aboocode`, `aboocode-ai`, and platform-specific binaries) to npm:

1. **Switch to master** and make sure it's up to date:

```bash
git checkout master
git pull origin master
```

2. **Build** the binary:

```bash
cd packages/aboocode
bun run script/build.ts --skip-install --single
```

3. **Run the publish script** directly (do NOT use `npm publish`):

```bash
bun run script/publish.ts
```

> **Important:** Do not run `npm publish` directly — it will publish the raw `package.json` which contains `workspace:*` dependencies that npm cannot resolve. The publish script creates clean package.json files for each published package.

This publishes:
- `aboocode` — the main installable package
- `aboocode-ai` — wrapper package with postinstall
- `aboocode-<platform>` — platform-specific binary packages (e.g. `aboocode-linux-x64`)

### Contributing

If you're interested in contributing to Aboocode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Aboocode can be used with Claude, OpenAI, Google, or even local models. As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important.
- Out-of-the-box LSP support
- A focus on TUI. We are going to push the limits of what's possible in the terminal.
- A client/server architecture. This, for example, can allow Aboocode to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.

---

**Based on [OpenCode](https://github.com/cytsaiap-xyz/aboocode)**
