# MeetNote Desktop — Claude Code Context

## Vault (source of truth — keep it in sync)
Full project context lives in ~/MeetNote-Vault/MeetNote/ (Obsidian).
At the START of every session: read master.md, then whichever of bugs.md, pending.md, builds.md, stack.md are relevant.

At the END of every session, WITHOUT being asked:
1. Append a summary to ~/MeetNote-Vault/MeetNote/sessions/YYYY-MM-DD.md (today's date): what changed, what was fixed/shipped, what needs testing, what's next. Add the date to sessions/index.md if it isn't there.
2. bugs.md — move fixed bugs to Fixed (with date), add new bugs found.
3. pending.md — check off completed tasks, add new ones.
4. builds.md — log any EAS build, OTA (eas update), desktop installer, or deploy.
5. master.md — update "Current State" and "Next priorities" if they changed.
Other Claude sessions (project threads, the daily watcher) read and write the vault too: re-read a file right before editing it and keep edits small.

## Hard rules (always)
- NO attribution lines in git commits (no Co-Authored-By, no Claude-Session)
- NEVER read ~/Projects/MeetNote/web/app/admin/config.ts — admin password
- Mobile has NO git — EAS only, never git add/commit for mobile
- EAS build limit 12/month — OTA (eas update) first, build only when necessary
- Ethan does all git pushes — give him the command, don't run it
- Always say which terminal you're in (this repo: desktop)
- Never guess file paths

## Stack
- Electron 28
- GitHub Actions builds (every push triggers build)
- Mac: DMG with gray background, Windows: NSIS installer

## Known issues
- FIXED Oct 11: Windows 3s audio gap (mic enumeration now cached at app launch)
- Need first-run consent screen before recording
- /debug/electron-log endpoint (on the backend) still live — needs removal
