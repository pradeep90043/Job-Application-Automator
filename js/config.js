// config.js - Shared namespace, static configuration, and runtime flags

window.JA = window.JA || {};

JA.CONFIG = {
  llm: {
    baseUrl: (window.ENV && window.ENV.LLM_BASE_URL) || 'http://92.4.82.192:3001/v1',
    apiKey: (window.ENV && window.ENV.LLM_API_KEY) || 'freellmapi-4e0925dd9fb706d111bfc9d7488bca72863b0ab75742de03',
    model: 'auto'
  },

  // Mass-apply pipeline defaults (overridable via appSettings in storage)
  matchThreshold: 70,
  applyDelayMs: 7000,
  maxApplicationsPerSession: 10,
  perJobTimeoutMs: 120000,

  // Agent loop step limits
  agentMaxSteps: 25,
  fallbackMaxSteps: 8,

  // When the agent is stuck (failed verification / no page context), attach a
  // screenshot of the tab to the next LLM call for visual analysis
  visionOnStuck: true,
  visionJpegQuality: 60,
  // Also screenshot when DOM extraction found fewer than this many elements
  visionSparseDomThreshold: 10,
  // On a second consecutive stuck signal, attach an extra 2× zoom of the
  // top half of the page (where titles / Apply buttons live)
  visionZoomWhenStillStuck: true,

  // Debug: when true, LinkedIn Easy Apply stops before the final submit click
  stopBeforeSubmit: false
};

// Mutable flags shared by the chat agent loop and the mass-apply pipeline
JA.flags = {
  isRunning: false,
  shouldStop: false
};

// Site handler registry — js/sites/*.js register themselves here
JA.sites = {};

// Effective LLM config: appSettings.llm (if loaded) overrides CONFIG defaults
JA.llmConfig = function () {
  const override = (JA.cache && JA.cache.settings && JA.cache.settings.llm) || {};
  return { ...JA.CONFIG.llm, ...override };
};
