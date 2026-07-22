/**
 * Antigravity Framework Core (lib/antigravity.js)
 * 
 * A lightweight, high-performance, reactive state-management and UI binding framework
 * built specifically for Chrome Extensions Manifest v3. 
 * Features local persistence, Proxy-based reactivity, and memory-safe Web Component bindings.
 */

export class Store {
  /**
   * @param {Object} initialState - The starting state values
   * @param {string} storageKey - Key name for chrome.storage.local persistence
   */
  constructor(initialState = {}, storageKey = "snapflow_state") {
    this.storageKey = storageKey;
    this.listeners = new Map();
    
    // Initialize proxy for state change detection
    this.state = new Proxy({ ...initialState }, {
      set: (target, property, value) => {
        if (target[property] === value) return true;
        
        const oldValue = target[property];
        target[property] = value;
        
        // Async state persistence in Chrome Storage API context
        this._saveToStorage(property, value);
        
        // Trigger reactive bindings
        this._trigger(property, value, oldValue);
        return true;
      },
      get: (target, property) => {
        return target[property];
      }
    });
  }

  /**
   * Loads persisted state values from chrome.storage.local
   */
  async load() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get([this.storageKey], (result) => {
          if (result[this.storageKey]) {
            const savedState = result[this.storageKey];
            // Assign values quietly to target state to prevent redundant trigger loops
            Object.assign(this.state, savedState);
          }
          resolve(this.state);
        });
      });
    }
    return this.state;
  }

  _saveToStorage(property, value) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([this.storageKey], (result) => {
        const data = result[this.storageKey] || {};
        data[property] = value;
        chrome.storage.local.set({ [this.storageKey]: data });
      });
    }
  }

  /**
   * Subscribes to updates on a specific state key
   * @param {string} key - State property to monitor
   * @param {function(any, any): void} callback - Handler called with (newValue, oldValue)
   * @returns {function(): void} Unsubscribe function
   */
  subscribe(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key).push(callback);

    // Immediate invocation with current value for initial UI sync
    callback(this.state[key], undefined);

    return () => {
      const list = this.listeners.get(key) || [];
      const index = list.indexOf(callback);
      if (index > -1) {
        list.splice(index, 1);
      }
    };
  }

  _trigger(key, newValue, oldValue) {
    // Notify key-specific listeners
    const list = this.listeners.get(key) || [];
    list.forEach((cb) => cb(newValue, oldValue));

    // Notify global state observers
    const globalList = this.listeners.get("*") || [];
    globalList.forEach((cb) => cb(key, newValue, oldValue));
  }

  /**
   * Monitor any state changes globally
   * @param {function(string, any, any): void} callback - Handler called with (key, newValue, oldValue)
   * @returns {function(): void} Unsubscribe function
   */
  subscribeGlobal(callback) {
    return this.subscribe("*", callback);
  }
}

/**
 * Base HTMLElement class equipped with declarative reactive state bindings
 */
export class AntigravityElement extends HTMLElement {
  constructor() {
    super();
    this._unsubscribers = [];
  }

  /**
   * Binds store keys to handler functions inside the component scope
   * @param {Store} store - Antigravity state store instance
   * @param {Object.<string, function(any, any): void>} bindings - Object mapping state keys to update methods
   */
  bindStore(store, bindings = {}) {
    this.$store = store;
    for (const [key, updateFn] of Object.entries(bindings)) {
      const unsubscribe = store.subscribe(key, (newVal, oldVal) => {
        updateFn.call(this, newVal, oldVal);
      });
      this._unsubscribers.push(unsubscribe);
    }
  }

  /**
   * Lifecycle cleanup to avoid memory leaks
   */
  disconnectedCallback() {
    this._unsubscribers.forEach((unsub) => unsub());
    this._unsubscribers = [];
  }
}
