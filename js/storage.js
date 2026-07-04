// storage.js - chrome.storage.local wrappers: agent state, profile, settings, history

// ── Low-level promise wrappers ──────────────────────────────────────
JA.storage = {
  get(keys) { return new Promise(res => chrome.storage.local.get(keys, res)); },
  set(obj)  { return new Promise(res => chrome.storage.local.set(obj, res)); },
  remove(keys) { return new Promise(res => chrome.storage.local.remove(keys, res)); }
};

// ── Agent loop state (used by the LLM step agent) ───────────────────
const AGENT_STATE_DEFAULTS = {
  goal: "",
  currentPage: "",
  currentJob: "",
  processedJobs: [],
  appliedJobs: [],
  skippedJobs: [],
  failedJobs: [],
  currentIndex: 0,
  navigationHistory: [],
  lastAction: "",
  lastURL: "",
  lastRealPage: "",
  lastRealURL: ""
};

let agentState = { ...AGENT_STATE_DEFAULTS };

async function loadAgentState() {
  const result = await JA.storage.get(['agentState']);
  if (result.agentState) {
    agentState = { ...agentState, ...result.agentState };
    console.log('✓ Loaded persistent agent state:', agentState);
  }
  return agentState;
}

function saveAgentState(newState) {
  agentState = { ...agentState, ...newState };
  chrome.storage.local.set({ agentState });
}

// ── User profile / app settings / application history ───────────────
JA.PROFILE_DEFAULTS = {
  name: "",
  skills: {},                 // { "react": 6, "node": 3 }
  currentCTC: "",
  expectedCTC: "",
  noticePeriod: "",
  relocation: true,
  interviewAvailability: "",
  applyList: [],              // keyword allowlist
  skipList: [],               // keyword blocklist
  answers: {}                 // { "notice period": "30" }
};

JA.SETTINGS_DEFAULTS = {
  mode: "dry-run",            // "dry-run" | "manual" | "auto"
  matchThreshold: JA.CONFIG.matchThreshold,
  applyDelayMs: JA.CONFIG.applyDelayMs,
  maxApplicationsPerSession: JA.CONFIG.maxApplicationsPerSession,
  perJobTimeoutMs: JA.CONFIG.perJobTimeoutMs,
  confirmBeforeAuto: true,
  llm: {}                     // optional overrides of CONFIG.llm
};

const HISTORY_CAP = 500;

// In-memory cache so sync code paths (e.g. JA.llmConfig) can read settings
JA.cache = { profile: null, settings: null };

JA.store = {
  normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  },

  jobKey(job) {
    const base = job.jobId
      ? String(job.jobId)
      : `${JA.store.normalize(job.title)}|${JA.store.normalize(job.company)}`;
    return `${job.source || 'unknown'}:${base}`;
  },

  async getProfile() {
    const r = await JA.storage.get(['userProfile']);
    JA.cache.profile = { ...JA.PROFILE_DEFAULTS, ...(r.userProfile || {}) };
    return JA.cache.profile;
  },

  async saveProfile(profile) {
    JA.cache.profile = { ...JA.PROFILE_DEFAULTS, ...profile };
    await JA.storage.set({ userProfile: JA.cache.profile });
    return JA.cache.profile;
  },

  async getSettings() {
    const r = await JA.storage.get(['appSettings']);
    JA.cache.settings = { ...JA.SETTINGS_DEFAULTS, ...(r.appSettings || {}) };
    return JA.cache.settings;
  },

  async saveSettings(settings) {
    JA.cache.settings = { ...JA.SETTINGS_DEFAULTS, ...settings };
    await JA.storage.set({ appSettings: JA.cache.settings });
    return JA.cache.settings;
  },

  async getHistory() {
    const r = await JA.storage.get(['applicationHistory']);
    return r.applicationHistory || [];
  },

  async addHistoryRecord(record) {
    const history = await JA.store.getHistory();
    history.push({ timestamp: new Date().toISOString(), ...record });
    while (history.length > HISTORY_CAP) history.shift();
    await JA.storage.set({ applicationHistory: history });
    return history;
  },

  // Map of jobKey -> record for O(1) dedup lookups during a session.
  // Records with status "failed" are retryable, so they are excluded.
  async getProcessedMap() {
    const history = await JA.store.getHistory();
    const map = new Map();
    for (const rec of history) {
      if (rec.status === 'applied' || rec.status === 'skipped') {
        map.set(rec.jobKey, rec);
      }
    }
    return map;
  },

  async getSession() {
    const r = await JA.storage.get(['massApplySession']);
    return r.massApplySession || null;
  },

  async saveSession(session) {
    await JA.storage.set({ massApplySession: session });
  },

  async clearSession() {
    await JA.storage.remove(['massApplySession']);
  }
};
