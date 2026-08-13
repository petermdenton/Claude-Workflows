// Claude Vault — popup UI

const view = document.getElementById('view');
let pollTimer = null;

const msg = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (ts) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getProcedures() {
  const { procedures = [] } = await chrome.storage.local.get('procedures');
  return procedures;
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------- views ----------------

async function render() {
  stopPolling();
  const state = await msg({ type: 'get-state' });
  if (state && state.rec) return renderRecording(state.rec);
  return renderList();
}

async function renderList() {
  const procedures = await getProcedures();
  const tab = await activeTab();
  const recordable = tab && /^(https?|file):/.test(tab.url || '');

  let listHtml;
  if (procedures.length === 0) {
    listHtml = `
      <div class="empty">
        <div class="lock">🔒</div>
        <div>The vault is empty.</div>
        <div style="margin-top:4px;font-size:11.5px">Go to a website, hit record, and walk through the task once.</div>
      </div>`;
  } else {
    listHtml = procedures.map((p) => `
      <div class="card proc" data-id="${esc(p.id)}">
        <div class="name">${esc(p.name)}</div>
        <div class="meta">${esc(hostOf(p.startUrl))} · ${p.steps.length} steps · saved ${fmtDate(p.createdAt)}</div>
      </div>`).join('');
  }

  view.innerHTML = `
    <button class="btn-primary" id="new" ${recordable ? '' : 'disabled'}>
      <span class="record-dot"></span>Record a procedure on this page
    </button>
    ${recordable ? '' : `<div class="warn">Open a normal website tab to record (Chrome pages can't be recorded).</div>`}
    ${recordable && tab.url.startsWith('file:') ? `<div class="warn">Local file — make sure "Allow access to file URLs" is ON for Claude Vault in chrome://extensions, or the recorder can't see this page.</div>` : ''}
    <div style="height:12px"></div>
    ${listHtml}
  `;

  if (recordable) {
    document.getElementById('new').addEventListener('click', () => renderNameForm(tab));
  }
  view.querySelectorAll('.proc').forEach((el) =>
    el.addEventListener('click', () => renderDetail(el.dataset.id)));
}

async function renderNameForm(tab) {
  const suggested = `Task on ${hostOf(tab.url)}`;
  view.innerHTML = `
    <span class="back" id="back">← Back</span>
    <div class="card">
      <label class="field-label">Name this procedure</label>
      <input type="text" id="name" value="${esc(suggested)}" />
      <div class="warn" style="margin-top:10px">
        While recording: your clicks and page moves are captured as steps.
        Anything you type — especially passwords — is <b>never</b> captured.
      </div>
      <div class="btn-row">
        <button class="btn-primary" id="go"><span class="record-dot"></span>Start recording</button>
      </div>
    </div>
  `;
  document.getElementById('back').addEventListener('click', render);
  const input = document.getElementById('name');
  input.focus(); input.select();
  document.getElementById('go').addEventListener('click', async () => {
    const name = input.value.trim() || suggested;
    await msg({ type: 'start', tabId: tab.id, url: tab.url, name });
    window.close(); // hand the page back to the user
  });
}

function renderRecording(rec) {
  view.innerHTML = `
    <div class="rec-banner">
      <div><span class="record-dot"></span><b>Recording “${esc(rec.name)}”</b></div>
      <div class="count" id="count">${rec.steps.length}</div>
      <div class="hint">steps captured on ${esc(hostOf(rec.startUrl))} — do the task in the page, then come back here.</div>
    </div>
    <div class="btn-row">
      <button class="btn-primary" id="stop">Stop &amp; save to vault</button>
      <button class="btn-danger" id="discard">Discard</button>
    </div>
  `;
  document.getElementById('stop').addEventListener('click', async () => {
    await msg({ type: 'stop' });
    render();
  });
  document.getElementById('discard').addEventListener('click', async () => {
    await msg({ type: 'cancel' });
    render();
  });
  pollTimer = setInterval(async () => {
    const state = await msg({ type: 'get-state' });
    const count = document.getElementById('count');
    if (state && state.rec && count) count.textContent = state.rec.steps.length;
  }, 700);
}

async function renderDetail(id) {
  stopPolling();
  const procedures = await getProcedures();
  const p = procedures.find((x) => x.id === id);
  if (!p) return renderList();

  view.innerHTML = `
    <span class="back" id="back">← Vault</span>
    <div class="detail-title">${esc(p.name)}</div>
    <div class="detail-meta">${esc(hostOf(p.startUrl))} · recorded ${fmtDate(p.createdAt)}</div>
    <ol class="steps">
      ${p.steps.map((s) => `
        <li class="${s.kind === 'secret' ? 'secret' : ''}">
          <span class="kind">${esc(s.kind)}</span>${esc(s.text)}
        </li>`).join('')}
    </ol>
    <div class="btn-row">
      <button class="btn-primary" id="saveskill">Save Skill</button>
      <button class="btn-ghost" id="export">SKILL.md</button>
      <button class="btn-ghost" id="copy">Copy</button>
      <button class="btn-danger" id="del">Delete</button>
    </div>
    <div id="note"></div>
  `;

  document.getElementById('back').addEventListener('click', render);
  document.getElementById('saveskill').addEventListener('click', () => {
    const name = slug(p.name);
    const zip = makeZip([{ path: `${name}/SKILL.md`, text: skillMd(p) }]);
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    chrome.downloads.download(
      { url, filename: `ClaudeVault/${name}.skill`, conflictAction: 'overwrite', saveAs: false },
      () => {
        void chrome.runtime.lastError;
        note(`${name}.skill packaged into Downloads/ClaudeVault — drop it on Claude and approve the save. (Claude requires your approval to install skills — by design.)`);
      }
    );
  });
  document.getElementById('export').addEventListener('click', () => {
    const blob = new Blob([skillMd(p)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(p.name)}-SKILL.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    note('SKILL.md downloaded — give it to Claude to save as a skill.');
  });
  document.getElementById('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(skillMd(p));
    note('Copied — paste it to Claude.');
  });
  document.getElementById('del').addEventListener('click', async () => {
    const remaining = procedures.filter((x) => x.id !== id);
    await chrome.storage.local.set({ procedures: remaining });
    renderList();
  });

  function note(t) {
    document.getElementById('note').innerHTML = `<div class="toast">${esc(t)}</div>`;
  }
}

// ---------------- .skill packaging (minimal zip writer, STORE method) ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Build an uncompressed zip from [{path, text}] entries — enough for a .skill file.
function makeZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const { path, text } of entries) {
    const name = enc.encode(path);
    const data = enc.encode(text);
    const crc = crc32(data);

    const local = [
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
    ];
    const localSize = local.reduce((s, a) => s + a.length, 0);
    chunks.push(...local);

    central.push({
      parts: [
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), name
      ]
    });
    offset += localSize;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) {
    for (const p of c.parts) { chunks.push(p); centralSize += p.length; }
  }

  chunks.push(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralSize), u32(centralStart), u16(0)
  );

  const total = chunks.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// ---------------- skill export ----------------

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'procedure';

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

render();
