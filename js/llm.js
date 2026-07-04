// llm.js - FreeLLM API client, response parsers, and the agent-loop prompt

// ── Generic chat-completion wrapper ─────────────────────────────────
async function llmChat(messages, { temperature = 0.3, maxTokens = 500, expectJson = false } = {}) {
  const { baseUrl, apiKey, model } = JA.llmConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const doCall = async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  };

  const text = await doCall();
  if (!expectJson) return text;

  const parsed = extractJSON(text);
  if (parsed) return parsed;

  // One retry on parse failure
  const retryText = await doCall();
  const retryParsed = extractJSON(retryText);
  if (retryParsed) return retryParsed;
  throw new Error('LLM did not return valid JSON');
}

function extractJSON(text) {
  const clean = String(text).replace(/```json|```/gi, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) return null;
  try {
    return JSON.parse(clean.slice(s, e + 1));
  } catch (err) {
    return null;
  }
}

// ── Job matching ────────────────────────────────────────────────────
// One LLM call per job. Returns {match, score, reason}; throws on failure
// (callers treat failure as "skip" — never auto-apply on uncertainty).
async function scoreJob(job, profile) {
  const messages = [
    {
      role: 'system',
      content: 'You are a job-matching assistant. Compare a job posting against a candidate profile and decide whether the candidate should apply. Respond ONLY with JSON in exactly this shape: {"match": true/false, "score": 0-100, "reason": "one short sentence"}. score reflects skill overlap and seniority fit. match=false if any skip-list technology is the primary requirement.'
    },
    {
      role: 'user',
      content: `Job Title: ${job.title}
Company: ${job.company || 'Unknown'}
Required skills: ${(job.skills || []).join(', ') || 'Not listed'}
Description: ${(job.description || '').slice(0, 800)}

Candidate skills (years): ${JSON.stringify(profile.skills)}
Apply list (wants these): ${(profile.applyList || []).join(', ')}
Skip list (avoid these): ${(profile.skipList || []).join(', ')}`
    }
  ];
  const res = await llmChat(messages, { temperature: 0.3, maxTokens: 500, expectJson: true });
  return {
    match: !!res.match,
    score: Math.max(0, Math.min(100, Number(res.score) || 0)),
    reason: String(res.reason || '').slice(0, 200)
  };
}

// ── Answer generation for form questions ────────────────────────────
// For option fields the answer is validated against the option texts;
// throws if the LLM can't produce a valid answer (caller escalates).
async function generateAnswer(field, questionText, job, profile) {
  const optionsNote = (field.options && field.options.length)
    ? `Options — choose EXACTLY one and reply with its exact text: ${field.options.map(o => o.text).join(' | ')}`
    : 'Free text: reply with a short answer (a plain number, or 1-3 sentences for descriptive questions).';

  const messages = [
    {
      role: 'system',
      content: 'You answer job-application form questions on behalf of a candidate. Use ONLY facts from the candidate profile; never invent qualifications. Respond ONLY with JSON: {"answer": "..."}'
    },
    {
      role: 'user',
      content: `Question: ${field.question || field.label || questionText}
Field type: ${field.kind}
${optionsNote}

Candidate profile:
${JSON.stringify(profile)}

Job: ${job.title} @ ${job.company}
${(job.description || '').slice(0, 300)}`
    }
  ];

  const res = await llmChat(messages, { temperature: 0.3, maxTokens: 600, expectJson: true });
  let answer = String(res.answer ?? '').trim();
  if (!answer) throw new Error('LLM returned empty answer');

  if (field.options && field.options.length) {
    const lower = answer.toLowerCase();
    const match = field.options.find(o => o.text.toLowerCase() === lower)
      || field.options.find(o => o.text.toLowerCase().includes(lower) || lower.includes(o.text.toLowerCase()));
    if (!match) throw new Error(`LLM answer "${answer}" does not match any option`);
    answer = match.text;
  }
  return answer;
}

// ── Connection test ─────────────────────────────────────────────────
async function testConnection(url, key) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url}/models`, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch(e) {
    return false;
  }
}

// ── Agent-loop chat completion ──────────────────────────────────────
async function askFreeLLM(apiUrl, apiKey, modelName, goal, contextText, history, stepNum, screenshot = null) {
  const systemPrompt = `You are an intelligent, action-oriented job application automation assistant.
Your goal is to find and apply to matching jobs on recruitment websites (like Naukri.com).

### CRITICAL: Stop endless analysis. Take decisive action (click, type, scroll, wait) on every step.
### CRITICAL: Do NOT write any introduction, commentary, explanations, reasoning, or markdown code blocks (e.g. \`\`\`json or \`\`\`). Start your response directly with "PageType:".

------------------------------------
DECISION LOGIC (Execute in this order)

#### PRIORITY 1: HANDLE ACTIVE OVERLAY / DRAWER / MODAL
IF an overlay, side drawer, or modal is open:
  IF it's a questionnaire or form:
    → Fill it out methodically.
    → When filling text input fields, simply use TYPE("value"). Do NOT click the input first (the system automatically focuses it).
    → Submit the form by clicking "Save", "Submit", or "Continue".
    → Do NOT press Back or navigate away.
  ELSE IF it's a job details overlay:
    → If it matches the target job/keywords: click the "Apply" button within the overlay.
    → If it does not match: close the overlay using its close button reference (e.g. [agent-X]) and return to listings.

#### PRIORITY 2: IDENTIFY AND OPEN JOBS
IF on a job listing page:
  1. Check if the user specified a target job title or keyword (e.g. "React", "React JS").
  2. Search visible job cards:
     - IF a matching job title is visible: click the job title immediately to open it.
     - IF no matching job is visible AND a search bar is available: click the search bar, type the keyword, and press Enter to search directly.
     - IF no matching job is visible AND no search bar is available: scroll down once to load more jobs.
  3. If the user goal does not specify target keywords, treat all listed jobs as matching and open the first unprocessed job immediately.
  4. Never scroll endlessly. Limit scrolling to a maximum of 2 times. If still no matches, switch tabs (e.g. click "Preferences") or complete.

#### PRIORITY 3: APPLY TO OPENED JOB
When job details are loaded:
  - Locate the "Apply", "Easy Apply", or "Apply Now" button.
  - Click the button immediately.

------------------------------------
Available Browser Tools
CLICK(text)
CLICK_INDEX(index)
TYPE(text)
PRESS(key)
SCROLL_DOWN()
SCROLL_UP()
GO_BACK()
OPEN(url)
WAIT(seconds)
READ_PAGE()
DONE()

------------------------------------
CRITICAL RULES
- Decide only ONE browser action on every step.
- When filling a text field, use TYPE("value"). The system will automatically focus the field.
- Never generate CSS selectors, code, or scripts. Only use CLICK(text) or CLICK_INDEX(index).
- Always verify the page state or active overlays before choosing actions.

------------------------------------
Output Format:
You MUST respond ONLY in the following format. Do NOT wrap in JSON, do NOT include any introductory or concluding text, and do NOT wrap in markdown code blocks. Start your response directly with the string "PageType:":

PageType:
[Listing, Job Detail, Side Drawer, Modal, Questionnaire, Resume Upload, External ATS, Tracking, Captcha, Success, or Unknown]

Detected:
- [bullet point of key items detected]

Goal:
[short goal statement]

NextAction:
[exactly one of the available tools, e.g. CLICK("Apply Now") or TYPE("30") or CLICK_INDEX(2)]`;

  const historyText = history.length
    ? '\nProgress History:\n' + history.map(h => `  Step ${h.step}: ${h.type}${h.target ? ` → "${h.target}"` : ''}`).join('\n')
    : '';

  const currentURL = contextText ? (contextText.match(/Active Tab URL: (.*)/)?.[1] || 'Unknown') : 'Unknown';

  const prependedText = `Current Goal:
${goal || agentState.goal || 'Apply to all jobs.'}

Current URL:
${currentURL}

Navigation History:
${(agentState.navigationHistory && agentState.navigationHistory.length > 0) ? agentState.navigationHistory.join(', ') : 'Unknown'}

Current Job:
${agentState.currentJob || 'Unknown'}

Already Applied:
${(agentState.appliedJobs && agentState.appliedJobs.length > 0) ? agentState.appliedJobs.join(', ') : 'Unknown'}

Already Visited:
${(agentState.processedJobs && agentState.processedJobs.length > 0) ? agentState.processedJobs.join(', ') : 'Unknown'}

Current Page Type:
${agentState.currentPage || 'Unknown'}

Last Real Page:
${agentState.lastRealPage || 'Unknown'}

Last Real URL:
${agentState.lastRealURL || 'Unknown'}

Decide only ONE browser action.

If application completed,
return to listings.

If on listings,
open next unprocessed job.

Do not repeat previous actions.

CRITICAL: Start your response directly with "PageType:" and output ONLY the requested structured format. Do NOT write any reasoning, commentary, preambles, or explanations.`;

  const userText = `${prependedText}\n\nPage Context:\n${contextText}${historyText}\n\nStep ${stepNum}: What is your response?`;

  // With screenshot(s): OpenAI vision content format. If the backend rejects
  // vision input, we retry once text-only below.
  const shots = !screenshot ? [] : (Array.isArray(screenshot) ? screenshot : [screenshot]);
  const visionNote = shots.length > 1
    ? '\n\nSCREENSHOTS of the current page are attached: image 1 is the full visible page, image 2 is a 2× ZOOM of the top half (use it to read small buttons/labels like "Apply"). The DOM extraction may be incomplete or misleading — trust the screenshots, locate visible buttons/fields/messages, and pick the action that matches what is really on screen.'
    : '\n\nA SCREENSHOT of the current page is attached. The DOM extraction may be incomplete or misleading — use the screenshot to see the actual layout, locate visible buttons/fields/messages, and pick the action that matches what is really on screen.';
  const buildMessages = (withImage) => [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: withImage
        ? [
            { type: 'text', text: userText + visionNote },
            ...shots.map(s => ({ type: 'image_url', image_url: { url: s } }))
          ]
        : userText
    }
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const doCall = async (withImage) => {
    const res = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: buildMessages(withImage),
        max_tokens: 1500,
        temperature: 0.1,
        frequency_penalty: 1.0
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err.error?.message || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '{}';
  };

  let text;
  try {
    text = await doCall(shots.length > 0);
  } catch (e) {
    if (!shots.length) throw e;
    // Vision not supported by the backend/model — degrade to text-only
    console.warn('Vision call failed, retrying text-only:', e.message);
    text = await doCall(false);
  }
  console.log('AI Raw Response:', text);
  return repairAndParseJSON(text);
}

// ── Response parsing ────────────────────────────────────────────────
function extractToolArgument(actionLine) {
  const start = actionLine.indexOf('(');
  const end = actionLine.lastIndexOf(')');
  if (start !== -1 && end !== -1 && end > start) {
    const arg = actionLine.slice(start + 1, end).trim();
    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
      return arg.slice(1, -1);
    }
    return arg;
  }
  return "";
}

function parseTextAgentResponse(rawText) {
  const pageTypeMatch = rawText.match(/PageType:\s*(.*)/i);
  const nextActionMatch = rawText.match(/NextAction:\s*([\s\S]*)/i);

  const pageType = pageTypeMatch ? pageTypeMatch[1].trim() : "Unknown";
  const actionLine = nextActionMatch ? nextActionMatch[1].trim() : "";

  const thoughtLines = [];
  if (pageType) thoughtLines.push(`PageType: ${pageType}`);

  const detectedMatch = rawText.match(/Detected:\s*([\s\S]*?)(?=Goal:|$)/i);
  if (detectedMatch && detectedMatch[1].trim()) {
    thoughtLines.push(`Detected:\n${detectedMatch[1].trim()}`);
  }

  const goalMatch = rawText.match(/Goal:\s*([\s\S]*?)(?=NextAction:|$)/i);
  if (goalMatch && goalMatch[1].trim()) {
    thoughtLines.push(`Goal: ${goalMatch[1].trim()}`);
  }

  const thought = thoughtLines.join('\n\n');

  let action = null;
  if (actionLine.startsWith('CLICK_INDEX') || actionLine.startsWith('click_index')) {
    const arg = extractToolArgument(actionLine);
    const index = parseInt(arg, 10);
    action = { type: 'click', selector: `[data-agent-id='agent-${index}']` };
  } else if (actionLine.startsWith('CLICK') || actionLine.startsWith('click')) {
    const arg = extractToolArgument(actionLine);
    action = { type: 'click_text', text: arg };
  } else if (actionLine.startsWith('TYPE') || actionLine.startsWith('type')) {
    const arg = extractToolArgument(actionLine);
    action = { type: 'type_text', text: arg };
  } else if (actionLine.startsWith('PRESS') || actionLine.startsWith('press')) {
    const arg = extractToolArgument(actionLine);
    action = { type: 'key', key: arg };
  } else if (actionLine.startsWith('SCROLL_DOWN') || actionLine.startsWith('scroll_down')) {
    action = { type: 'scroll', direction: 'down', amount: 400 };
  } else if (actionLine.startsWith('SCROLL_UP') || actionLine.startsWith('scroll_up')) {
    action = { type: 'scroll', direction: 'up', amount: 400 };
  } else if (actionLine.startsWith('GO_BACK') || actionLine.startsWith('go_back')) {
    action = { type: 'go_back' };
  } else if (actionLine.startsWith('OPEN') || actionLine.startsWith('open')) {
    const arg = extractToolArgument(actionLine);
    action = { type: 'navigate', url: arg };
  } else if (actionLine.startsWith('WAIT') || actionLine.startsWith('wait')) {
    const arg = extractToolArgument(actionLine);
    action = { type: 'wait', ms: parseInt(arg, 10) * 1000 };
  } else if (actionLine.startsWith('READ_PAGE') || actionLine.startsWith('read_page')) {
    action = { type: 'read_page' };
  } else if (actionLine.startsWith('DONE') || actionLine.startsWith('done')) {
    action = { type: 'done' };
  }

  return {
    response: thought,
    action: action,
    state: pageType ? { currentPage: pageType } : null
  };
}

function repairAndParseJSON(rawText) {
  let clean = rawText.replace(/```json|```/gi, '').trim();

  // Detect if response is in the structured text-based format
  if (clean.toLowerCase().includes('pagetype:') || clean.toLowerCase().includes('nextaction:')) {
    console.log('✓ Parsing text-agent structured response...');
    return parseTextAgentResponse(clean);
  }

  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s === -1 || e === -1) {
    console.warn('No JSON boundaries found. Treating raw response as conversational text.');
    return {
      response: rawText.trim(),
      action: null
    };
  }
  let jsonString = clean.slice(s, e + 1);

  try {
    return JSON.parse(jsonString);
  } catch (err) {
    console.warn('Standard JSON parsing failed, attempting repair:', err.message);
    let repaired = jsonString
      .replace(/,\s*([\]}])/g, '$1')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');

    try {
      return JSON.parse(repaired);
    } catch (err2) {
      console.warn('JSON repair failed, attempting regex extraction:', err2.message);
      try {
        const extracted = { response: "", action: null };

        // Extract response text
        const responseMatch = jsonString.match(/['"]response['"]\s*:\s*['"]((?:[^'"\\\\]|\\\\.)*)['"]/i);
        if (responseMatch) {
          extracted.response = responseMatch[1];
        }

        // Check if there is an action block
        const actionMatch = jsonString.match(/['"]action['"]\s*:\s*\{([^}]*)\}/i);
        if (actionMatch && !actionMatch[1].includes('null')) {
          const actionString = actionMatch[1];
          const actionObj = {};

          const typeMatch = actionString.match(/['"]type['"]\s*:\s*['"]([^'"]*)['"]/i);
          if (typeMatch) actionObj.type = typeMatch[1];

          const selectorMatch = actionString.match(/['"]selector['"]\s*:\s*['"]((?:[^'"\\\\]|\\\\.)*)['"]/i);
          if (selectorMatch) actionObj.selector = selectorMatch[1];

          const textMatch = actionString.match(/['"]text['"]\s*:\s*['"]((?:[^'"\\\\]|\\\\.)*)['"]/i);
          if (textMatch) actionObj.text = textMatch[1];

          const keyMatch = actionString.match(/['"]key['"]\s*:\s*['"]([^'"]*)['"]/i);
          if (keyMatch) actionObj.key = keyMatch[1];

          const urlMatch = actionString.match(/['"]url['"]\s*:\s*['"]([^'"]*)['"]/i);
          if (urlMatch) actionObj.url = urlMatch[1];

          extracted.action = actionObj;
        }

        // Check if there is a state block
        const stateMatch = jsonString.match(/['"]state['"]\s*:\s*\{([^}]*)\}/i);
        if (stateMatch) {
          try {
            extracted.state = JSON.parse(`{${stateMatch[1]}}`);
          } catch(e) {}
        }

        if (extracted.response || extracted.action || extracted.state) {
          return extracted;
        }
      } catch (err3) {
        console.error('Regex extraction failed:', err3);
      }
      console.warn('JSON parsing and regex extraction failed. Falling back to treating raw response as conversational text.');
      return {
        response: rawText.trim(),
        action: null
      };
    }
  }
}
