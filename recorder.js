// Claude Workflows — page recorder (content script)
//
// SECURITY MODEL: this script records WHAT you interacted with, never what you
// typed. Input values are never read, never stored, never transmitted. Password
// and other sensitive fields are additionally flagged so the exported skill says
// "autofill from Chrome — never stored" at that step.

(() => {
  if (window.__claudeVaultRecorder) return;
  window.__claudeVaultRecorder = true;

  let active = false;
  let badge = null;

  // ---------- element description helpers ----------

  const clip = (s, n = 48) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  function fieldLabel(el) {
    // aria-label
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return `the "${clip(aria)}" field`;
    // associated <label>
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return `the "${clip(lab.textContent)}" field`;
    }
    const wrapping = el.closest && el.closest('label');
    if (wrapping && wrapping.textContent.trim()) return `the "${clip(wrapping.textContent)}" field`;
    if (el.placeholder) return `the "${clip(el.placeholder)}" field`;
    if (el.name) return `the "${el.name}" field`;
    if (el.id) return `the "#${el.id}" field`;
    return `a ${el.type || el.tagName.toLowerCase()} field`;
  }

  function describeClickable(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    const text = clip(el.innerText || el.value || '');
    const tag = el.tagName.toLowerCase();
    const noun =
      tag === 'a' ? 'the link' :
      tag === 'button' || el.getAttribute('role') === 'button' || el.type === 'submit' || el.type === 'button' ? 'the button' :
      'the element';
    if (aria) return `${noun} "${clip(aria)}"`;
    if (text) return `${noun} "${text}"`;
    if (el.title) return `${noun} "${clip(el.title)}"`;
    if (el.id) return `${noun} #${el.id}`;
    return noun;
  }

  function cssPath(el) {
    try {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      const testid = el.getAttribute && el.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      // shallow structural path (max 3 levels)
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 3) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
          if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    } catch {
      return '';
    }
  }

  const SECRET_HINTS = /pass|pwd|otp|2fa|mfa|cvv|cvc|ssn|secret|token|pin|card.?number|security.?code/i;

  function isSecretField(el) {
    if (el.type === 'password') return true;
    const probe = [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
    return SECRET_HINTS.test(probe);
  }

  // ---------- event capture ----------

  function send(step) {
    try {
      chrome.runtime.sendMessage({ type: 'step', step: { ...step, ts: Date.now() } });
    } catch {
      /* extension reloaded mid-session; ignore */
    }
  }

  function onClick(e) {
    if (!active) return;
    const raw = e.target;
    if (badge && badge.contains(raw)) return;
    const el =
      (raw.closest && raw.closest('a,button,[role="button"],input,select,textarea,summary')) || raw;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    // Focusing text fields isn't a step worth recording — typing is captured on change.
    if (tag === 'textarea' || tag === 'select') return;
    if (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image'].includes(el.type)) return;
    if (tag === 'input' && ['checkbox', 'radio'].includes(el.type)) return; // captured on change
    send({ kind: 'click', text: `Click ${describeClickable(el)}`, selector: cssPath(el) });
  }

  function onChange(e) {
    if (!active) return;
    const el = e.target;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';

    if (tag === 'input') {
      if (isSecretField(el)) {
        send({
          kind: 'secret',
          text: `Enter credentials in ${fieldLabel(el)} — value NOT recorded; autofills from Chrome's password manager or the saved session`,
          selector: cssPath(el)
        });
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        send({
          kind: 'toggle',
          text: `${el.checked ? 'Select' : 'Unselect'} ${fieldLabel(el)}`,
          selector: cssPath(el)
        });
      } else {
        send({
          kind: 'type',
          text: `Fill in ${fieldLabel(el)} (value not recorded — ask the user if it isn't obvious from context)`,
          selector: cssPath(el)
        });
      }
    } else if (tag === 'textarea') {
      send({ kind: 'type', text: `Fill in ${fieldLabel(el)} (value not recorded)`, selector: cssPath(el) });
    } else if (tag === 'select') {
      send({ kind: 'select', text: `Choose an option in ${fieldLabel(el)}`, selector: cssPath(el) });
    }
  }

  function onKeydown(e) {
    if (!active) return;
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (el && el.tagName && el.tagName.toLowerCase() === 'input') {
      send({ kind: 'key', text: `Press Enter in ${fieldLabel(el)}`, selector: cssPath(el) });
    }
  }

  function onSubmit(e) {
    if (!active) return;
    const form = e.target;
    const name = form.getAttribute('aria-label') || form.name || form.id || '';
    send({ kind: 'submit', text: name ? `Submit the "${clip(name)}" form` : 'Submit the form' });
  }

  // ---------- recording badge ----------

  function showBadge() {
    if (badge) return;
    badge = document.createElement('div');
    badge.setAttribute('style', [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px',
      'background:#1a1523', 'color:#f5f0ff',
      'border:1px solid #7c5cff', 'border-radius:10px',
      'padding:8px 12px', 'font:12px/1.4 system-ui,sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'pointer-events:none'
    ].join(';'));
    badge.innerHTML =
      '<span style="width:8px;height:8px;border-radius:50%;background:#ff5470;display:inline-block;animation:cvpulse 1.2s infinite"></span>' +
      '<span><b>Claude Workflows</b> recording steps — never values</span>';
    const style = document.createElement('style');
    style.textContent = '@keyframes cvpulse{0%,100%{opacity:1}50%{opacity:.35}}';
    badge.appendChild(style);
    document.documentElement.appendChild(badge);
  }

  function hideBadge() {
    if (badge) { badge.remove(); badge = null; }
  }

  // ---------- lifecycle ----------

  function activate() {
    if (active) return;
    active = true;
    showBadge();
  }

  function deactivate() {
    active = false;
    hideBadge();
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('submit', onSubmit, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'rec-on') activate();
    if (msg.type === 'rec-off') deactivate();
  });

  // On load (including after navigation mid-recording), ask if this tab is recording.
  try {
    chrome.runtime.sendMessage({ type: 'get-state' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.isTab) activate();
    });
  } catch {
    /* ignore */
  }
})();
