---
name: use-agent-browser
description: Browse the web, interact with pages, take screenshots, and extract content using the agent-browser CLI. Use when asked to "open a website", "take a screenshot", "check a page", "fill a form", "click a button", "scrape content", or any browser automation task.
metadata:
  version: "1.0.0"
  argument-hint: <url-or-action>
---

# Agent Browser

Automate browser interactions using the `agent-browser` CLI (Playwright-based headless browser).

## When to Use

- Opening and inspecting web pages
- Taking screenshots or saving PDFs
- Filling forms, clicking buttons, navigating sites
- Extracting text, HTML, or attribute values from pages
- Checking element visibility or state
- Debugging frontend apps in the browser
- Testing deployed web applications

## Quick Reference

### Navigation

```bash
agent-browser open <url>              # Navigate to URL
agent-browser back                    # Go back
agent-browser forward                 # Go forward
agent-browser reload                  # Reload page
```

### Interaction

```bash
agent-browser click <selector>        # Click element (CSS selector or @ref)
agent-browser type <selector> <text>  # Type into element (appends)
agent-browser fill <selector> <text>  # Clear and fill element
agent-browser press <key>             # Press key (Enter, Tab, Control+a)
agent-browser hover <selector>        # Hover over element
agent-browser check <selector>        # Check checkbox
agent-browser uncheck <selector>      # Uncheck checkbox
agent-browser select <selector> <val> # Select dropdown option
agent-browser scroll <direction> [px] # Scroll up/down/left/right
agent-browser upload <selector> <files...> # Upload files
```

### Get Information

```bash
agent-browser get text [selector]     # Get text content
agent-browser get html [selector]     # Get HTML content
agent-browser get value <selector>    # Get input value
agent-browser get attr <name> <sel>   # Get attribute value
agent-browser get title               # Get page title
agent-browser get url                 # Get current URL
agent-browser get count <selector>    # Count matching elements
```

### Check State

```bash
agent-browser is visible <selector>   # Check if element is visible
agent-browser is enabled <selector>   # Check if element is enabled
agent-browser is checked <selector>   # Check if checkbox is checked
```

### Capture

```bash
agent-browser screenshot [path]       # Take screenshot (PNG)
agent-browser pdf <path>              # Save page as PDF
```

### AI-Optimized Inspection

```bash
agent-browser snapshot                # Full accessibility tree with @refs
agent-browser snapshot -i             # Interactive elements only
agent-browser snapshot -c             # Compact (no empty structural nodes)
agent-browser snapshot -d <n>         # Limit tree depth
agent-browser snapshot -s <selector>  # Scope to CSS selector
```

### Find Elements

```bash
agent-browser find role <value> click       # Find by ARIA role and click
agent-browser find text <value> click       # Find by text content and click
agent-browser find label <value> fill <txt> # Find by label and fill
agent-browser find placeholder <value> fill <txt> # Find by placeholder
agent-browser find testid <value> click     # Find by data-testid
```

### JavaScript

```bash
agent-browser eval <js>               # Run JavaScript in page context
```

### Sessions & Tabs

```bash
agent-browser tab new                 # Open new tab
agent-browser tab list                # List open tabs
agent-browser tab <n>                 # Switch to tab N
agent-browser tab close               # Close current tab
agent-browser --session <name> <cmd>  # Use named session for isolation
```

### Browser Settings

```bash
agent-browser set viewport <w> <h>    # Set viewport size
agent-browser set device <name>       # Emulate device (e.g., "iPhone 14")
agent-browser set media dark          # Dark mode
agent-browser set media light         # Light mode
agent-browser set offline on          # Simulate offline
```

### Network

```bash
agent-browser network requests        # View captured requests
agent-browser network route <url> --abort  # Block requests to URL
agent-browser cookies get             # Get cookies
agent-browser cookies clear           # Clear cookies
```

### Debug

```bash
agent-browser console                 # View console logs
agent-browser errors                  # View page errors
agent-browser highlight <selector>    # Highlight element visually
agent-browser trace start             # Start recording trace
agent-browser trace stop [path]       # Stop and save trace
```

## Workflow Patterns

### Pattern 1: Inspect a Page

```bash
agent-browser open "https://example.com"
agent-browser snapshot -i -c          # Get interactive elements compactly
agent-browser screenshot ./page.png   # Visual capture
```

### Pattern 2: Fill and Submit a Form

```bash
agent-browser open "https://example.com/form"
agent-browser snapshot -i             # See interactive elements with @refs
agent-browser fill @ref "value"       # Fill using snapshot refs
agent-browser click @ref              # Click submit using snapshot ref
agent-browser screenshot ./result.png
```

### Pattern 3: Extract Content

```bash
agent-browser open "https://example.com"
agent-browser get text "main"         # Get main content text
agent-browser get html ".article"     # Get article HTML
agent-browser get count "li.item"     # Count list items
```

### Pattern 4: Test a Deployed App

```bash
agent-browser open "http://localhost:3000"
agent-browser snapshot -i
agent-browser click "button:has-text('Connect Wallet')"
agent-browser screenshot ./after-click.png
agent-browser console                 # Check for errors
agent-browser errors                  # Check for page errors
```

## Important Notes

### `set media` vs class-based dark mode
`agent-browser set media dark` emulates `prefers-color-scheme: dark` at the browser level. This only works for sites that use `@media (prefers-color-scheme: dark)`. Many apps (e.g., Tailwind CSS apps with `.dark` class toggle) use **class-based** dark mode instead. For those, click the app's own theme toggle button rather than using `set media`. Use `snapshot -i` to find the toggle.

### `--session` is required for multi-command workflows
Without `--session`, each command launches a fresh browser. To maintain state (login, navigation, theme) across multiple commands, **always pass `--session <name>`** to every command in the workflow. Every command in the chain must use the same session name.

### Output format
- `open` prints the page title and URL on success
- `snapshot` outputs an indented accessibility tree with `[ref=eN]` annotations for interactive elements
- `screenshot` prints the saved file path — use the Read tool to view it (Claude can see images)
- `get text` returns plain text; `get html` returns raw HTML
- `is visible/enabled/checked` returns a boolean-style message
- `click/fill/type` print a checkmark on success

### Command chaining
Each command is a separate process invocation. You can chain independent commands with `&&` in a single Bash call, but add `sleep 1` between navigation/click and screenshot to let the page settle:
```bash
agent-browser open "http://localhost:3000" --session s1 && sleep 1 && agent-browser screenshot /tmp/page.png --session s1
```

### Selectors
Selectors can be:
- CSS selectors: `button`, `.class`, `#id`, `[data-testid="foo"]`
- Snapshot refs: `@e1`, `@e2` (from `snapshot` output)
- Text selectors: `"text=Submit"` or `"button:has-text('Submit')"`

## Tips

- Always start with `snapshot -i -c` to get a quick map of interactive elements before interacting
- Use `--session <name>` on **every command** to maintain browser state across a workflow
- Screenshots are useful for visual verification — read them with the Read tool to see the result
- Add `sleep 1-2` between actions that trigger page transitions and subsequent screenshots
- Use `agent-browser close --session <name>` when done to clean up the browser process
- For long pages, use `scroll down` or `scrollintoview <sel>` before screenshotting below-fold content
- `eval` can run arbitrary JS — useful for reading `localStorage`, checking `document.documentElement.classList`, etc.
