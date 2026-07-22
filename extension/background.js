/**
 * SnapFlow Service Worker (extension/background.js)
 * 
 * Manages extension lifecycle, registers context menus, and orchestrates the
 * browser-level tab captures.
 */

// Initialize extension settings and context menus
chrome.runtime.onInstalled.addListener(() => {
  console.log("SnapFlow Extension installed successfully.");
  
  // Register right-click context menu
  chrome.contextMenus.create({
    id: "capture-visible-viewport",
    title: "Capture Visible Viewport",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "capture-full-page",
    title: "Capture Full Scroll Page",
    contexts: ["page"]
  });
});

// Listen for context menu click events
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "capture-visible-viewport") {
    captureVisibleTab(tab.id);
  } else if (info.menuItemId === "capture-full-page") {
    startFullPageCapture(tab.id);
  }
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "TRIGGER_CAPTURE_VISIBLE") {
    captureVisibleTab(message.tabId || sender.tab.id)
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.action === "TRIGGER_FULLpage_CAPTURE") {
    startFullPageCapture(message.tabId || sender.tab.id)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Captures the currently visible portion of the active tab.
 */
async function captureVisibleTab(tabId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
    
    // Store temporarily in local storage for dashboard retrieval and reset type to visible
    await chrome.storage.local.set({ 
      last_capture_type: "visible",
      last_capture_image: dataUrl 
    });
    
    // Launch dashboard tab
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
    return dataUrl;
  } catch (error) {
    console.error("Error capturing visible tab:", error);
    throw error;
  }
}

/**
 * Orchestrates full-page capture by communicating with the content script
 * to scroll and capture segments, then stitching them (stitching is done in dashboard).
 */
async function startFullPageCapture(tabId) {
  try {
    // Check if the tab is a restricted system page
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) {
      throw new Error("No active tab found.");
    }

    const url = tab.url.toLowerCase();
    if (url.startsWith("chrome://") || 
        url.startsWith("edge://") || 
        url.startsWith("about:") || 
        url.startsWith("chrome-extension://") || 
        url.includes("chromewebstore.google.com") || 
        url.includes("chrome.google.com/webstore")) {
      throw new Error("security_blocked");
    }

    // Try sending a message first, in case content.js is already running (normal behavior)
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, { action: "GET_PAGE_DIMENSIONS" });
    } catch (msgErr) {
      console.log("Pre-injected content script not responding, attempting manual execution...", msgErr);
      // Fallback: inject content.js if it was not auto-loaded
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      // Try sending message again
      response = await chrome.tabs.sendMessage(tabId, { action: "GET_PAGE_DIMENSIONS" });
    }

    if (!response) {
      throw new Error("Failed to communicate with the page content script.");
    }

    const { pageWidth, pageHeight, viewportWidth, viewportHeight } = response;
    console.log(`Page dimensions: ${pageWidth}x${pageHeight}, Viewport: ${viewportWidth}x${viewportHeight}`);

    // Hide sticky/fixed headers before capturing starts
    await chrome.tabs.sendMessage(tabId, { action: "PREPARE_CAPTURE" });

    // Store dimensions and trigger full-page capture sequence
    await chrome.storage.local.set({
      capture_job: {
        tabId,
        pageWidth,
        pageHeight,
        viewportWidth,
        viewportHeight,
        scrolls: Math.ceil(pageHeight / viewportHeight),
        currentScroll: 0,
        frames: []
      }
    });

    await processNextScrollFrame(tabId);
  } catch (error) {
    console.error("Full page capture initialization failed:", error);
    const errType = error.message === "security_blocked" ? "security_blocked" : "injection_failed";
    // Redirect to dashboard with detailed error information
    chrome.tabs.create({
      url: chrome.runtime.getURL(`dashboard/dashboard.html?error=${errType}&details=${encodeURIComponent(error.message)}`)
    });
  }
}

/**
 * Iterative capture loop: scroll page -> take screenshot -> repeat -> redirect to dashboard
 */
async function processNextScrollFrame(tabId) {
  const data = await chrome.storage.local.get("capture_job");
  const job = data.capture_job;

  if (!job) return;

  if (job.currentScroll < job.scrolls) {
    const scrollY = job.currentScroll * job.viewportHeight;

    // Trigger scroll in content script
    await chrome.tabs.sendMessage(tabId, { action: "SCROLL_TO", scrollY });

     // Wait a brief moment for layout/rendering to settle and to respect Chrome's capture rate limit (max 2 calls/sec)
     await new Promise(resolve => setTimeout(resolve, 600));

    // Capture frame
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
    job.frames.push(dataUrl);

    // Update job state
    job.currentScroll++;
    await chrome.storage.local.set({ capture_job: job });

    // Recurse
    await processNextScrollFrame(tabId);
  } else {
    // End of capture sequence: clean up content script position and restore layout
    await chrome.tabs.sendMessage(tabId, { action: "SCROLL_TO", scrollY: 0 });
    await chrome.tabs.sendMessage(tabId, { action: "RESTORE_PAGE" });

    // Save final captures database object structure
    await chrome.storage.local.set({
      last_capture_type: "full-page",
      last_capture_frames: job.frames,
      last_capture_dimensions: {
        pageWidth: job.pageWidth,
        pageHeight: job.pageHeight,
        viewportWidth: job.viewportWidth,
        viewportHeight: job.viewportHeight
      }
    });

    // Clear active job
    await chrome.storage.local.remove("capture_job");

    // Launch dashboard tab
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  }
}
