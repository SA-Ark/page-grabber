# Page Grabber

A Chrome extension that extracts full-page text content from any webpage with one click. Built for LLM-powered workflows — feed web pages directly to Claude, ChatGPT, or any AI assistant without copy-pasting.

## Features

- **One-click text extraction** — grabs clean text from any webpage, prioritizing `<main>` / `<article>` content over navigation chrome
- **Auto-pagination** — automatically clicks through multi-page documents (leases, contracts, reports) and combines everything into a single file
- **Dual export formats** — save as `.txt` (clean text with metadata header) or `.json` (includes raw HTML for table-heavy content)
- **Clipboard mode** — copy extracted text directly to clipboard
- **Smart content detection** — prefers semantic content regions (`main`, `article`, `[role="main"]`) over full `document.body`
- **Timestamped output** — files are named with `YYYYMMDD-HHMMSS_page-title.txt` for easy sorting
- **Zero configuration** — no accounts, no API keys, no background processes

## Use Cases

- **Legal document review** — extract multi-page leases, contracts, and agreements from web-based document viewers
- **Research workflows** — pull article text for summarization or analysis by AI assistants
- **Content archival** — save readable text snapshots of web pages
- **Data collection** — batch-extract content from paginated web applications

## Installation

### From source (Developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/SA-Ark/page-grabber.git
   ```

2. Open `chrome://extensions` in Chrome

3. Enable **Developer mode** (toggle in top-right corner)

4. Click **Load unpacked** and select the cloned `page-grabber` directory

5. Pin the extension icon in your toolbar for quick access

### Output

Extracted files are saved to `~/Downloads/page-grabber/` as timestamped `.txt` or `.json` files.

## Usage

1. Navigate to any webpage
2. Click the Page Grabber icon in your toolbar
3. Choose an action:
   - **Auto-grab ALL pages** — automatically paginates through the entire document
   - **Grab this page** — save current page as `.txt`
   - **Grab this page (.json)** — save with raw HTML included
   - **Copy to clipboard** — copy extracted text

### Connecting to an AI assistant

Point your AI assistant's workspace or file context to `~/Downloads/page-grabber/`. Every click saves a new file that your assistant can read automatically.

## Architecture

```
page-grabber/
├── manifest.json      # MV3 manifest — permissions, icons, service worker
├── popup.html         # Extension popup UI (280px, 4 action buttons)
├── popup.js           # Content extraction logic + auto-pagination engine
├── background.js      # Service worker (install logging)
└── icons/             # Extension icons (16, 48, 128px)
```

**Content extraction pipeline:**
1. `chrome.scripting.executeScript` injects extraction function into active tab
2. Function queries for semantic content containers (`main > article > body` fallback chain)
3. Returns structured data: `{ url, title, text, html, timestamp, wordCount }`
4. `chrome.downloads.download` saves to `page-grabber/` subdirectory

**Auto-pagination engine:**
1. Detects page count from common patterns (`Page X of Y`, `X/Y`)
2. Finds "Next" button via 20+ CSS selector patterns covering major document viewers
3. Clicks through pages with 1.5s delay for content loading
4. Detects end-of-document via disabled state or missing next button
5. Combines all pages into single timestamped output file

## Technical Details

- **Manifest V3** — uses the latest Chrome extension platform
- **Minimal permissions** — `activeTab` (current tab only), `scripting` (text extraction), `downloads` (file saving), `clipboardWrite` (copy mode)
- **No background persistence** — service worker idles when not in use
- **No remote code** — all logic runs locally, no external requests
- **No data collection** — extracted content stays on your machine

## Limitations

- Cannot extract text from `chrome://` or `chrome-extension://` pages
- Canvas-rendered PDF viewers (where text is painted as pixels) require OCR — this extension extracts DOM text only
- Auto-pagination relies on detectable "Next" buttons; custom JavaScript-only navigation may not be detected

## License

MIT
