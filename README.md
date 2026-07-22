# SnapFlow: Next-Gen AI Web Capture & Developer Utility Suite

SnapFlow is a professional, high-performance Chrome Extension (Manifest v3) designed for developers, designers, and content creators. It provides pixel-perfect full-page scrolling captures, a rich canvas editor, seamless cloud synchronization, and AI-powered intelligence to convert visual designs into functional code.

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-SnapFlow-blue.svg)](https://chrome.google.com/webstore)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🚀 Key Features

* **Pixel-Perfect Full-Page Capture:** Automatically scroll and capture infinite-height pages. Stitches them instantly with advanced canvas boundary checks.
* **Canvas Annotator:** Crop, blur, highlight, and draw shapes (arrows, text, boxes) directly on your captured tabs.
* **Google Drive Integration:** Real-time, automatic, or manual synchronization of captured mockups to your personal workspace.
* **Gemini AI Developer Toolkit:**
  * **AI OCR:** Instant, high-accuracy text extraction from any section of a captured page.
  * **Tailwind CSS Code Generator:** Convert any selected visual component from your screen capture into clean, responsive Tailwind CSS/HTML code.
* **SaaS Billing & Subscriptions:** Full membership management and payment flows handled securely via Polar.sh.

---

## 🛠️ Technology Stack

* **Frontend:** Vanilla HTML5, CSS3 (Modern Glassmorphism), and Javascript (Chrome Extension APIs).
* **Backend Database & Logic:** Supabase (PostgreSQL, Auth, RLS Policies, Edge Functions).
* **AI Engine:** Google Gemini AI models.
* **Payment Processor:** Polar.sh (Webhooks, Subscriptions, and Checkout).

---

## 🔒 Chrome Extension Permissions Justification

SnapFlow uses specific permissions to deliver its productivity features. The justifications for each required permission are outlined below for Chrome Web Store reviewers:

* **`activeTab`:** Enables temporary access to the active tab to execute screen capture (`chrome.tabs.captureVisibleTab`) and capture layout boundaries when requested by the user.
* **`tabs`:** Used to handle tab redirection and manage the dashboard layout editor context upon capture completion.
* **`storage`:** Saves local user preferences (theme choice, default export folders) and caches capture history temporarily for offline access.
* **`identity` (Google OAuth):** Authenticates users securely to authorize direct media backups to their personal Google Drive folder.

---

## 📦 Local Installation & Development

To run this project locally:

1. Clone the repository:
   ```bash
   git clone https://github.com/Seed-il/snap-flow.git
   ```
2. Load the Extension in Chrome:
   * Open Chrome and navigate to `chrome://extensions/`.
   * Enable **Developer mode** (top right toggle).
   * Click **Load unpacked** (top left button) and select the `extension` directory of this project.
3. Configure the Supabase Backend:
   * Run migrations in `supabase/migrations`.
   * Deploy edge functions:
     ```bash
     supabase functions deploy gemini-ai --project-ref your_ref
     supabase functions deploy polar-webhook --no-verify-jwt --project-ref your_ref
     ```
   * Set secrets for your webhook signature and Gemini API keys.

---

## 📄 License

This project is licensed under the MIT License. See [privacy.html](privacy.html) for our user data and privacy protection policy.
