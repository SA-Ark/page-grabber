const statusEl = document.getElementById('status');
const setStatus = (msg) => { statusEl.textContent = msg; };

// --- Bridge UI ---
const dot = document.getElementById('bridge-dot');
const bridgeLabel = document.getElementById('bridge-label');
const toggleBtn = document.getElementById('bridge-toggle');
const urlInput = document.getElementById('bridge-url');
const tokenInput = document.getElementById('bridge-token');

function updateBridgeUI(connected) {
  dot.style.background = connected ? '#0a6e0a' : '#ccc';
  bridgeLabel.textContent = connected ? 'Bridge: Connected' : 'Bridge: Disconnected';
  bridgeLabel.style.color = connected ? '#0a6e0a' : '#888';
  toggleBtn.textContent = connected ? 'Disconnect' : 'Connect Bridge';
  toggleBtn.style.background = connected ? '#c00' : '#0a6e0a';
}

// Load saved settings
chrome.storage.local.get(['bridgeUrl', 'bridgeToken', 'bridgeEnabled'], (data) => {
  urlInput.value = data.bridgeUrl || 'wss://bridge.chakrakali.com/ws/extension';
  tokenInput.value = data.bridgeToken || '';
  chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
    if (resp) updateBridgeUI(resp.connected);
  });
});

toggleBtn.onclick = async () => {
  const resp = await new Promise(r => chrome.runtime.sendMessage({ type: 'getStatus' }, r));
  if (resp?.connected) {
    chrome.runtime.sendMessage({ type: 'disconnect' });
    updateBridgeUI(false);
  } else {
    const url = urlInput.value.trim();
    const token = tokenInput.value.trim();
    if (!url || !token) { setStatus('Enter relay URL and token'); return; }
    await chrome.storage.local.set({ bridgeUrl: url, bridgeToken: token });
    chrome.runtime.sendMessage({ type: 'connect' }, () => {});
    setStatus('Connecting...');
    // Clear stale status once connected (status update comes via broadcast)
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'getStatus' }, (r) => {
        if (r?.connected) setStatus('');
      });
    }, 2000);
  }
};

// Listen for status updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') updateBridgeUI(msg.connected);
});
// --- End Bridge UI ---

// --- Existing Page Grabber Functionality ---

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab;
}

async function grabFromTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: () => {
      const pickText = () => {
        const main = document.querySelector('main, article, [role="main"]');
        const src = main || document.body;
        return src ? src.innerText : '';
      };
      return {
        url: location.href,
        title: document.title,
        text: pickText(),
        html: document.documentElement.outerHTML,
        timestamp: new Date().toISOString(),
        wordCount: (document.body?.innerText || '').trim().split(/\s+/).length
      };
    }
  });
  return result;
}

function safeName(s) {
  return (s || 'page').replace(/[^a-z0-9\-_.]+/gi, '_').slice(0, 80);
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: `page-grabber/${filename}`, saveAs: false });
}

// Auto-grab: clicks through all pages, collects text, saves one combined file
document.getElementById('auto-grab').onclick = async () => {
  try {
    const tab = await activeTab();
    if (!/^https?:/.test(tab.url || '')) {
      throw new Error('Extension only works on http/https pages.');
    }
    setStatus('Starting auto-grab...\nScanning for pagination...');

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        return new Promise(async (resolve) => {
          const delay = (ms) => new Promise(r => setTimeout(r, ms));
          const allPages = [];
          let pageNum = 0;
          let maxPages = 200;

          const findPageInfo = () => {
            const body = document.body.innerText;
            const match = body.match(/(?:page\s+\d+\s+of\s+(\d+)|\d+\s*\/\s*(\d+)|(\d+)\s+pages)/i);
            if (match) return parseInt(match[1] || match[2] || match[3]);
            return null;
          };

          const findNextButton = () => {
            const selectors = [
              'a[id*="Next"]', 'a[id*="next"]', 'button[id*="Next"]', 'button[id*="next"]',
              'a[class*="next"]', 'button[class*="next"]',
              'a[title*="Next"]', 'button[title*="Next"]',
              'a[aria-label*="Next"]', 'button[aria-label*="Next"]',
              '[class*="next-page"]', '[class*="nextPage"]',
              '[class*="page-next"]', '[class*="pageNext"]',
              'a[class*="arrow-right"]', 'button[class*="arrow-right"]',
              'a[class*="forward"]', 'button[class*="forward"]',
              '.pagination a:last-child', '.pager .next a',
              'nav[aria-label*="pagination"] a:last-child',
              'a > .fa-chevron-right', 'a > .fa-arrow-right',
              'button > .fa-chevron-right', 'button > .fa-arrow-right',
              'img[alt*="Next"]', 'img[title*="Next"]',
              'input[value*="Next"]', 'input[value*=">"]',
              'a[href*="javascript"][id*="Next"]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                const clickable = el.closest('a, button') || el;
                if (clickable.offsetParent !== null) return clickable;
              }
            }
            const allButtons = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')];
            for (const b of allButtons) {
              const txt = (b.textContent || b.value || '').trim();
              if (/^(next|next\s*page|>|›|»|→)$/i.test(txt) && b.offsetParent !== null) return b;
            }
            return null;
          };

          const totalPages = findPageInfo();
          if (totalPages) maxPages = Math.min(totalPages, maxPages);

          while (pageNum < maxPages) {
            pageNum++;
            const main = document.querySelector('main, article, [role="main"]');
            const src = main || document.body;
            const text = src ? src.innerText : '';
            allPages.push(`\n--- PAGE ${pageNum} ---\n\n${text}`);

            const nextBtn = findNextButton();
            if (!nextBtn) break;

            if (nextBtn.disabled || nextBtn.classList.contains('disabled') ||
                nextBtn.getAttribute('aria-disabled') === 'true' ||
                nextBtn.style.opacity === '0.5' || nextBtn.style.pointerEvents === 'none') {
              break;
            }

            nextBtn.click();
            await delay(1500);
          }

          resolve({
            title: document.title,
            url: location.href,
            totalPages: pageNum,
            text: allPages.join('\n'),
            timestamp: new Date().toISOString()
          });
        });
      }
    });

    const header = `# ${result.title}\n# ${result.url}\n# ${result.timestamp}\n# Total pages grabbed: ${result.totalPages}\n\n`;
    await saveBlob(
      new Blob([header + result.text], { type: 'text/plain' }),
      `${stamp()}_FULL_${safeName(result.title)}.txt`
    );
    setStatus(`Done! Grabbed ${result.totalPages} pages\n→ ~/Downloads/page-grabber/`);
  } catch (e) { setStatus('Error: ' + e.message); }
};

document.getElementById('grab').onclick = async () => {
  try {
    setStatus('Grabbing…');
    const tab = await activeTab();
    const d = await grabFromTab(tab.id);
    const header = `# ${d.title}\n# ${d.url}\n# ${d.timestamp}\n# words: ${d.wordCount}\n\n`;
    await saveBlob(new Blob([header + d.text], { type: 'text/plain' }),
                   `${stamp()}_${safeName(d.title)}.txt`);
    setStatus(`Saved ${d.wordCount.toLocaleString()} words\n→ ~/Downloads/page-grabber/`);
  } catch (e) { setStatus('Error: ' + e.message); }
};

document.getElementById('grab-json').onclick = async () => {
  try {
    setStatus('Grabbing…');
    const tab = await activeTab();
    const d = await grabFromTab(tab.id);
    await saveBlob(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }),
                   `${stamp()}_${safeName(d.title)}.json`);
    setStatus(`Saved JSON (${(d.html.length/1024).toFixed(0)} KB HTML)\n→ ~/Downloads/page-grabber/`);
  } catch (e) { setStatus('Error: ' + e.message); }
};

document.getElementById('copy').onclick = async () => {
  try {
    const tab = await activeTab();
    const d = await grabFromTab(tab.id);
    await navigator.clipboard.writeText(d.text);
    setStatus(`Copied ${d.text.length.toLocaleString()} chars to clipboard.`);
  } catch (e) { setStatus('Error: ' + e.message); }
};
