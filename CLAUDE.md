# CLAUDE.md

The conventions for this repository live in [AGENTS.md](AGENTS.md), shared by every agent. Claude Code loads it through the import
below; do not copy its content here.

@AGENTS.md

Claude Code specifics: your commit trailer is `Co-Authored-By: Claude Code <noreply@anthropic.com>`, model-agnostic, even if your
harness suggests a model-specific one. Nothing goes to `main` directly, and you never commit or push unless asked.
