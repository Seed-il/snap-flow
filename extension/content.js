/**
 * SnapFlow Content Script (extension/content.js)
 * 
 * Injected into web pages to measure dimensions, perform automated scrolling,
 * and temporarily hide sticky/fixed elements to ensure clean stitching.
 */

// Keep track of elements modified during the capture phase
let hiddenElements = [];

// Single listener for background runtime requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GET_PAGE_DIMENSIONS") {
    const pageDimensions = {
      pageWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
        document.documentElement.clientWidth
      ),
      pageHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        document.documentElement.clientHeight
      ),
      viewportWidth: window.innerWidth || document.documentElement.clientWidth,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight
    };
    sendResponse(pageDimensions);
  }

  if (request.action === "PREPARE_CAPTURE") {
    // Hide sticky and fixed headers to prevent duplication in scrolling frames
    hiddenElements = [];
    
    // Select all visible elements in the DOM
    const allElements = document.getElementsByTagName("*");
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      const style = window.getComputedStyle(el);
      const position = style.position;
      
      if (position === "fixed" || position === "sticky") {
        // Only hide if visible
        if (style.display !== "none" && style.visibility !== "hidden" && el.offsetHeight > 0) {
          hiddenElements.push({
            element: el,
            originalVisibility: el.style.visibility,
            originalTransition: el.style.transition
          });
          
          // Use visibility: hidden to preserve layout sizes and avoid shifts
          el.style.visibility = "hidden";
          // Disable smooth transitions temporarily to prevent fading lag during capture
          el.style.transition = "none";
        }
      }
    }
    
    sendResponse({ success: true, hiddenCount: hiddenElements.length });
  }

  if (request.action === "SCROLL_TO") {
    // Scroll window to targeted Y coordinate
    window.scrollTo(0, request.scrollY);
    sendResponse({ scrolled: true, currentY: window.scrollY });
  }

  if (request.action === "RESTORE_PAGE") {
    // Restore original visibility settings to hidden headers
    hiddenElements.forEach((item) => {
      if (item.element) {
        item.element.style.visibility = item.originalVisibility;
        item.element.style.transition = item.originalTransition;
      }
    });
    hiddenElements = [];
    sendResponse({ success: true });
  }
  
  return true;
});
