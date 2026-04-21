const statusEl = document.getElementById('status');
const setStatus = (msg) => { statusEl.textContent = msg; };

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

    // Run the full auto-grab inside the page via a long-running content script
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        return new Promise(async (resolve) => {
          const delay = (ms) => new Promise(r => setTimeout(r, ms));
          const allPages = [];
          let pageNum = 0;
          let maxPages = 200; // safety limit

          // Try to detect total page count from the viewer
          const findPageInfo = () => {
            // Common patterns: "Page X of Y", "1/62", page counter elements
            const body = document.body.innerText;
            const match = body.match(/(?:page\s+\d+\s+of\s+(\d+)|\d+\s*\/\s*(\d+)|(\d+)\s+pages)/i);
            if (match) return parseInt(match[1] || match[2] || match[3]);
            return null;
          };

          // Find the "next page" button — common selectors for document viewers
          const findNextButton = () => {
            const selectors = [
              // SecureCafe / generic document viewers
              'a[id*="Next"]', 'a[id*="next"]', 'button[id*="Next"]', 'button[id*="next"]',
              'a[class*="next"]', 'button[class*="next"]',
              'a[title*="Next"]', 'button[title*="Next"]',
              'a[aria-label*="Next"]', 'button[aria-label*="Next"]',
              '[class*="next-page"]', '[class*="nextPage"]',
              '[class*="page-next"]', '[class*="pageNext"]',
              // Arrow buttons
              'a[class*="arrow-right"]', 'button[class*="arrow-right"]',
              'a[class*="forward"]', 'button[class*="forward"]',
              // Generic pagination
              '.pagination a:last-child', '.pager .next a',
              'nav[aria-label*="pagination"] a:last-child',
              // Icon-based next buttons
              'a > .fa-chevron-right', 'a > .fa-arrow-right',
              'button > .fa-chevron-right', 'button > .fa-arrow-right',
              // Input-based page navigation
              'img[alt*="Next"]', 'img[title*="Next"]',
              'input[value*="Next"]', 'input[value*=">"]',
              'a[href*="javascript"][id*="Next"]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                // Walk up to the clickable parent if we matched a child icon
                const clickable = el.closest('a, button') || el;
                if (clickable.offsetParent !== null) return clickable; // visible
              }
            }
            // Fallback: look for any element containing "Next" or ">" text
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
            // Grab current page text
            const main = document.querySelector('main, article, [role="main"]');
            const src = main || document.body;
            const text = src ? src.innerText : '';
            allPages.push(`\n--- PAGE ${pageNum} ---\n\n${text}`);

            // Find and click next
            const nextBtn = findNextButton();
            if (!nextBtn) {
              // No next button found — we're done or on the last page
              break;
            }

            // Check if next button is disabled
            if (nextBtn.disabled || nextBtn.classList.contains('disabled') ||
                nextBtn.getAttribute('aria-disabled') === 'true' ||
                nextBtn.style.opacity === '0.5' || nextBtn.style.pointerEvents === 'none') {
              break;
            }

            nextBtn.click();
            await delay(1500); // wait for page content to load
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
