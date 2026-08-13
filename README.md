# Claude Vault 🔒

Record website procedures as secure, credential-free playbooks that Claude can replay.

Inspired by Grok Bot's record-a-workflow flow — built for Claude. Record a web workflow once in your own Chrome; it becomes a [Claude skill](https://docs.claude.com) you can invoke from any chat ("sign in to the console and generate the report") or run on a schedule. Steps get recorded — passwords never do. They stay in Chrome's password manager, and Claude expects autofill at replay time.

Built in an afternoon with Claude (Cowork). MIT licensed.

**The two-halves security model:** the vault stores the *procedure* (where you went, what you clicked). Your *secrets* stay where they already live — Chrome's password manager and your logged-in sessions. Nothing you type is ever captured, and password fields are specially flagged so exported playbooks tell Claude to rely on Chrome autofill instead.

## Install (20 seconds)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `claude-vault` folder.
4. Pin the lock icon from the puzzle-piece menu.

## Use

1. Go to any website and click the Claude Vault icon.
2. Hit **Record a procedure on this page**, name it, and start.
3. Do the task once in the page — a small badge reminds you it's recording steps, never values. Type passwords freely; they are not captured.
4. Click the icon again → **Stop & save to vault**.
5. **Automatic handoff:** every save also writes a `SKILL.md` to `Downloads/ClaudeVault/`. Connect that folder to a Claude (Cowork) session once, and Claude picks up new recordings by itself — no manual export.
6. **Save Skill:** open a procedure → **Save Skill** packages it as a ready-to-install `<name>.skill` file in `Downloads/ClaudeVault/`. Drop it on Claude and approve the save — Claude requires your explicit approval to install skills (by design: skills are instructions, and nothing should be able to install instructions into your agent silently).
7. Manual route still works too: **SKILL.md** / **Copy** and give it to Claude.

## What gets recorded

- Page navigations (URLs)
- Clicks on buttons and links (by their visible label)
- *That* you filled in a field — identified by its label, never its value
- Credential fields, flagged as "autofills from Chrome — never stored"

## What never gets recorded

- Anything you type: passwords, usernames, form values, search queries
- Screenshots or video
- Nothing leaves your browser — procedures live in `chrome.storage.local` on your machine only

## Files

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 extension config |
| `background.js` | Service worker: recording state, navigation tracking, vault storage |
| `recorder.js` | Content script: captures steps (never values) on the page |
| `popup.html/.css/.js` | The vault UI: library, record flow, SKILL.md export |
