/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const WINDOWS_LAUNCHER_NAME = "Smart Citations Desktop Launcher.cmd";

  function isWindows() {
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    return /win/i.test(platform);
  }

  async function detectBrowser() {
    const managerUrl = extensionApi.runtime.getURL("manager.html");
    if (managerUrl.startsWith("moz-extension:")) {
      return { id: "firefox", label: "Firefox" };
    }

    const brands = (navigator.userAgentData?.brands || [])
      .map((brand) => String(brand.brand || "").toLowerCase())
      .join(" ");
    const userAgent = String(navigator.userAgent || "");

    if (brands.includes("microsoft edge") || /\bEdg\//.test(userAgent)) {
      return { id: "edge", label: "Microsoft Edge" };
    }
    if (brands.includes("opera") || /\bOPR\//.test(userAgent)) {
      return { id: "opera", label: "Opera" };
    }
    if (brands.includes("vivaldi") || /\bVivaldi\//.test(userAgent)) {
      return { id: "vivaldi", label: "Vivaldi" };
    }
    try {
      if (await navigator.brave?.isBrave?.()) {
        return { id: "brave", label: "Brave" };
      }
    } catch (_error) {
      // Fall back to Chrome when Brave's optional detection API is unavailable.
    }
    return { id: "chrome", label: "Google Chrome" };
  }

  function batchValue(value) {
    return String(value || "")
      .replace(/%/g, "%%")
      .replace(/"/g, '""');
  }

  function browserPaths(browserId) {
    const paths = {
      chrome: [
        "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
        "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
        "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"
      ],
      edge: [
        "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
        "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
        "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe"
      ],
      firefox: [
        "%ProgramFiles%\\Mozilla Firefox\\firefox.exe",
        "%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe",
        "%LocalAppData%\\Mozilla Firefox\\firefox.exe"
      ],
      brave: [
        "%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        "%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        "%LocalAppData%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
      ],
      vivaldi: [
        "%LocalAppData%\\Vivaldi\\Application\\vivaldi.exe",
        "%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe",
        "%ProgramFiles(x86)%\\Vivaldi\\Application\\vivaldi.exe"
      ],
      opera: [
        "%LocalAppData%\\Programs\\Opera\\opera.exe",
        "%ProgramFiles%\\Opera\\launcher.exe",
        "%ProgramFiles(x86)%\\Opera\\launcher.exe"
      ]
    };
    return paths[browserId] || paths.chrome;
  }

  function buildWindowsLauncher(browser) {
    const managerUrl = batchValue(extensionApi.runtime.getURL("manager.html"));
    const popupLauncherUrl = batchValue(extensionApi.runtime.getURL("desktop-launcher.html"));
    const pathChecks = browserPaths(browser.id)
      .map((path) => `if not defined SMART_CITATIONS_BROWSER if exist "${path}" set "SMART_CITATIONS_BROWSER=${path}"`)
      .join("\r\n");
    const targetUrl = browser.id === "firefox" ? popupLauncherUrl : managerUrl;
    const launchArguments = browser.id === "firefox"
      ? `-new-tab "%SMART_CITATIONS_URL%"`
      : `--app="%SMART_CITATIONS_URL%"`;

    return [
      "@echo off",
      "setlocal",
      `title Smart Citations`,
      `set "SMART_CITATIONS_URL=${targetUrl}"`,
      'set "SMART_CITATIONS_BROWSER="',
      pathChecks,
      "if not defined SMART_CITATIONS_BROWSER (",
      `  echo Smart Citations could not find ${browser.label} in a standard installation location.`,
      "  echo Reinstall the browser in its default location or recreate this launcher.",
      "  pause",
      "  exit /b 1",
      ")",
      `start "" "%SMART_CITATIONS_BROWSER%" ${launchArguments}`,
      "endlocal"
    ].join("\r\n") + "\r\n";
  }

  function windowsLauncherCommand(browser) {
    const managerUrl = extensionApi.runtime.getURL("manager.html");
    const popupLauncherUrl = extensionApi.runtime.getURL("desktop-launcher.html");
    const browserPath = browserPaths(browser.id)[0];
    return browser.id === "firefox"
      ? `"${browserPath}" -new-tab "${popupLauncherUrl}"`
      : `"${browserPath}" --app="${managerUrl}"`;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      return;
    } catch (_error) {
      const textarea = document.createElement("textarea");
      textarea.value = String(value || "");
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-10000px";
      textarea.style.opacity = "0";
      document.documentElement.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("The text could not be copied. Select it and copy it manually.");
    }
  }

  function saveTextFile(name, text) {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function download() {
    if (!isWindows()) {
      throw new Error("The downloadable desktop launcher is currently available on Windows.");
    }
    const browser = await detectBrowser();
    saveTextFile(WINDOWS_LAUNCHER_NAME, buildWindowsLauncher(browser));
    return { browser, fileName: WINDOWS_LAUNCHER_NAME };
  }

  function createMenuContent() {
    const section = document.createElement("section");
    section.className = "ctca-desktop-launcher-menu";
    const managerUrl = extensionApi.runtime.getURL("manager.html");
    section.innerHTML = `
      <section class="ctca-desktop-launcher-option">
        <strong>Direct extension link</strong>
        <p>Copy this address and paste it into the address bar of the same browser profile to open the standalone manager directly. You can also save it as a browser bookmark. The link is profile-specific and is not intended for sharing with other users or browsers.</p>
        <div class="ctca-desktop-launcher-copy-row">
          <input type="text" class="ctca-desktop-launcher-url" readonly aria-label="Standalone manager link">
          <button type="button" class="ctca-copy-desktop-launcher-link">Copy link</button>
        </div>
      </section>
      <section class="ctca-desktop-launcher-option ctca-desktop-launcher-instructions">
        <strong>Desktop shortcut</strong>
        <p>Create the shortcut manually with these steps:</p>
        <ol>
          <li>Right-click the Windows desktop and choose <em>New \u2192 Shortcut</em>.</li>
          <li>Copy the browser launcher command below and paste it as the shortcut location.</li>
          <li>Name the shortcut <em>Smart Citations</em>, then finish the wizard.</li>
          <li>Open the shortcut. You can then right-click the running window's taskbar icon and choose <em>Pin to taskbar</em> when your browser and Windows offer it.</li>
        </ol>
        <span class="ctca-desktop-launcher-command-label">Browser launcher command</span>
        <div class="ctca-desktop-launcher-copy-row">
          <input type="text" class="ctca-desktop-launcher-command" readonly aria-label="Desktop launcher command" value="Detecting browser\u2026">
          <button type="button" class="ctca-copy-desktop-launcher-command" disabled>Copy command</button>
        </div>
      </section>
      <section class="ctca-desktop-launcher-option">
        <strong>Download desktop launcher</strong>
        <p>Download a ready-made launcher that opens Smart Citations in a clean app-style browser window.</p>
        <div class="ctca-desktop-launcher-actions">
          <button type="button" class="ctca-download-desktop-launcher">Download desktop launcher</button>
          <span class="ctca-desktop-launcher-status" role="status" aria-live="polite"></span>
        </div>
        <small>After downloading, move this file to your desktop. Your browser or Windows may ask you to confirm keeping the command file. The launcher uses this browser's default profile, where Smart Citations must remain installed.</small>
      </section>`;

    const urlInput = section.querySelector(".ctca-desktop-launcher-url");
    const commandInput = section.querySelector(".ctca-desktop-launcher-command");
    const copyLinkButton = section.querySelector(".ctca-copy-desktop-launcher-link");
    const copyCommandButton = section.querySelector(".ctca-copy-desktop-launcher-command");
    const downloadButton = section.querySelector(".ctca-download-desktop-launcher");
    const status = section.querySelector(".ctca-desktop-launcher-status");
    urlInput.value = managerUrl;

    const setStatus = (message, error = false) => {
      status.textContent = message;
      status.classList.toggle("ctca-desktop-launcher-status-error", error);
    };
    const browserPromise = detectBrowser().then((browser) => {
      commandInput.value = isWindows()
        ? windowsLauncherCommand(browser)
        : "Manual launcher commands are currently available on Windows.";
      copyCommandButton.disabled = !isWindows();
      return browser;
    }).catch((error) => {
      commandInput.value = error?.message || String(error);
      copyCommandButton.disabled = true;
      return null;
    });

    copyLinkButton.addEventListener("click", async () => {
      try {
        await copyText(managerUrl);
        setStatus("Standalone manager link copied.");
      } catch (error) {
        setStatus(error?.message || String(error), true);
      }
    });
    copyCommandButton.addEventListener("click", async () => {
      try {
        const browser = await browserPromise;
        if (!browser) throw new Error("The browser launcher command could not be prepared.");
        await copyText(commandInput.value);
        setStatus("Launcher command copied.");
      } catch (error) {
        setStatus(error?.message || String(error), true);
      }
    });

    if (!isWindows()) {
      downloadButton.disabled = true;
      setStatus("Launcher download is currently available on Windows.");
    } else {
      downloadButton.addEventListener("click", async () => {
        downloadButton.disabled = true;
        setStatus("Preparing launcher\u2026");
        try {
          const result = await download();
          setStatus(`Downloaded for ${result.browser.label}. Move this file to your desktop.`);
        } catch (error) {
          setStatus(error?.message || String(error), true);
        } finally {
          downloadButton.disabled = false;
        }
      });
    }
    return section;
  }

  globalThis.SmartCitationsDesktopLauncher = {
    createMenuContent,
    download
  };
})();
