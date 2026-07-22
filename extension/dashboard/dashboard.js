/**
 * SnapFlow Editor Dashboard Controller (extension/dashboard/dashboard.js)
 * 
 * Implements:
 * 1. HTML5 canvas scrolling capture stitching.
 * 2. Antigravity state management bindings.
 * 3. Scoped Google Drive OAuth, multipart uploads, and public share links.
 * 4. Non-destructive layered drawing annotations (Crop, Blur, Arrow, Text, and Undo).
 */

import { Store } from "../lib/antigravity.js";
import { CONFIG } from "../lib/config.js";

// Initialize Antigravity State Store
const store = new Store({
  user: null,
  is_premium: false,
  captures: [], // Synced captures list
  gdrive_token: null, // Google Drive OAuth token
  gdrive_user: null, // Connected Google user account info
  onboarding_completed: false
});

// Immediately load states from storage
await store.load();

// Initialize Supabase Client
const supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// Query DOM nodes
const accountContainer = document.getElementById("account-card-container");
const gdriveContainer = document.getElementById("gdrive-connection-container");
const upgradeBanner = document.getElementById("pro-upgrade-banner");
const cloudUploadBtn = document.getElementById("btn-cloud-upload");
const canvasContainer = document.getElementById("canvas-container");
const canvas = document.getElementById("stitching-canvas");
const loader = document.getElementById("stitching-loader");
const testProBtn = document.getElementById("btn-toggle-pro-test");
const capturesList = document.getElementById("cloud-captures-list");

// In-memory offscreen canvas to store the clean base stitched capture
const baseCanvas = document.createElement("canvas");
let annotations = [];
let undoHistory = [];

// Drawing engine states
let isDrawing = false;
let startX = 0;
let startY = 0;
let activePreview = null;
let currentTool = "select";

// ----------------------------------------------------
// Antigravity Reactive Subscriptions (UI Bindings)
// ----------------------------------------------------

// 1. Account state bindings
store.subscribe("user", (user) => {
  renderGDriveConnection(); // Sync storage UI whenever account state changes
  if (user) {
    accountContainer.innerHTML = `
      <div class="account-details">
        <span class="account-email" title="${user.email}">${user.email}</span>
        <span class="account-badge ${store.state.is_premium ? "badge-pro" : "badge-std"}">
          ${store.state.is_premium ? "PRO WORKSPACE" : "FREE MEMBER"}
        </span>
      </div>
      <button id="btn-signout" class="btn-signout">Sign Out</button>
    `;
    
    document.getElementById("btn-signout").addEventListener("click", async () => {
      try {
        await supabase.auth.signOut();
      } catch (err) {
        console.warn("Supabase sign out warning (ignoring to proceed with local clean):", err);
      }
      // Always clear local state to prevent UI sync bugs
      store.state.user = null;
      store.state.is_premium = false;
      store.state.captures = [];
      store.state.gdrive_token = null;
      store.state.gdrive_user = null;
    });
  } else {
    accountContainer.innerHTML = `
      <button id="btn-signin" class="btn-signin">Connect Cloud Workspace</button>
    `;
    
    document.getElementById("btn-signin").addEventListener("click", async () => {
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
            showCustomAlert("Authentication Failure", `Login failed: ${errMsg}\n\nPlease check these settings in your Supabase Dashboard:\n1. Authentication > Providers > Google: Ensure it is ENABLED with a Web Client ID & Client Secret.\n2. Authentication > URL Configuration > Redirect URLs: Add this exact URL:\n\nhttps://${chrome.runtime.id}.chromiumapp.org/`);
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
            
            // Fetch captures list
            await loadCapturesFromSupabase();
          }
        });
      } catch (err) {
        console.error("Google Auth error:", err);
      }
    });
  }
});

// 2. Google Drive connection bindings
store.subscribe("gdrive_token", (token) => {
  renderGDriveConnection();
});

store.subscribe("gdrive_user", (user) => {
  renderGDriveConnection();
});

function renderGDriveConnection() {
  const token = store.state.gdrive_token;
  const user = store.state.gdrive_user;

  // Enforce account dependency to prevent confused disconnected states
  if (!store.state.user) {
    gdriveContainer.innerHTML = `
      <div style="font-size: 11.5px; color: var(--text-muted); text-align: center; padding: 16px 12px; border: 1px dashed rgba(255, 255, 255, 0.08); border-radius: 12px; background: rgba(255,255,255,0.01); line-height: 1.4;">
        🔒 Please connect your SnapFlow Account first to configure cloud storage.
      </div>
    `;
    return;
  }

  if (token) {
    gdriveContainer.innerHTML = `
      <div class="account-card" style="border-color: rgba(16, 185, 129, 0.3);">
        <div class="account-details">
          <span style="font-size: 11px; color: var(--success-color); font-weight: 700; display: flex; align-items: center; gap: 4px;">
            ● CONNECTED
          </span>
          <span class="account-email" title="${user || "Active Session"}">${user || "Personal Cloud active"}</span>
        </div>
        <button id="btn-gdrive-disconnect" class="btn-signout" style="color: var(--danger-color);">Disconnect</button>
      </div>
    `;

    document.getElementById("btn-gdrive-disconnect").addEventListener("click", () => {
      if (typeof chrome !== "undefined" && chrome.identity && chrome.identity.removeCachedAuthToken) {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          store.state.gdrive_token = null;
          store.state.gdrive_user = null;
        });
      } else {
        store.state.gdrive_token = null;
        store.state.gdrive_user = null;
      }
    });
  } else {
    gdriveContainer.innerHTML = `
      <button id="btn-gdrive-connect" class="btn-signin" style="border-color: rgba(99, 102, 241, 0.4); color: #818cf8;">
        Connect Google Drive
      </button>
    `;

    document.getElementById("btn-gdrive-connect").addEventListener("click", () => {
      initiateGDriveAuth();
    });
  }
}

function initiateGDriveAuth() {
  if (typeof chrome === "undefined" || !chrome.identity) {
    simulateGDriveAuth();
    return;
  }

  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (chrome.runtime.lastError) {
      const errMsg = chrome.runtime.lastError.message;
      console.warn("OAuth failed, falling back to mock simulator:", errMsg);
      
      showCustomAlert(
        "Google Drive OAuth Failed",
        `Google OAuth failed with error: "${errMsg}"\n\nThis happens because the Client ID in manifest.json is registered for the production extension ID. Since you loaded SnapFlow as an unpacked extension, Chrome generated a local ID: "${chrome.runtime.id}".\n\nConnecting in Developer Simulation Mode so you can continue testing.`,
        () => {
          simulateGDriveAuth();
        }
      );
      return;
    }

    fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => res.json())
      .then((info) => {
        store.state.gdrive_token = token;
        store.state.gdrive_user = info.email;
        showToast("Google Drive connected successfully!", "success");
      })
      .catch((err) => {
        console.error("Failed to load Google user info:", err);
        store.state.gdrive_token = token;
        store.state.gdrive_user = "Personal Drive";
        showToast("Connected to Google Drive (Personal Profile)!", "success");
      });
  });
}

function simulateGDriveAuth() {
  store.state.gdrive_token = "mock-gdrive-access-token-987654";
  store.state.gdrive_user = "seedpearl.drive@gmail.com";
}

// 3. Subscription state bindings
function renderUpgradeBanner() {
  const isPremium = store.state.is_premium;
  if (isPremium) {
    upgradeBanner.innerHTML = `
      <div class="upgrade-title">⚡ SnapFlow Pro Active</div>
      <p class="upgrade-text">Enjoy infinite full-page scrolling captures and automated Cloud Workspace syncing.</p>
    `;
  } else {
    const credits = store.state.user && typeof store.state.user.ai_credits === "number" 
      ? store.state.user.ai_credits 
      : 5;
    upgradeBanner.innerHTML = `
      <div class="upgrade-title">🚀 Upgrade to Pro Workspace</div>
      <p class="upgrade-text">Unlock smart AI Toolkit (OCR, Tailwind CSS conversion) and automated Cloud Sync backup.</p>
      <div style="font-size: 11px; color: var(--success-color); font-weight: 700; margin-bottom: 12px; text-align: center; letter-spacing: 0.2px;">
        Free AI runs this month: ${credits} / 5
      </div>
      <button id="btn-trigger-upgrade" class="btn btn-primary btn-sm" style="width: 100%;">Get Pro Workspace</button>
    `;
    const payBtn = document.getElementById("btn-trigger-upgrade");
    if (payBtn) {
      payBtn.addEventListener("click", () => {
        showPricingModal();
      });
    }
  }
}

store.subscribe("is_premium", (isPremium) => {
  renderUpgradeBanner();
  if (store.state.user) {
    store.state.user = { ...store.state.user, is_premium: isPremium };
  }
});

store.subscribe("user", (user) => {
  renderUpgradeBanner();
});

// 4. Captures list subscription (simulated DB sync)
store.subscribe("captures", (captures) => {
  if (captures.length === 0) {
    capturesList.innerHTML = `<div class="list-placeholder">No captures synced yet.</div>`;
  } else {
    capturesList.innerHTML = captures
      .map(
        (c) => `
        <div class="capture-item" title="${c.title}" data-id="${c.id}" data-file-id="${c.external_file_id}">
          <span>📄</span>
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-grow: 1;">${c.title}</span>
          <a href="${c.web_view_link}" target="_blank" style="color: var(--accent-color); font-size: 11px; text-decoration: none; margin-right: 6px;">View ↗</a>
          <button class="btn-delete-capture" title="Delete Capture">🗑️</button>
        </div>
      `
      )
      .join("");

    // Bind click events to delete buttons
    capturesList.querySelectorAll(".btn-delete-capture").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const itemEl = btn.closest(".capture-item");
        const id = itemEl.getAttribute("data-id");
        const fileId = itemEl.getAttribute("data-file-id");
        const title = itemEl.getAttribute("title");

        showCustomConfirm(
          "Delete Capture",
          `Are you sure you want to permanently delete this capture?\n\n"${title}"\n\nThis will remove the record from SnapFlow and delete the file from your Google Drive.`,
          () => {
            deleteCaptureItem(id, fileId);
          },
          { icon: "🗑️", okText: "Delete", okBg: "#ef4444" }
        );
      });
    });
  }
});

// ----------------------------------------------------
// HTML5 Canvas Stitching Engine
// ----------------------------------------------------

async function stitchCapturedFrames() {
  if (typeof chrome === "undefined" || !chrome.storage) {
    renderMockCanvas();
    return;
  }

  const storage = await chrome.storage.local.get([
    "last_capture_type",
    "last_capture_image",
    "last_capture_frames",
    "last_capture_dimensions"
  ]);

  const type = storage.last_capture_type;
  
  if (type === "full-page") {
    const frames = storage.last_capture_frames || [];
    const dimensions = storage.last_capture_dimensions;

    if (frames.length === 0 || !dimensions) {
      renderMockCanvas("No scroll frames found.");
      return;
    }

    const { pageWidth, pageHeight, viewportWidth, viewportHeight } = dimensions;

    baseCanvas.width = pageWidth;
    baseCanvas.height = pageHeight;
    const baseCtx = baseCanvas.getContext("2d");

    const loadImage = (src) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = src;
      });
    };

    try {
      for (let i = 0; i < frames.length; i++) {
        const img = await loadImage(frames[i]);
        let drawY = i * viewportHeight;
        
        if (i === frames.length - 1) {
          drawY = pageHeight - viewportHeight;
        }

        baseCtx.drawImage(img, 0, drawY, viewportWidth, viewportHeight);
      }

      canvas.width = pageWidth;
      canvas.height = pageHeight;
      redrawCanvas();
      
      loader.style.display = "none";
      canvas.style.display = "block";
    } catch (e) {
      console.error("Canvas stitching failed:", e);
      renderMockCanvas("Stitching Error.");
    }
  } else {
    // Single viewport capture
    const imageSrc = storage.last_capture_image;
    if (!imageSrc) {
      renderMockCanvas("No capture found. Go back and capture a tab.");
      return;
    }

    const img = new Image();
    img.onload = () => {
      baseCanvas.width = img.width;
      baseCanvas.height = img.height;
      baseCanvas.getContext("2d").drawImage(img, 0, 0);
      
      canvas.width = img.width;
      canvas.height = img.height;
      redrawCanvas();
      
      loader.style.display = "none";
      canvas.style.display = "block";
    };
    img.src = imageSrc;
  }
}

function renderMockCanvas(message = "SnapFlow Canvas Workspace") {
  baseCanvas.width = 800;
  baseCanvas.height = 1200;
  const baseCtx = baseCanvas.getContext("2d");
  
  const grad = baseCtx.createLinearGradient(0, 0, 0, 1200);
  grad.addColorStop(0, "#1e293b");
  grad.addColorStop(1, "#0f172a");
  baseCtx.fillStyle = grad;
  baseCtx.fillRect(0, 0, 800, 1200);

  baseCtx.font = "bold 24px 'Inter', sans-serif";
  baseCtx.fillStyle = "#818cf8";
  baseCtx.textAlign = "center";
  baseCtx.fillText(message, 400, 200);

  baseCtx.font = "14px 'Inter', sans-serif";
  baseCtx.fillStyle = "#94a3b8";
  baseCtx.fillText("Capture a webpage to view pixel-perfect stitches.", 400, 240);
  
  canvas.width = 800;
  canvas.height = 1200;
  redrawCanvas();
  
  loader.style.display = "none";
  canvas.style.display = "block";
}

// ----------------------------------------------------
// Layered Canvas Drawing Engine (Crop, Blur, Arrow, Text, Undo)
// ----------------------------------------------------

/**
 * Re-draws the base clean image, then overlays all annotations on top.
 */
function redrawCanvas() {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // 1. Draw base stitched screenshot
  ctx.drawImage(baseCanvas, 0, 0);
  
  // 2. Draw baked annotations
  annotations.forEach((anno) => drawAnnotationItem(ctx, anno));
  
  // 3. Draw active drawing preview
  if (isDrawing && activePreview) {
    drawAnnotationItem(ctx, activePreview);
  }
}

/**
 * Renders a single annotation entity on a context
 */
function drawAnnotationItem(ctx, anno) {
  if (anno.type === "blur") {
    ctx.save();
    // Native Canvas 2D blur filter
    ctx.filter = "blur(8px)";
    // Crop base image region and redraw it blurred on top
    ctx.drawImage(
      baseCanvas, 
      anno.x, anno.y, anno.w, anno.h, 
      anno.x, anno.y, anno.w, anno.h
    );
    ctx.restore();
    
    // Add subtle visual boundary
    ctx.save();
    ctx.strokeStyle = "rgba(99, 102, 241, 0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(anno.x, anno.y, anno.w, anno.h);
    ctx.restore();
  } 
  
  else if (anno.type === "arrow") {
    ctx.save();
    ctx.strokeStyle = "#818cf8";
    ctx.fillStyle = "#818cf8";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    
    // Line shaft
    ctx.beginPath();
    ctx.moveTo(anno.x1, anno.y1);
    ctx.lineTo(anno.x2, anno.y2);
    ctx.stroke();
    
    // Arrow head calculations
    const angle = Math.atan2(anno.y2 - anno.y1, anno.x2 - anno.x1);
    ctx.beginPath();
    ctx.moveTo(anno.x2, anno.y2);
    ctx.lineTo(
      anno.x2 - 16 * Math.cos(angle - Math.PI / 6), 
      anno.y2 - 16 * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      anno.x2 - 16 * Math.cos(angle + Math.PI / 6), 
      anno.y2 - 16 * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } 
  
  else if (anno.type === "text") {
    ctx.save();
    ctx.fillStyle = "#fbbf24";
    ctx.font = "bold 20px 'Inter', sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(anno.text, anno.x, anno.y);
    ctx.restore();
  } 
  
  else if (anno.type === "crop") {
    // Selection box overlay during Crop drag
    ctx.save();
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(anno.x, anno.y, anno.w, anno.h);
    
    // Shadow backdrop around selection area
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    // top
    ctx.fillRect(0, 0, canvas.width, anno.y < 0 ? 0 : anno.y);
    // bottom
    const boxBottom = anno.y + anno.h;
    ctx.fillRect(0, boxBottom, canvas.width, canvas.height - boxBottom);
    // left
    ctx.fillRect(0, anno.y, anno.x < 0 ? 0 : anno.x, anno.h);
    // right
    const boxRight = anno.x + anno.w;
    ctx.fillRect(boxRight, anno.y, canvas.width - boxRight, anno.h);
    
    ctx.restore();
  }
}

/**
 * Save state before performing destructive changes for Undo support
 */
function saveStateToUndoHistory() {
  const snapshot = {
    width: baseCanvas.width,
    height: baseCanvas.height,
    dataUrl: baseCanvas.toDataURL(),
    annotations: JSON.parse(JSON.stringify(annotations))
  };
  undoHistory.push(snapshot);
  if (undoHistory.length > 20) {
    undoHistory.shift(); // Keep limit buffer at 20 steps
  }
}

/**
 * Restores previous canvas and annotations snapshot
 */
function triggerUndo() {
  if (undoHistory.length === 0) return;
  const lastState = undoHistory.pop();

  const img = new Image();
  img.onload = () => {
    // Restore base canvas dimensions & contents
    baseCanvas.width = lastState.width;
    baseCanvas.height = lastState.height;
    const baseCtx = baseCanvas.getContext("2d");
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.drawImage(img, 0, 0);

    // Restore visible canvas dimensions & contents
    canvas.width = lastState.width;
    canvas.height = lastState.height;
    
    annotations = lastState.annotations;
    redrawCanvas();
  };
  img.src = lastState.dataUrl;
}

/**
 * Resizes the base canvas image to selection bounding boxes
 */
function executeCrop(cropX, cropY, cropW, cropH) {
  saveStateToUndoHistory();

  // Normalize negative offsets (drawing selection backwards)
  const drawX = cropW > 0 ? cropX : cropX + cropW;
  const drawY = cropH > 0 ? cropY : cropY + cropH;
  const absW = Math.abs(cropW);
  const absH = Math.abs(cropH);

  // Draw crop content on temp canvas
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = absW;
  tempCanvas.height = absH;
  const tempCtx = tempCanvas.getContext("2d");
  
  // Crop from current stitched render state
  tempCtx.drawImage(
    canvas, 
    drawX, drawY, absW, absH, 
    0, 0, absW, absH
  );

  // Update baseCanvas size and draw
  baseCanvas.width = absW;
  baseCanvas.height = absH;
  baseCanvas.getContext("2d").drawImage(tempCanvas, 0, 0);

  // Reset main visible canvas size
  canvas.width = absW;
  canvas.height = absH;

  // Clear annotations list as details are baked in
  annotations = [];
  redrawCanvas();
}

/**
 * Creates temporary absolute input overlay on click position for text annotations
 */
function createTextInputOverlay(clientX, clientY, canvasX, canvasY) {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type text & Enter...";
  input.style.position = "absolute";
  input.style.left = `${clientX + window.scrollX}px`;
  input.style.top = `${clientY + window.scrollY}px`;
  input.style.zIndex = "1000";
  input.style.background = "#161824";
  input.style.color = "#fbbf24";
  input.style.border = "1px solid #fbbf24";
  input.style.borderRadius = "6px";
  input.style.padding = "6px 10px";
  input.style.font = "bold 14px 'Inter', sans-serif";
  input.style.outline = "none";
  input.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";

  document.body.appendChild(input);
  input.focus();

  const commitText = () => {
    const text = input.value.trim();
    if (text) {
      saveStateToUndoHistory();
      annotations.push({ type: "text", x: canvasX, y: canvasY, text });
      redrawCanvas();
    }
    input.remove();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commitText();
    } else if (e.key === "Escape") {
      input.remove();
    }
  });

  input.addEventListener("blur", () => {
    commitText();
  });
}

// ----------------------------------------------------
// Mouse Drag Handlers on Canvas
// ----------------------------------------------------

canvas.addEventListener("mousedown", (e) => {
  if (currentTool === "select") return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  startX = (e.clientX - rect.left) * scaleX;
  startY = (e.clientY - rect.top) * scaleY;

  isDrawing = true;
  activePreview = null;
});

canvas.addEventListener("mousemove", (e) => {
  if (!isDrawing) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const currentX = (e.clientX - rect.left) * scaleX;
  const currentY = (e.clientY - rect.top) * scaleY;
  const w = currentX - startX;
  const h = currentY - startY;

  if (currentTool === "blur") {
    activePreview = { type: "blur", x: startX, y: startY, w, h };
  } else if (currentTool === "arrow") {
    activePreview = { type: "arrow", x1: startX, y1: startY, x2: currentX, y2: currentY };
  } else if (currentTool === "crop") {
    activePreview = { type: "crop", x: startX, y: startY, w, h };
  }

  redrawCanvas();
});

canvas.addEventListener("mouseup", (e) => {
  if (!isDrawing) return;
  isDrawing = false;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const endX = (e.clientX - rect.left) * scaleX;
  const endY = (e.clientY - rect.top) * scaleY;
  const w = endX - startX;
  const h = endY - startY;

  if (currentTool === "blur" && Math.abs(w) > 5 && Math.abs(h) > 5) {
    saveStateToUndoHistory();
    annotations.push({ type: "blur", x: startX, y: startY, w, h });
  } else if (currentTool === "arrow") {
    const dist = Math.hypot(w, h);
    if (dist > 5) {
      saveStateToUndoHistory();
      annotations.push({ type: "arrow", x1: startX, y1: startY, x2: endX, y2: endY });
    }
  } else if (currentTool === "crop" && Math.abs(w) > 10 && Math.abs(h) > 10) {
    const confirmCrop = confirm("Crop image to selected area?");
    if (confirmCrop) {
      executeCrop(startX, startY, w, h);
    }
  } else if (currentTool === "text") {
    createTextInputOverlay(e.clientX, e.clientY, endX, endY);
  }

  activePreview = null;
  redrawCanvas();
});

// Bind keyboard Undo key listener (Ctrl + Z)
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    triggerUndo();
  }
});

// ----------------------------------------------------
// Google Drive Upload Handler (Multipart REST API)
// ----------------------------------------------------

async function uploadToGoogleDrive() {
  if (!store.state.user) {
    showCustomAlert("Workspace Not Connected", "Please connect your Cloud Workspace (log in via Supabase) first to upload captures.");
    return;
  }

  const token = store.state.gdrive_token;
  if (!token) {
    showCustomAlert("Google Drive Required", "Please connect your Google Drive inside the sidebar settings to back up your screenshots.");
    return;
  }

  cloudUploadBtn.setAttribute("disabled", "true");
  cloudUploadBtn.innerText = "Uploading to Drive...";

  // 1. Get image blob from Canvas (contains all annotations baked in)
  canvas.toBlob(async (blob) => {
    if (!blob) {
      showCustomAlert("Export Failed", "Failed to retrieve canvas binary layout. Please try reloading the page.");
      cloudUploadBtn.removeAttribute("disabled");
      cloudUploadBtn.innerHTML = "<span>▲</span> Save to Google Drive";
      return;
    }

    const title = `SnapFlow_${Date.now()}.png`;

    // 2. Setup simulation handler for Developer testing
    if (token === "mock-gdrive-access-token-987654") {
      setTimeout(() => {
        simulateCloudSync(title, "mock-google-drive-file-id-123", "https://drive.google.com/file/d/mock-google-drive-file-id-123/view");
      }, 1000);
      return;
    }

    // 3. Real Google Drive Multipart API upload
    try {
      const metadata = {
        name: title,
        mimeType: "image/png"
      };

      const formData = new FormData();
      formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      formData.append("file", blob);

      const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Upload failed with status: ${response.status}`);
      }

      const fileData = await response.json();
      const fileId = fileData.id;
      let webViewLink = fileData.webViewLink;

      // 4. Update file permissions to anyone with the link (makes it shareable)
      try {
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            role: "reader",
            type: "anyone"
          })
        });

        const linkRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=webViewLink`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const linkData = await linkRes.json();
        webViewLink = linkData.webViewLink;
      } catch (permissionErr) {
        console.warn("Could not make file public. Sharing links might be restricted:", permissionErr);
      }

      // 5. Update Supabase and local store
      await simulateCloudSync(title, fileId, webViewLink);

    } catch (error) {
      console.error("Google Drive Upload failed:", error);
      showCustomAlert("Google Drive Upload Failed", `An error occurred while uploading file: ${error.message}`);
      cloudUploadBtn.removeAttribute("disabled");
      cloudUploadBtn.innerHTML = "<span>▲</span> Save to Google Drive";
    }
  }, "image/png");
}

async function simulateCloudSync(title, fileId, webViewLink) {
  if (store.state.user) {
    try {
      const { data, error } = await supabase
        .from("captures")
        .insert([
          {
            user_id: store.state.user.id,
            provider: "google_drive",
            external_file_id: fileId,
            web_view_link: webViewLink,
            title: title
          }
        ])
        .select();

      if (error) {
        console.error("Supabase insert error:", error);
        showCustomAlert("Database Sync Failed", `Failed to insert record into cloud captures table: ${error.message}`);
      } else if (data && data[0]) {
        const list = [...store.state.captures];
        list.unshift(data[0]);
        store.state.captures = list;
      }
    } catch (err) {
      console.error("Cloud DB insertion crashed:", err);
    }
  } else {
    const list = [...store.state.captures];
    list.unshift({
      id: Math.random().toString(),
      title: title,
      external_file_id: fileId,
      web_view_link: webViewLink
    });
    store.state.captures = list;
  }

  cloudUploadBtn.removeAttribute("disabled");
  cloudUploadBtn.innerHTML = "<span>▲</span> Save to Google Drive";
  showToast("Capture successfully uploaded to Drive & synced!", "success");
}

async function loadCapturesFromSupabase() {
  if (!store.state.user) return;
  try {
    const { data, error } = await supabase
      .from("captures")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching captures:", error);
      return;
    }

    if (data) {
      store.state.captures = data;
    }
  } catch (err) {
    console.error("Failed to load captures:", err);
  }
}

// ----------------------------------------------------
// UI Button Listeners & Simulators
// ----------------------------------------------------

// Purchase simulation toggle
testProBtn.addEventListener("click", () => {
  const newProStatus = !store.state.is_premium;
  store.state.is_premium = newProStatus;
  const statusStr = newProStatus ? "PRO ACTIVE" : "FREE TIER";
  showToast(`Premium subscription toggled to [${statusStr}]`, "success");
});

// Viewport sizes toggles
document.querySelectorAll(".viewport-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".viewport-btn").forEach((b) => b.classList.remove("active"));
    e.currentTarget.classList.add("active");

    const mode = e.currentTarget.dataset.viewport;
    canvasContainer.className = "canvas-container"; // reset
    if (mode === "desktop") canvasContainer.classList.add("desktop-view");
    if (mode === "tablet") canvasContainer.classList.add("tablet-view");
    if (mode === "mobile") canvasContainer.classList.add("mobile-view");
  });
});

// Bind toolbar click events to change drawing tools
document.querySelectorAll(".tool-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
    e.currentTarget.classList.add("active");
    currentTool = e.currentTarget.dataset.tool;
  });
});

// Copy to Clipboard click
document.getElementById("btn-copy-clipboard").addEventListener("click", () => {
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast("Failed to copy stitched image.", "error");
      return;
    }
    navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]).then(() => {
      showToast("Stitched capture copied to clipboard!", "success");
    }).catch((err) => {
      console.error("Failed to copy to clipboard:", err);
      showToast("Clipboard blocked. Keep the window in the active foreground.", "warning");
    });
  }, "image/png");
});

// Toggle Download Dropdown Menu
const downloadToggle = document.getElementById("btn-download-toggle");
const downloadDropdown = document.getElementById("download-dropdown-menu");

downloadToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  downloadDropdown.classList.toggle("show");
});

// Close dropdown when clicking outside
window.addEventListener("click", () => {
  downloadDropdown.classList.remove("show");
  document.getElementById("ai-dropdown-menu").classList.remove("show");
});

// Download PNG click
document.getElementById("btn-download-png").addEventListener("click", () => {
  const dataUrl = canvas.toDataURL("image/png");
  const link = document.createElement("a");
  link.download = `SnapFlow_${Date.now()}.png`;
  link.href = dataUrl;
  link.click();
});

// Download PDF click (Native Direct PDF Writer)
document.getElementById("btn-download-pdf").addEventListener("click", () => {
  // Convert canvas to JPEG (high quality)
  const jpegUrl = canvas.toDataURL("image/jpeg", 0.95);
  
  // Convert DataURL (base64) to raw binary array
  const base64Data = jpegUrl.split(",")[1];
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Convert pixels to PDF points (1 pixel = 0.75 pt)
  const widthPt = canvas.width * 0.75;
  const heightPt = canvas.height * 0.75;

  const encoder = new TextEncoder();
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`;
  const obj4Start = `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${len} >>\nstream\n`;
  const obj4End = "\nendstream\nendobj\n";
  
  const contentStream = `q\n${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm\n/Im1 Do\nQ\n`;
  const obj5 = `5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`;

  const header = encoder.encode("%PDF-1.4\n");
  const b1 = encoder.encode(obj1);
  const b2 = encoder.encode(obj2);
  const b3 = encoder.encode(obj3);
  const b4Start = encoder.encode(obj4Start);
  const b4End = encoder.encode(obj4End);
  const b5 = encoder.encode(obj5);

  // Calculate offsets
  const offsets = [];
  let currentOffset = header.length;
  
  offsets.push(currentOffset);
  currentOffset += b1.length;
  
  offsets.push(currentOffset);
  currentOffset += b2.length;
  
  offsets.push(currentOffset);
  currentOffset += b3.length;
  
  offsets.push(currentOffset);
  currentOffset += b4Start.length + bytes.length + b4End.length;
  
  offsets.push(currentOffset);
  currentOffset += b5.length;

  const startXref = currentOffset;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 0; i < offsets.length; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  const bXref = encoder.encode(xref);
  const bTrailer = encoder.encode(trailer);

  const pdfBlob = new Blob([
    header,
    b1,
    b2,
    b3,
    b4Start,
    bytes,
    b4End,
    b5,
    bXref,
    bTrailer
  ], { type: "application/pdf" });

  const link = document.createElement("a");
  link.download = `SnapFlow_${Date.now()}.pdf`;
  link.href = URL.createObjectURL(pdfBlob);
  link.click();
});

// Save to Google Drive click
cloudUploadBtn.addEventListener("click", () => {
  uploadToGoogleDrive();
});

// ----------------------------------------------------
// Onboarding Interactive Tour Guide
// ----------------------------------------------------

const TOUR_STEPS = [
  {
    title: "1. Toolbar Editing Tools",
    text: "Select Select, Crop, Blur, Arrow, or Text to edit your capture.",
    target: ".tool-group",
    align: "bottom"
  },
  {
    title: "2. Device Preview Toggles",
    text: "Toggle between Desktop, Tablet, and Mobile viewports to test responsiveness.",
    target: ".viewport-toggles",
    align: "bottom"
  },
  {
    title: "3. Export Download Options",
    text: "Click Download to export your clean capture and annotations as PNG or PDF instantly.",
    target: "#btn-download-toggle",
    align: "bottom"
  },
  {
    title: "4. Cloud Storage Backup",
    text: "Connect to Google Drive to upload captures to your personal cloud workspace.",
    target: "#gdrive-connection-container",
    align: "right"
  },
  {
    title: "5. Replay Tour",
    text: "You can click this help guide button anytime to replay this tutorial.",
    target: "#btn-start-tour",
    align: "top"
  }
];

let currentTourStep = 0;

function startOnboardingTour() {
  currentTourStep = 0;
  showTourStep(0);
}

function showTourStep(stepIndex) {
  const step = TOUR_STEPS[stepIndex];
  if (!step) {
    endOnboardingTour();
    return;
  }

  const targetEl = document.querySelector(step.target);
  if (!targetEl) {
    currentTourStep++;
    showTourStep(currentTourStep);
    return;
  }

  removeOnboardingTourDOM();

  const overlay = document.createElement("div");
  overlay.className = "tour-overlay";
  
  const bubble = document.createElement("div");
  bubble.className = "tour-bubble";
  
  bubble.innerHTML = `
    <div class="tour-bubble-title">${step.title}</div>
    <div class="tour-bubble-text">${step.text}</div>
    <div class="tour-bubble-actions">
      <button class="tour-btn-skip">Skip</button>
      <button class="tour-btn-next">${stepIndex === TOUR_STEPS.length - 1 ? "Finish" : "Next"}</button>
    </div>
  `;

  const container = document.getElementById("tour-overlay-container");
  container.appendChild(overlay);
  container.appendChild(bubble);

  // Math calculation for alignment offsets
  const targetRect = targetEl.getBoundingClientRect();
  const bubbleW = 280;
  const bubbleH = bubble.offsetHeight || 110;

  let left = 0;
  let top = 0;
  let arrowClass = "arrow-top";

  if (step.align === "bottom") {
    left = targetRect.left + (targetRect.width / 2) - (bubbleW / 2);
    top = targetRect.bottom + window.scrollY + 12;
    arrowClass = "arrow-top";
  } else if (step.align === "top") {
    left = targetRect.left + (targetRect.width / 2) - (bubbleW / 2);
    top = targetRect.top + window.scrollY - bubbleH - 12;
    arrowClass = "arrow-bottom";
  } else if (step.align === "right") {
    left = targetRect.right + window.scrollX + 16;
    top = targetRect.top + window.scrollY + (targetRect.height / 2) - (bubbleH / 2);
    arrowClass = "arrow-left";
  } else if (step.align === "left") {
    left = targetRect.left + window.scrollX - bubbleW - 16;
    top = targetRect.top + window.scrollY + (targetRect.height / 2) - (bubbleH / 2);
    arrowClass = "arrow-right";
  }

  // boundary constraints
  if (left < 10) left = 10;
  if (left + bubbleW > window.innerWidth - 10) {
    left = window.innerWidth - bubbleW - 10;
  }

  if (top < 10) top = 10;
  if (top + bubbleH > window.innerHeight + window.scrollY - 10) {
    top = window.innerHeight + window.scrollY - bubbleH - 10;
  }

  bubble.className = `tour-bubble ${arrowClass}`;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;

  bubble.querySelector(".tour-btn-next").addEventListener("click", () => {
    currentTourStep++;
    showTourStep(currentTourStep);
  });

  bubble.querySelector(".tour-btn-skip").addEventListener("click", () => {
    endOnboardingTour();
  });
}

function removeOnboardingTourDOM() {
  const container = document.getElementById("tour-overlay-container");
  container.innerHTML = "";
}

function endOnboardingTour() {
  removeOnboardingTourDOM();
  store.state.onboarding_completed = true;
}

// Floating tour guide button listener
document.getElementById("btn-start-tour").addEventListener("click", () => {
  startOnboardingTour();
});

// Run stitching engine and render widgets
const urlParams = new URLSearchParams(window.location.search);
const errType = urlParams.get("error");
if (errType) {
  // Hide loader and onboarding tour
  const loader = document.getElementById("stitching-loader");
  if (loader) loader.style.display = "none";
  store.state.onboarding_completed = true; // prevent onboarding from launching
  
  // Render a friendly error message on the canvas workspace
  const canvasContainer = document.getElementById("canvas-container");
  const details = urlParams.get("details") || "Unknown capture initialization error.";
  
  if (errType === "security_blocked") {
    canvasContainer.innerHTML = `
      <div style="text-align: center; max-width: 500px; margin: 40px auto; padding: 40px 24px; background-color: var(--panel-bg); border: 1.5px solid #ef4444; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); font-family: inherit;">
        <div style="font-size: 40px; margin-bottom: 16px;">⚠️</div>
        <h2 style="color: #ef4444; font-size: 18px; margin-bottom: 12px; font-weight: 700;">Capture Blocked by Browser Security</h2>
        <p style="color: var(--text-secondary); font-size: 13px; line-height: 1.6; margin-bottom: 24px;">
          Chrome restricts injecting capture scripts on system pages (like <code>chrome://</code>, <code>edge://</code>, <code>about:</code>) or the Chrome Web Store to protect user privacy.
        </p>
        <button id="btn-error-close" class="btn btn-secondary" style="margin: auto; display: block; padding: 8px 20px;">Close Tab</button>
      </div>
    `;
  } else {
    canvasContainer.innerHTML = `
      <div style="text-align: center; max-width: 500px; margin: 40px auto; padding: 40px 24px; background-color: var(--panel-bg); border: 1.5px solid #ef4444; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); font-family: inherit;">
        <div style="font-size: 40px; margin-bottom: 16px;">❌</div>
        <h2 style="color: #ef4444; font-size: 18px; margin-bottom: 12px; font-weight: 700;">Capture Initialization Failed</h2>
        <p style="color: var(--text-secondary); font-size: 13px; line-height: 1.6; margin-bottom: 12px;">
          An error occurred while initializing the capture process:
        </p>
        <p style="background: rgba(239, 68, 68, 0.1); color: #ef4444; font-family: monospace; font-size: 12px; padding: 8px 12px; border-radius: 6px; margin-bottom: 24px; word-break: break-all;">
          ${details}
        </p>
        <button id="btn-error-close" class="btn btn-secondary" style="margin: auto; display: block; padding: 8px 20px;">Close Tab</button>
      </div>
    `;
  }
  document.getElementById("btn-error-close").addEventListener("click", () => {
    window.close();
  });
} else {
  stitchCapturedFrames();
}
renderGDriveConnection();

// Automatically sync session and check premium status on load
async function syncSessionOnStartup() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session && session.user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_premium, ai_credits, last_credit_reset")
        .eq("id", session.user.id)
        .single();

      let aiCredits = profile && typeof profile.ai_credits === "number" ? profile.ai_credits : 5;
      let lastReset = profile && profile.last_credit_reset ? new Date(profile.last_credit_reset) : new Date();
      const now = new Date();

      // Reset to 5 free credits every 30 days
      const diffDays = Math.ceil(Math.abs(now - lastReset) / (1000 * 60 * 60 * 24));
      if (diffDays >= 30) {
        aiCredits = 5;
        lastReset = now;
        try {
          await supabase
            .from("profiles")
            .update({
              ai_credits: 5,
              last_credit_reset: now.toISOString()
            })
            .eq("id", session.user.id);
          console.log("Successfully reset free AI credits to 5 (30-day duration completed)");
        } catch (updateErr) {
          console.error("Failed to reset AI credits in DB:", updateErr);
        }
      }

      store.state.user = {
        id: session.user.id,
        email: session.user.email,
        is_premium: profile ? profile.is_premium : false,
        ai_credits: aiCredits
      };
      store.state.is_premium = profile ? profile.is_premium : false;
      
      await loadCapturesFromSupabase();
    } else {
      store.state.user = null;
      store.state.is_premium = false;
      store.state.captures = [];
    }
  } catch (e) {
    console.error("Failed to sync session on startup:", e);
  } finally {
    // Check onboarding completion on startup
    setTimeout(() => {
      if (!store.state.onboarding_completed) {
        startOnboardingTour();
      }
    }, 1000);
  }
}

// Check onboarding/session on startup
if (!urlParams.get("error")) {
  syncSessionOnStartup();
} else {
  // If an error occurred, don't run onboarding
  store.state.onboarding_completed = true;
}

// ----------------------------------------------------
// AI Toolkit Integration (OCR & Tailwind CSS)
// ----------------------------------------------------

const aiToggle = document.getElementById("btn-ai-toggle");
const aiDropdown = document.getElementById("ai-dropdown-menu");

aiToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  aiDropdown.classList.toggle("show");
});

// Modal Elements
const modalOcr = document.getElementById("modal-ocr");
const modalTailwind = document.getElementById("modal-tailwind");
const ocrTextarea = document.getElementById("ocr-result-text");
const tailwindTextarea = document.getElementById("tailwind-code-block");
const tailwindIframe = document.getElementById("tailwind-preview-iframe");

// Close Modals
document.getElementById("btn-close-ocr").addEventListener("click", () => {
  modalOcr.classList.remove("active");
});
document.getElementById("btn-close-tailwind").addEventListener("click", () => {
  modalTailwind.classList.remove("active");
});

// Copy Buttons
document.getElementById("btn-copy-ocr").addEventListener("click", () => {
  ocrTextarea.select();
  document.execCommand("copy");
  showToast("Extracted OCR text copied to clipboard!", "success");
});

document.getElementById("btn-copy-tailwind").addEventListener("click", () => {
  tailwindTextarea.select();
  document.execCommand("copy");
  showToast("Tailwind CSS source code copied to clipboard!", "success");
});

// Tailwind Tab Switching
const tabPreview = document.getElementById("tab-tailwind-preview");
const tabCode = document.getElementById("tab-tailwind-code");
const contentPreview = document.getElementById("tailwind-preview-container");
const contentCode = document.getElementById("tailwind-code-container");

tabPreview.addEventListener("click", () => {
  tabPreview.classList.add("active");
  tabCode.classList.remove("active");
  contentPreview.classList.add("active");
  contentCode.classList.remove("active");
});

tabCode.addEventListener("click", () => {
  tabCode.classList.add("active");
  tabPreview.classList.remove("active");
  contentCode.classList.add("active");
  contentPreview.classList.remove("active");
});

// Call Gemini AI Helper
async function executeAITask(actionType) {
  // 1. Validation Checks
  if (!store.state.user) {
    showCustomAlert("Authentication Required", "Please connect your Cloud Workspace (log in via Supabase) first to use AI Toolkit features.");
    return;
  }

  const isPremium = store.state.is_premium;
  const credits = store.state.user && typeof store.state.user.ai_credits === "number"
    ? store.state.user.ai_credits
    : 0;

  if (!isPremium && credits <= 0) {
    showCustomConfirm(
      "Premium Subscription Required",
      "You have used all 5 free AI runs for this month.\n\nWould you like to upgrade to Pro Workspace for infinite AI queries and automated Cloud backups?",
      () => {
        showPricingModal();
      },
      { icon: "⚡", okText: "Upgrade Now", okBg: "var(--accent-color)" }
    );
    return;
  }

  // 2. Open Modals in Loading State
  if (actionType === "ocr") {
    ocrTextarea.value = "Analyzing capture and extracting text via Gemini AI... Please wait a moment.";
    document.getElementById("btn-copy-ocr").disabled = true;
    modalOcr.classList.add("active");
  } else if (actionType === "tailwind") {
    tailwindTextarea.value = "Converting layout to Tailwind HTML via Gemini AI... Please wait a moment.";
    
    // Reset iframe to sandbox.html to show the default loading screen
    tailwindIframe.src = "sandbox.html";
    
    document.getElementById("btn-copy-tailwind").disabled = true;
    modalTailwind.classList.add("active");
    
    // Force preview tab on open
    tabPreview.click();
  }

  // 3. Get Canvas Image
  const base64Image = canvas.toDataURL("image/png");

  // 4. Invoke Supabase Edge Function
  try {
    const { data, error } = await supabase.functions.invoke("gemini-ai", {
      body: { image: base64Image, action: actionType }
    });

    if (error) throw error;

    const resultText = data.text;

    // Sync remaining credits locally if returned from server
    if (data && typeof data.ai_credits === "number") {
      store.state.user = { ...store.state.user, ai_credits: data.ai_credits };
      showToast(`AI request processed! Remaining free runs this month: ${data.ai_credits}`, "info");
    }

    // 5. Update Modals with Result
    if (actionType === "ocr") {
      ocrTextarea.value = resultText || "No text was detected in the capture.";
      document.getElementById("btn-copy-ocr").disabled = false;
    } else if (actionType === "tailwind") {
      // Extract HTML block
      let htmlCode = resultText;
      const codeBlockRegex = /```html([\s\S]*?)```/i;
      const match = resultText.match(codeBlockRegex);
      if (match && match[1]) {
        htmlCode = match[1].trim();
      } else {
        htmlCode = resultText.trim();
      }

      // Write to Code Area
      tailwindTextarea.value = htmlCode;
      document.getElementById("btn-copy-tailwind").disabled = false;

      // Render in Sandbox Iframe (injecting Tailwind CSS CDN automatically to render) via postMessage
      
      // Inject tailwind script if not present
      if (!htmlCode.includes("play.tailwindcss.com") && !htmlCode.includes("cdn.tailwindcss.com")) {
        const injectTailwindHead = `<head>\n  <script src="https://cdn.tailwindcss.com"></script>\n`;
        if (htmlCode.includes("<head>")) {
          htmlCode = htmlCode.replace("<head>", injectTailwindHead);
        } else if (htmlCode.includes("<html>")) {
          htmlCode = htmlCode.replace("<html>", `<html>\n${injectTailwindHead}</head>`);
        } else {
          htmlCode = `<script src="https://cdn.tailwindcss.com"></script>\n${htmlCode}`;
        }
      }
      
      // Wait for sandbox.html to load, then send the HTML via postMessage
      const iframeLoadHandler = () => {
        tailwindIframe.contentWindow.postMessage({
          type: "render",
          html: htmlCode
        }, "*");
        tailwindIframe.removeEventListener("load", iframeLoadHandler);
      };
      
      tailwindIframe.addEventListener("load", iframeLoadHandler);
      // Reload sandbox.html to provide a clean DOM and message listener
      tailwindIframe.src = "sandbox.html";
    }
  } catch (err) {
    console.error("AI execution error:", err);
    
    // Close modal on failure
    modalOcr.classList.remove("active");
    modalTailwind.classList.remove("active");

    const errMsg = err.message || "";
    if (errMsg.includes("No free AI credits") || errMsg.includes("403")) {
      showCustomConfirm(
        "AI Limit Reached",
        "You have used all 5 free AI runs for this month.\n\nWould you like to upgrade to Pro Workspace for infinite AI queries?",
        () => {
          showPricingModal();
        },
        { icon: "⚡", okText: "Upgrade Now", okBg: "var(--accent-color)" }
      );
    } else {
      showCustomAlert("AI Processing Failure", `An error occurred while calling the Gemini API: ${err.message || err}`);
    }
  }
}

// Bind dropdown options
document.getElementById("btn-ai-ocr").addEventListener("click", () => {
  executeAITask("ocr");
});
document.getElementById("btn-ai-tailwind").addEventListener("click", () => {
  executeAITask("tailwind");
});

// Custom Premium Alert Modal Helper for Dashboard
function showCustomAlert(title, message, callback) {
  // Check if there is an existing alert modal, and remove it
  const existingModal = document.getElementById("custom-alert-modal");
  if (existingModal) existingModal.remove();

  const modalHtml = `
    <div id="custom-alert-modal" class="modal-overlay active" style="z-index: 1100;">
      <div class="modal-card" style="max-width: 420px; border: 1.5px solid var(--panel-border); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
        <div class="modal-header">
          <h3 style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">⚠️</span>
            <span>${title}</span>
          </h3>
          <button id="btn-close-custom-alert" class="modal-close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 16px; font-size: 13px; line-height: 1.6; color: var(--text-secondary);">
          ${message.replace(/\n/g, "<br>")}
        </div>
        <div class="modal-footer" style="padding: 12px 16px; justify-content: flex-end;">
          <button id="btn-ok-custom-alert" class="btn btn-primary" style="padding: 6px 16px; font-size: 12px;">Confirm</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const modal = document.getElementById("custom-alert-modal");
  const closeBtn = document.getElementById("btn-close-custom-alert");
  const okBtn = document.getElementById("btn-ok-custom-alert");

  const closeModal = () => {
    modal.classList.remove("active");
    setTimeout(() => {
      modal.remove();
      if (callback) callback();
    }, 200);
  };

  closeBtn.addEventListener("click", closeModal);
  okBtn.addEventListener("click", closeModal);
}

// Custom Toast Notification Helper for Dashboard
function showToast(message, type = "info") {
  const existingContainer = document.getElementById("toast-container");
  let container = existingContainer;
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText = `
      position: fixed;
      bottom: 80px;
      right: 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 1200;
      pointer-events: none;
    `;
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  const icon = type === "success" ? "✅" : type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
  const borderCol = type === "error" ? "#ef4444" : type === "warning" ? "#f59e0b" : type === "success" ? "#10b981" : "var(--accent-color)";

  toast.style.cssText = `
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background-color: var(--panel-bg);
    border: 1px solid ${borderCol};
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 500;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4);
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: auto;
  `;

  toast.innerHTML = `
    <span>${icon}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  // Trigger animation reflow
  setTimeout(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  }, 10);

  // Fade out and remove
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-10px)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Delete capture handler (Supabase Database + Google Drive file cleanup)
async function deleteCaptureItem(captureId, fileId) {
  showToast("Deleting capture...", "info");
  
  // 1. Delete from Google Drive if authorized
  const token = store.state.gdrive_token;
  if (token && token !== "mock-gdrive-access-token-987654" && fileId && !fileId.startsWith("mock")) {
    try {
      const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!driveRes.ok) {
        console.warn(`Google Drive deletion response code: ${driveRes.status}`);
      }
    } catch (driveErr) {
      console.warn("Could not delete from Google Drive:", driveErr);
    }
  }
  
  // 2. Delete from Supabase Database
  if (store.state.user) {
    try {
      const { error } = await supabase
        .from("captures")
        .delete()
        .eq("id", captureId);
        
      if (error) {
        console.error("Supabase delete failed:", error);
        showCustomAlert("Database Deletion Failed", `Could not remove capture from history: ${error.message}`);
        return;
      }
    } catch (err) {
      console.error("Supabase deletion crashed:", err);
      showCustomAlert("Database Deletion Failed", `An unexpected error occurred: ${err.message}`);
      return;
    }
  }
  
  // 3. Update UI state list
  const updatedList = store.state.captures.filter((c) => c.id !== captureId);
  store.state.captures = updatedList;
  
  showToast("Capture successfully deleted!", "success");
}

// Custom Premium Confirmation Dialog Helper for Dashboard
function showCustomConfirm(title, message, onConfirm, options = {}) {
  const existingModal = document.getElementById("custom-confirm-modal");
  if (existingModal) existingModal.remove();

  const icon = options.icon || "❓";
  const okText = options.okText || "Confirm";
  const okBg = options.okBg || "var(--accent-color)";

  const modalHtml = `
    <div id="custom-confirm-modal" class="modal-overlay active" style="z-index: 1100;">
      <div class="modal-card" style="max-width: 400px; border: 1.5px solid var(--panel-border); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
        <div class="modal-header">
          <h3 style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">${icon}</span>
            <span>${title}</span>
          </h3>
          <button id="btn-close-custom-confirm" class="modal-close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 16px; font-size: 13px; line-height: 1.6; color: var(--text-secondary);">
          ${message.replace(/\n/g, "<br>")}
        </div>
        <div class="modal-footer" style="padding: 12px 16px; justify-content: flex-end; gap: 8px;">
          <button id="btn-cancel-custom-confirm" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">Cancel</button>
          <button id="btn-ok-custom-confirm" class="btn" style="padding: 6px 16px; font-size: 12px; background-color: ${okBg}; color: white; border: none; border-radius: 6px; cursor: pointer;">${okText}</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const modal = document.getElementById("custom-confirm-modal");
  const closeBtn = document.getElementById("btn-close-custom-confirm");
  const cancelBtn = document.getElementById("btn-cancel-custom-confirm");
  const okBtn = document.getElementById("btn-ok-custom-confirm");

  const closeModal = () => {
    modal.classList.remove("active");
    setTimeout(() => modal.remove(), 200);
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);
  okBtn.addEventListener("click", () => {
    closeModal();
    if (onConfirm) onConfirm();
  });
}

// Custom Premium Pricing & Subscription Modal for Dashboard
function showPricingModal() {
  const existingModal = document.getElementById("pricing-modal");
  if (existingModal) existingModal.remove();

  const modalHtml = `
    <div id="pricing-modal" class="modal-overlay active" style="z-index: 1050;">
      <div class="modal-card" style="max-width: 480px; padding: 24px; border: 1.5px solid rgba(168, 85, 247, 0.4); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6); position: relative;">
        <button id="btn-close-pricing" class="modal-close" style="position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 24px; color: var(--text-muted); cursor: pointer;">&times;</button>
        
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="font-size: 32px; margin-bottom: 8px;">⚡</div>
          <h2 style="font-size: 20px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;">Upgrade to Pro Workspace</h2>
          <p style="font-size: 13px; color: var(--text-secondary);">Unlock the full potential of SnapFlow with AI-powered productivity tools.</p>
        </div>

        <!-- Billing Mode Toggle -->
        <div style="display: flex; justify-content: center; align-items: center; gap: 8px; margin-bottom: 24px; background: rgba(255,255,255,0.03); padding: 4px; border-radius: 9999px; border: 1px solid var(--panel-border); width: fit-content; margin-left: auto; margin-right: auto;">
          <button id="btn-toggle-monthly" class="btn-toggle-option" style="background: none; border: none; font-size: 12px; font-weight: 600; padding: 6px 16px; border-radius: 9999px; cursor: pointer; transition: all 0.2s;">Monthly</button>
          <button id="btn-toggle-annual" class="btn-toggle-option" style="background: none; border: none; font-size: 12px; font-weight: 600; padding: 6px 16px; border-radius: 9999px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 6px;">
            Annual
            <span style="background: var(--gold-gradient); color: #000; font-size: 9px; font-weight: 800; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Save 10%</span>
          </button>
        </div>

        <!-- Pricing Card details -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--panel-border); border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 20px;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--accent-color); letter-spacing: 1px; margin-bottom: 8px;">PRO WORKSPACE</div>
          
          <!-- Price display -->
          <div id="price-display-wrapper" style="margin-bottom: 20px; height: 58px; display: flex; align-items: center; justify-content: center;">
            <!-- Rendered dynamically -->
          </div>

          <!-- Features -->
          <ul style="text-align: left; list-style: none; padding: 0; margin: 0 auto 24px auto; max-width: 320px; display: flex; flex-direction: column; gap: 12px; font-size: 12.5px; border-top: 1px solid var(--panel-border); padding-top: 16px;">
            <li style="display: flex; align-items: center; gap: 8px;">✅ Unlimited Full-Page Captures</li>
            <li style="display: flex; align-items: center; gap: 8px;">✅ Non-destructive Annotation Editing</li>
            <li style="display: flex; align-items: center; gap: 8px;">✅ AI OCR Text Extraction (Gemini 3.5)</li>
            <li style="display: flex; align-items: center; gap: 8px;">✅ AI Tailwind CSS Code Converter</li>
            <li style="display: flex; align-items: center; gap: 8px;">✅ Google Drive Automated Sync</li>
          </ul>

          <button id="btn-checkout-submit" class="btn btn-primary" style="width: 100%; padding: 12px; font-size: 14px; font-weight: 700;">Upgrade Workspace</button>
        </div>

        <p style="font-size: 10.5px; color: var(--text-muted); text-align: center; line-height: 1.4; margin: 0;">
          Payments are securely processed by Polar.sh. Canceling is allowed at any time.
        </p>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const modal = document.getElementById("pricing-modal");
  const closeBtn = document.getElementById("btn-close-pricing");
  const monthlyBtn = document.getElementById("btn-toggle-monthly");
  const annualBtn = document.getElementById("btn-toggle-annual");
  const priceWrapper = document.getElementById("price-display-wrapper");
  const checkoutBtn = document.getElementById("btn-checkout-submit");

  let selectedPeriod = "annual"; // Default to annual billing (increases sales!)

  const updatePriceDisplay = () => {
    if (selectedPeriod === "monthly") {
      monthlyBtn.style.backgroundColor = "rgba(99, 102, 241, 0.15)";
      monthlyBtn.style.color = "var(--accent-color)";
      
      annualBtn.style.backgroundColor = "transparent";
      annualBtn.style.color = "var(--text-muted)";

      priceWrapper.innerHTML = `
        <div>
          <span style="font-size: 38px; font-weight: 800; color: #fff;">$4.99</span>
          <span style="font-size: 14px; color: var(--text-muted);">/ month</span>
        </div>
      `;
    } else {
      annualBtn.style.backgroundColor = "rgba(99, 102, 241, 0.15)";
      annualBtn.style.color = "var(--accent-color)";

      monthlyBtn.style.backgroundColor = "transparent";
      monthlyBtn.style.color = "var(--text-muted)";

      priceWrapper.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; gap: 2px;">
          <div>
            <span style="font-size: 38px; font-weight: 800; color: #fff;">$4.50</span>
            <span style="font-size: 14px; color: var(--text-muted);">/ month</span>
          </div>
          <span style="font-size: 11px; color: var(--success-color); font-weight: 700; letter-spacing: 0.2px;">
            Billed as $53.99 / year (Save 10%)
          </span>
        </div>
      `;
    }
  };

  // Initial update
  updatePriceDisplay();

  monthlyBtn.addEventListener("click", () => {
    selectedPeriod = "monthly";
    updatePriceDisplay();
  });

  annualBtn.addEventListener("click", () => {
    selectedPeriod = "annual";
    updatePriceDisplay();
  });

  closeBtn.addEventListener("click", () => {
    modal.classList.remove("active");
    setTimeout(() => modal.remove(), 200);
  });

  checkoutBtn.addEventListener("click", () => {
    if (!store.state.user) {
      showCustomAlert("Authentication Required", "Please Connect Cloud Workspace (log in via Supabase) first before upgrading to Pro.");
      return;
    }

    const checkoutBase = selectedPeriod === "monthly" 
      ? CONFIG.POLAR_CHECKOUT_MONTHLY 
      : CONFIG.POLAR_CHECKOUT_ANNUAL;

    // Pre-fill email and user_id metadata so the Polar.sh webhook can map and update the Supabase profile dynamically
    const checkoutUrl = `${checkoutBase}?metadata[user_id]=${store.state.user.id}&customer_email=${encodeURIComponent(store.state.user.email)}`;
    
    // Redirect
    chrome.tabs.create({ url: checkoutUrl });
    
    // Close modal
    modal.classList.remove("active");
    setTimeout(() => modal.remove(), 200);
  });
}
