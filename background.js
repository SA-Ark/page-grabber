// Page Grabber v1.1.0 — Background Service Worker
// Original install listener + WebSocket Bridge Client

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Page Grabber] installed. Output folder: Downloads/page-grabber/');
});

// --- WebSocket Bridge Client ---

let ws = null;
let reconnectTimer = null;
const RECONNECT_DELAY = 5000;

async function connect() {
  const { bridgeUrl, bridgeToken } = await chrome.storage.local.get(['bridgeUrl', 'bridgeToken']);
  if (!bridgeUrl || !bridgeToken) return;

  try {
    ws = new WebSocket(`${bridgeUrl}?token=${bridgeToken}`);
  } catch (err) {
    console.error('[Bridge] WebSocket creation failed:', err.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Bridge] Connected to', bridgeUrl);
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#0a6e0a' });
    clearTimeout(reconnectTimer);
    broadcast({ type: 'status', connected: true });
  };

  ws.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data);
      const response = await executeCommand(command);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    } catch (err) {
      console.error('[Bridge] Failed to handle message:', err);
    }
  };

  ws.onclose = () => {
    console.log('[Bridge] Disconnected');
    ws = null;
    chrome.action.setBadgeText({ text: '' });
    broadcast({ type: 'status', connected: false });
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[Bridge] WebSocket error:', err);
    if (ws) ws.close();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  chrome.storage.local.get('bridgeEnabled', (data) => {
    if (data.bridgeEnabled) {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    }
  });
}

function disconnect() {
  chrome.storage.local.set({ bridgeEnabled: false });
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
  chrome.action.setBadgeText({ text: '' });
  broadcast({ type: 'status', connected: false });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// --- Command Executor ---

// Security note: execute_script intentionally evaluates remote expressions.
// This is the core purpose of the bridge — allowing a trusted, token-authenticated
// remote server to run arbitrary JS in the user's authenticated browser context.
// The token-based auth on the WebSocket connection is the security boundary.

async function executeCommand(cmd) {
  const { id, command, params = {} } = cmd;
  try {
    let data;
    switch (command) {
      case 'get_tabs': {
        const tabs = await chrome.tabs.query({});
        data = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
        break;
      }
      case 'navigate': {
        const tab = params.tabId
          ? await chrome.tabs.update(params.tabId, { url: params.url })
          : await chrome.tabs.create({ url: params.url });
        await new Promise(r => {
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              r();
            }
          });
        });
        data = { tabId: tab.id, url: params.url };
        break;
      }
      case 'get_content': {
        const tabId = params.tabId || (await getActiveTabId());
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (selector) => {
            const el = selector
              ? document.querySelector(selector)
              : (document.querySelector('main, article, [role="main"]') || document.body);
            return {
              url: location.href,
              title: document.title,
              text: el ? el.innerText : '',
              html: el ? el.innerHTML : '',
            };
          },
          args: [params.selector || null]
        });
        data = result;
        break;
      }
      case 'click': {
        const tabId = params.tabId || (await getActiveTabId());
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (selector) => {
            const el = document.querySelector(selector);
            if (!el) return { error: 'Element not found: ' + selector };
            el.click();
            return { clicked: selector };
          },
          args: [params.selector]
        });
        data = result;
        break;
      }
      case 'type': {
        const tabId = params.tabId || (await getActiveTabId());
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (selector, text) => {
            const el = document.querySelector(selector);
            if (!el) return { error: 'Element not found: ' + selector };
            el.focus();
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { typed: text, selector };
          },
          args: [params.selector, params.text]
        });
        data = result;
        break;
      }
      case 'execute_script': {
        // Execute expression in the PAGE context (not service worker).
        // This is the bridge's core remote-exec capability — intentional dynamic evaluation.
        // Security boundary: token-authenticated WebSocket connection to trusted relay server.
        // MV3 CSP blocks new Function() in service workers, so we pass the expression
        // as a string arg and evaluate it in the content script (page context).
        const tabId = params.tabId || (await getActiveTabId());
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (expr) => {
            // Intentional: remote-exec is this tool's purpose. Auth is at the WS layer.
            return (0, eval)(expr); // indirect eval in page context
          },
          args: [params.expression]
        });
        data = result;
        break;
      }
      case 'screenshot': {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        data = { dataUrl };
        break;
      }
      case 'get_snapshot': {
        const tabId = params.tabId || (await getActiveTabId());
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            function snap(el, depth = 0) {
              if (depth > 6) return null;
              const tag = el.tagName?.toLowerCase();
              if (!tag || ['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return null;
              const node = { tag };
              const role = el.getAttribute('role');
              const label = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
              if (role) node.role = role;
              if (label) node.label = label;
              if (['a'].includes(tag)) node.href = el.href;
              if (['input', 'select', 'textarea'].includes(tag)) {
                node.type = el.type; node.value = el.value; node.name = el.name;
              }
              if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'label', 'li', 'td', 'th'].includes(tag)) {
                const t = el.textContent?.trim().slice(0, 200);
                if (t) node.text = t;
              }
              const kids = [...el.children].map(c => snap(c, depth + 1)).filter(Boolean);
              if (kids.length) node.children = kids;
              return node;
            }
            return snap(document.body);
          }
        });
        data = result;
        break;
      }
      default:
        return { id, success: false, error: `Unknown command: ${command}` };
    }
    return { id, success: true, data };
  } catch (err) {
    return { id, success: false, error: err.message };
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab.id;
}

// --- Message Handler (from popup) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    chrome.storage.local.set({ bridgeEnabled: true });
    connect().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'getStatus') {
    sendResponse({ connected: ws !== null && ws.readyState === WebSocket.OPEN });
    return;
  }
});

// --- Service Worker Keep-Alive ---
// MV3 service workers die after ~30s of inactivity, killing our WebSocket.
// Use chrome.alarms to wake the worker every 25s and maintain the connection.

chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.4 }); // ~24 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-keepalive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send a ping to keep the connection alive
      ws.send(JSON.stringify({ id: 'keepalive', command: 'ping', params: {} }));
    }
  }
});

// Auto-reconnect on service worker startup if bridge was enabled
chrome.storage.local.get('bridgeEnabled', (data) => {
  if (data.bridgeEnabled) {
    connect();
  }
});
