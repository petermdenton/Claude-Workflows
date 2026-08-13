// Claude Vault — background service worker
// Holds the in-progress recording in session storage (cleared when Chrome closes)
// and the saved procedure library in local storage. No credential values ever pass
// through here — the content script never captures them in the first place.

async function getRec() {
  const { rec } = await chrome.storage.session.get('rec');
  return rec || null;
}

async function setRec(rec) {
  await chrome.storage.session.set({ rec });
}

async function clearRec() {
  await chrome.storage.session.remove('rec');
}

function notifyTab(tabId, type) {
  return chrome.tabs.sendMessage(tabId, { type }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'start': {
          const rec = {
            tabId: msg.tabId,
            name: msg.name,
            startUrl: msg.url,
            startedAt: Date.now(),
            steps: [
              { kind: 'navigate', text: `Go to ${msg.url}`, url: msg.url, ts: Date.now() }
            ]
          };
          await setRec(rec);
          // Inject the recorder in case the page was opened before the extension
          // was (re)loaded — recorder.js guards against double-injection.
          try {
            await chrome.scripting.executeScript({
              target: { tabId: msg.tabId },
              files: ['recorder.js']
            });
          } catch (e) {
            /* page may not allow injection (chrome://, file:// without access) */
          }
          await notifyTab(msg.tabId, 'rec-on');
          sendResponse({ ok: true });
          break;
        }

        case 'stop': {
          const rec = await getRec();
          if (rec) {
            const proc = {
              id: 'p' + Date.now(),
              name: rec.name,
              startUrl: rec.startUrl,
              createdAt: Date.now(),
              steps: rec.steps
            };
            const { procedures = [] } = await chrome.storage.local.get('procedures');
            procedures.unshift(proc);
            await chrome.storage.local.set({ procedures });
            await clearRec();
            await notifyTab(rec.tabId, 'rec-off');
            autoExport(proc); // fire-and-forget: SKILL.md → Downloads/ClaudeVault/
          }
          sendResponse({ ok: true });
          break;
        }

        case 'cancel': {
          const rec = await getRec();
          if (rec) {
            await clearRec();
            await notifyTab(rec.tabId, 'rec-off');
          }
          sendResponse({ ok: true });
          break;
        }

        case 'step': {
          const rec = await getRec();
          if (rec && sender.tab && sender.tab.id === rec.tabId) {
            const last = rec.steps[rec.steps.length - 1];
            // Collapse immediate duplicates (e.g. double-fired change events)
            if (!last || last.text !== msg.step.text) {
              rec.steps.push(msg.step);
              await setRec(rec);
            }
          }
          sendResponse({ ok: true });
          break;
        }

        case 'get-state': {
          const rec = await getRec();
          sendResponse({
            rec,
            isTab: sender.tab ? !!(rec && sender.tab.id === rec.tabId) : undefined
          });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Track page navigations on the recorded tab (full loads and SPA history changes
// both surface through tabs.onUpdated with a url change).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const rec = await getRec();
  if (!rec || tabId !== rec.tabId) return;

  const lastNav = [...rec.steps].reverse().find((s) => s.kind === 'navigate');
  if (lastNav && lastNav.url === changeInfo.url) return;

  rec.steps.push({
    kind: 'navigate',
    text: `Arrive at ${changeInfo.url}`,
    url: changeInfo.url,
    ts: Date.now()
  });
  await setRec(rec);
});

// ---------- auto-export: vault sync folder ----------
// Every saved procedure is also written as a SKILL.md into
// Downloads/ClaudeVault/ so a connected Claude (Cowork) session can pick it
// up automatically — no manual export needed. The file contains procedure
// steps only; credentials are never recorded anywhere.

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'procedure';

const hostOf = (url) => { try { return new URL(url).hostname || url; } catch { return url; } };

function skillMd(p) {
  const host = hostOf(p.startUrl);
  const hasSecret = p.steps.some((s) => s.kind === 'secret');
  const lines = p.steps.map((s, i) => {
    let line = `${i + 1}. ${s.text}`;
    if (s.selector && s.kind !== 'navigate' && s.kind !== 'submit') {
      line += `\n   - selector hint: \`${s.selector}\``;
    }
    return line;
  });

  return `---
name: ${slug(p.name)}
description: Replay the "${p.name}" procedure on ${host}, recorded with Claude Vault. Use when the user asks to ${p.name.toLowerCase()} or perform this task on ${host}.
---

# ${p.name}

Recorded with Claude Vault on ${new Date(p.createdAt).toISOString().slice(0, 10)} from ${p.startUrl}.
This is a procedure playbook: it contains navigation steps only — **no credentials are stored in this file.**

## How to run

Use the browser (Claude in Chrome) on the user's own Chrome profile so saved
sessions and the Chrome password manager are available. Follow the steps in
order. Selector hints are from recording time and may have changed — prefer
finding elements by their visible label.

## Steps

${lines.join('\n')}

## Credentials & security
${hasSecret ? `
- Step(s) marked as credential entry contain **no stored value**.
- Expected behavior: the field autofills from Chrome's password manager, or the
  site is already logged in via the saved browser session.
- If neither happens, STOP and ask the user to enter their credentials
  themselves. Never ask the user to paste a password into chat.` : `
- No credential fields were recorded in this procedure.
- If the site unexpectedly asks for a login, pause and ask the user to log in
  themselves, then continue.`}

## If the site has changed

If a step's element can't be found, look for an equivalent control by label or
purpose. If the flow has changed materially, tell the user this recording is
stale and offer to re-record it with Claude Vault.
`;
}

function autoExport(proc) {
  try {
    const md = skillMd(proc);
    const url = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);
    chrome.downloads.download(
      {
        url,
        filename: `ClaudeVault/${slug(proc.name)}-SKILL.md`,
        conflictAction: 'overwrite',
        saveAs: false
      },
      () => void chrome.runtime.lastError // swallow errors; manual export still works
    );
  } catch {
    /* non-fatal — the vault copy is already saved */
  }
}

// If the recorded tab is closed, discard the in-progress recording.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec && rec.tabId === tabId) await clearRec();
});
