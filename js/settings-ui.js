// settings-ui.js - Settings modal (profile / criteria / automation / LLM) and mode bar

(function () {
  const $ = id => document.getElementById(id);

  const modal = $('settingsModal');
  const modeSeg = $('modeSeg');

  // ── Text <-> data parsers ─────────────────────────────────────────
  function parseSkills(text) {
    const out = {};
    String(text).split('\n').forEach(line => {
      const idx = line.search(/[:=]/);
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      const years = parseFloat(line.slice(idx + 1));
      if (key && !isNaN(years)) out[key] = years;
    });
    return out;
  }

  function serializeSkills(skills) {
    return Object.entries(skills || {}).map(([k, v]) => `${k} : ${v}`).join('\n');
  }

  function parseAnswers(text) {
    const out = {};
    String(text).split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx === -1) return;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key && val) out[key] = val;
    });
    return out;
  }

  function serializeAnswers(answers) {
    return Object.entries(answers || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  }

  function parseList(text) {
    return String(text).split(',').map(s => s.trim()).filter(Boolean);
  }

  // ── Modal open / populate / save ──────────────────────────────────
  async function openModal() {
    const profile = await JA.store.getProfile();
    const settings = await JA.store.getSettings();
    const llm = JA.llmConfig();

    $('sName').value = profile.name || '';
    $('sSkills').value = serializeSkills(profile.skills);
    $('sCurrentCTC').value = profile.currentCTC || '';
    $('sExpectedCTC').value = profile.expectedCTC || '';
    $('sNotice').value = profile.noticePeriod || '';
    $('sAvailability').value = profile.interviewAvailability || '';
    $('sRelocation').checked = !!profile.relocation;
    $('sApplyList').value = (profile.applyList || []).join(', ');
    $('sSkipList').value = (profile.skipList || []).join(', ');
    $('sAnswers').value = serializeAnswers(profile.answers);

    $('sThreshold').value = settings.matchThreshold;
    $('sDelay').value = Math.round(settings.applyDelayMs / 1000);
    $('sMaxApps').value = settings.maxApplicationsPerSession;
    $('sConfirmAuto').checked = !!settings.confirmBeforeAuto;

    $('sLlmUrl').value = llm.baseUrl;
    $('sLlmKey').value = llm.apiKey;
    $('sLlmModel').value = llm.model;

    modal.style.display = 'flex';
  }

  function closeModal() {
    modal.style.display = 'none';
  }

  async function saveSettings() {
    const profile = {
      ...(JA.cache.profile || {}),
      name: $('sName').value.trim(),
      skills: parseSkills($('sSkills').value),
      currentCTC: $('sCurrentCTC').value.trim(),
      expectedCTC: $('sExpectedCTC').value.trim(),
      noticePeriod: $('sNotice').value.trim(),
      interviewAvailability: $('sAvailability').value.trim(),
      relocation: $('sRelocation').checked,
      applyList: parseList($('sApplyList').value),
      skipList: parseList($('sSkipList').value),
      answers: parseAnswers($('sAnswers').value)
    };

    const prevSettings = JA.cache.settings || JA.SETTINGS_DEFAULTS;
    const settings = {
      ...prevSettings,
      matchThreshold: Math.min(100, Math.max(0, parseInt($('sThreshold').value, 10) || JA.CONFIG.matchThreshold)),
      applyDelayMs: (parseInt($('sDelay').value, 10) || 7) * 1000,
      maxApplicationsPerSession: parseInt($('sMaxApps').value, 10) || JA.CONFIG.maxApplicationsPerSession,
      confirmBeforeAuto: $('sConfirmAuto').checked,
      llm: {
        baseUrl: $('sLlmUrl').value.trim() || JA.CONFIG.llm.baseUrl,
        apiKey: $('sLlmKey').value.trim(),
        model: $('sLlmModel').value.trim() || JA.CONFIG.llm.model
      }
    };

    await JA.store.saveProfile(profile);
    await JA.store.saveSettings(settings);
    closeModal();
    logToChat('✓ Settings saved.', 'done');
  }

  // ── Mode bar ──────────────────────────────────────────────────────
  function highlightMode(mode) {
    modeSeg.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  async function initModeBar() {
    const settings = await JA.store.getSettings();
    highlightMode(settings.mode);
  }

  modeSeg.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    const mode = btn.dataset.mode;
    highlightMode(mode);
    const settings = await JA.store.getSettings();
    await JA.store.saveSettings({ ...settings, mode });
  });

  $('massApplyBtn').addEventListener('click', () => {
    if (typeof startMassApply === 'function') startMassApply();
  });

  // ── Wire up modal ─────────────────────────────────────────────────
  $('settingsBtn').addEventListener('click', openModal);
  $('settingsCloseBtn').addEventListener('click', closeModal);
  $('settingsCancel').addEventListener('click', closeModal);
  $('settingsSave').addEventListener('click', saveSettings);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  initModeBar();
})();
