/**
 * SnapFlow Popup Controller (extension/popup/popup.js)
 * 
 * Manages click events and utilizes the Antigravity reactive store to update
 * structural UI states.
 */

import { Store } from "../lib/antigravity.js";
import { CONFIG } from "../lib/config.js";

// Initialize store with default mock states (will be populated from chrome.storage.local)
const store = new Store({
  user: null,
  is_premium: false
});

// Immediately load persisted states
await store.load();

// Initialize Supabase Client
const supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// Automatically check session on startup
try {
  const { data: { session } } = await supabase.auth.getSession();
  if (session && session.user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_premium")
      .eq("id", session.user.id)
      .single();

    store.state.user = {
      id: session.user.id,
      email: session.user.email,
      is_premium: profile ? profile.is_premium : false
    };
    store.state.is_premium = profile ? profile.is_premium : false;
  } else {
    store.state.user = null;
    store.state.is_premium = false;
  }
} catch (e) {
  console.error("Failed to sync session on startup:", e);
}

// Helper to query active browser tab
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ----------------------------------------------------
// Antigravity Reactive Subscriptions (UI Bindings)
// ----------------------------------------------------

// 1. Listen for changes in user subscription tier to update badge
store.subscribe("is_premium", (isPremium) => {
  const container = document.getElementById("premium-badge-container");
  if (isPremium) {
    container.innerHTML = `<span class="badge-premium">Premium</span>`;
  } else {
    container.innerHTML = `<span class="badge-free">Free</span>`;
  }
  
  // Keep user profile state in sync with premium status
  if (store.state.user && store.state.user.is_premium !== isPremium) {
    const updatedUser = { ...store.state.user, is_premium: isPremium };
    store.state.user = updatedUser;
  }
});

// 2. Listen for user login sessions to swap authorization cards
store.subscribe("user", (user) => {
  const container = document.getElementById("user-profile-section");
  
  if (user) {
    // Show logged-in card
    container.innerHTML = `
      <div class="user-card">
        <div class="user-info">
          <div class="user-details">
            <span class="user-email" title="${user.email}">${user.email}</span>
            <span class="user-status">${user.is_premium ? "Premium workspace active" : "Free cloud workspace"}</span>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 8px; width: 100%;">
            <button id="btn-open-dashboard" class="btn-dashboard" style="flex: 1;">Workspace ↗</button>
            <button id="btn-signout-popup" class="btn-auth" style="flex: 1; background: transparent; border: 1px solid rgba(255,255,255,0.15); color: var(--text-secondary); font-size: 11px; padding: 6px;">Sign Out</button>
          </div>
        </div>
      </div>
    `;
    
    // Register actions on dynamically injected components
    document.getElementById("btn-open-dashboard").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
    });

    document.getElementById("btn-signout-popup").addEventListener("click", async () => {
      try {
        await supabase.auth.signOut();
      } catch (err) {
        console.warn("Supabase sign out warning (ignoring to proceed with local clean):", err);
      }
      // Always clear local state to prevent UI sync bugs
      store.state.user = null;
      store.state.is_premium = false;
    });
  } else {
    // Show Call-to-Action to log in / connect to Supabase
    container.innerHTML = `
      <button id="btn-connect-cloud" class="btn-auth">
        <span>☁️</span> Connect Cloud Workspace
      </button>
    `;
    
    document.getElementById("btn-connect-cloud").addEventListener("click", async () => {
      try {
        const url = new URL(`${CONFIG.SUPABASE_URL}/auth/v1/authorize`);
        url.searchParams.set("provider", "google");
        url.searchParams.set("redirect_to", `https://${chrome.runtime.id}.chromiumapp.org/`);
        
        chrome.identity.launchWebAuthFlow({
          url: url.toString(),
          interactive: true
        }, async (redirectUrl) => {
          if (chrome.runtime.lastError || !redirectUrl) {
            const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : "No redirect URL received";
            console.error("Auth flow failed:", errMsg);
            showCustomAlert("Login Failed", `Login failed: ${errMsg}\n\nPlease check these settings in your Supabase Dashboard:\n1. Authentication > Providers > Google: Ensure it is ENABLED with a Web Client ID & Client Secret.\n2. Authentication > URL Configuration > Redirect URLs: Add this exact URL:\n\nhttps://${chrome.runtime.id}.chromiumapp.org/`);
            return;
          }
          
          const parsedUrl = new URL(redirectUrl);
          const params = new URLSearchParams(parsedUrl.hash.substring(1));
          const accessToken = params.get("access_token");
          const refreshToken = params.get("refresh_token");
          
          if (accessToken) {
            const { data, error } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken
            });
            
            if (error) {
              console.error("Error setting session:", error);
              return;
            }
            
            const { data: profile } = await supabase
              .from("profiles")
              .select("is_premium")
              .eq("id", data.user.id)
              .single();
              
            store.state.user = {
              id: data.user.id,
              email: data.user.email,
              is_premium: profile ? profile.is_premium : false
            };
            store.state.is_premium = profile ? profile.is_premium : false;
          }
        });
      } catch (err) {
        console.error("Google Auth error:", err);
      }
    });
  }
});

// ----------------------------------------------------
// UI Action Listeners
// ----------------------------------------------------

document.getElementById("btn-capture-viewport").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) {
    chrome.runtime.sendMessage({ 
      action: "TRIGGER_CAPTURE_VISIBLE", 
      tabId: tab.id 
    });
  }
});

document.getElementById("btn-capture-fullpage").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) {
    const url = tab.url || "";
    const isSystemPage = url.startsWith("chrome://") || 
                         url.startsWith("chrome-extension://") || 
                         url.startsWith("edge://") ||
                         url.startsWith("about:") ||
                         url.startsWith("view-source:") ||
                         url.includes("chrome.google.com/webstore") || 
                         url.includes("chromewebstore.google.com");
                         
    if (isSystemPage) {
      showCustomAlert("System Page Restricted", "Chrome security policies restrict capturing full page on system pages (chrome://, edge://, about:) or the Web Store.\n\nPlease try capturing on a public website (e.g., google.com).");
      return;
    }
    
    if (url.startsWith("file://")) {
      const hasFileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!hasFileAccess) {
        showCustomAlert("Local File Access Needed", "To capture local files (file://), you must enable 'Allow access to file URLs' in the SnapFlow extension details page.\n\nOpening settings details now...", () => {
          chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        });
        return;
      }
    }

    chrome.runtime.sendMessage({ 
      action: "TRIGGER_FULLpage_CAPTURE", 
      tabId: tab.id 
    });
    // Close popup window to prevent focus theft during scroll capturing
    window.close();
  }
});

// Custom Premium Alert Modal Helper for Extension Popup
function showCustomAlert(title, message, callback) {
  const modal = document.getElementById("popup-alert-modal");
  const titleEl = document.getElementById("popup-alert-title");
  const bodyEl = document.getElementById("popup-alert-body");
  const okBtn = document.getElementById("btn-popup-alert-ok");

  titleEl.textContent = title;
  bodyEl.innerHTML = message.replace(/\n/g, "<br>");
  modal.classList.add("active");

  const onClose = () => {
    modal.classList.remove("active");
    okBtn.removeEventListener("click", onClose);
    if (callback) callback();
  };

  okBtn.addEventListener("click", onClose);
}
