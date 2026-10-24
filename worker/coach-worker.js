/*
  HirePilot - AI coach proxy (Cloudflare Worker)

  Holds the OpenRouter key so it never appears in the web page, writes the prompts,
  chooses the model for each task, and only answers requests from the app's own site.
  The page sends structured fields (job description, CV, answer...), never a free-form
  prompt, so the key can't be used as a general-purpose chatbot.

  Secret (set in Cloudflare, never in this file):  OPENROUTER_API_KEY_HIREPILOT
  Optional variable:  ALLOWED_ORIGINS  - comma-separated extra origins, e.g. for local testing
*/

const MODELS = {
  cv:        'anthropic/claude-sonnet-5',  // CV review, virtual hiring panel and tailored CV
  plan:      'anthropic/claude-sonnet-5',  // reads JD + CV + interviewer profiles, writes the prep plan
  questions: 'anthropic/claude-sonnet-5',  // mock questions with model answers
  rate:      'google/gemini-3.8-flash'     // listens to the recorded answer and rates it
};
const SITE = 'https://chamwong123-glitch.github.io';
const MAX_FIELD = 20000;           // characters per document
const MAX_PROFILE = 6000;          // characters per interviewer profile
const MAX_INTERVIEWERS = 6;
const MAX_AUDIO = 10 * 1024 * 1024; // base64 characters, about 3.5 minutes of 16 kHz mono WAV

function allowedOrigins(env){
  return [SITE].concat(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
}
function cors(origin){
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function reply(status, body, origin){
  return new Response(JSON.stringify(body), {
    status, headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? cors(origin) : {})
  });
}

/* the models are asked for JSON; tolerate code fences or stray text around it */
function parseJson(text){
  const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max).trim();

/* ---------- prompts ---------- */

const COACH = `You are an experienced interview coach who has prepared candidates for roles in every field: ` +
  `technology, finance, healthcare, education, trades, hospitality, government, creative work, sales, research and more. ` +
  `Adapt to the field and seniority of the role in front of you; never assume it is a tech job. ` +
  `Be specific to the documents you are given, practical, honest about gaps, and never invent facts about the candidate. ` +
  `Where the CV lacks a detail an answer needs, write a placeholder in square brackets, e.g. [number of people you managed]. ` +
  `Interviewer profiles are public professional information; use them only to anticipate the interviewer's focus and to build rapport, ` +
  `never to comment on personal characteristics.`;

function context(b){
  const people = b.interviewers.map((p, i) =>
    `Interviewer ${i + 1}: ${p.name || 'Unnamed'}${p.title ? ' - ' + p.title : ''}\n${p.profile || '(no profile text)'}`).join('\n\n');
  return [
    `INTERVIEW STAGE: ${b.stage || 'not specified'}`,
    b.notes ? `CANDIDATE NOTES: ${b.notes}` : '',
    `JOB DESCRIPTION:\n${b.jd}`,
    `CANDIDATE CV:\n${b.cv || '(not provided)'}`,
    `INTERVIEWERS:\n${people || '(none provided)'}`
  ].filter(Boolean).join('\n\n---\n\n');
}

function planPrompt(b){
  return `${COACH}

Read the documents below and write a preparation plan for this interview.

${context(b)}

---

Reply with JSON only, no other text, in exactly this shape:
{
  "role": { "title": "", "company": "", "field": "", "seniority": "", "summary": "2-3 sentences on what this job really needs" },
  "fit": {
    "score": 0-100 estimate of how well the CV matches the job,
    "verdict": "one sentence",
    "strengths": [ { "point": "", "evidence": "where it shows in the CV" } ],
    "gaps": [ { "gap": "", "how_to_address": "what to say or prepare" } ]
  },
  "focus_areas": [ { "topic": "", "why": "", "how_to_prepare": "" } ],
  "stories": [ { "theme": "e.g. handling conflict", "cv_example": "which experience to use", "star": { "situation": "", "task": "", "action": "", "result": "" } } ],
  "interviewers": [ { "name": "", "role": "", "likely_focus": "", "rapport_tips": "", "questions_to_ask": [""] } ],
  "tricky_topics": [ { "topic": "e.g. a career gap, a short tenure, salary", "suggested_approach": "" } ],
  "questions_to_ask": [ "good questions for the candidate to ask at the end" ],
  "research_checklist": [ "" ],
  "timeline": [ { "when": "e.g. 3 days before", "tasks": [""] } ]
}
Give 3-4 strengths, 2-3 gaps, 3-5 focus areas, 3-4 stories, one entry per interviewer (empty array if none), 4-5 questions to ask, and 3-4 timeline steps ending with "On the day".
Be concise: keep every text value to one or two short sentences, and each STAR part to one sentence.`;
}

function cvPrompt(b){
  const answers = b.answers.length
    ? `\n\nTHE CANDIDATE HAS CONFIRMED THE FOLLOWING (treat as true facts you may use in the CV):\n` +
      b.answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    : '';
  const rules = `CV rules: never invent employers, titles, dates, degrees, numbers or skills. Only use what is in the CV or what the candidate confirmed. ` +
    `Where a number would strengthen a bullet but none is known, write a placeholder like [x%] for the candidate to fill in. ` +
    `Keep the candidate's real job history and dates. Mirror the job description's wording where it is honestly true. ` +
    `Put the most relevant experience and skills first. Aim for 2 pages at most. Write in the spelling of the job's country.`;
  const cvFormat = `Write tailored_cv as plain text using this light markup: first line "# Full Name", then a contact line, ` +
    `then sections starting with "## " (e.g. ## Summary, ## Key skills, ## Experience, ## Education). ` +
    `In Experience write each role as "### Job title, Company, City | Start - End" followed by bullet lines starting with "- ".`;

  if (b.mode === 'update') {
    return `${COACH}

You earlier tailored this candidate's CV for the job below. They have now answered questions about extra experience.
Revise the tailored CV to make honest use of every relevant "yes" answer. Ignore "no" answers, and do not add anything they did not confirm.

${context(b)}

---

CURRENT TAILORED CV:
${b.current_cv}${answers}

---

${rules}
${cvFormat}

Reply with JSON only, no other text, in exactly this shape:
{
  "tailored_cv": "",
  "changes": [ { "change": "what you changed", "why": "why it helps for this job" } ],
  "resolved": [ "names of missing skills that the answers now cover" ],
  "questions": [ { "skill": "", "question": "a NEW follow-up yes/no question, only if an answer opened up something worth asking", "why": "" } ]
}
Give 0-3 follow-up questions; use an empty array if there is nothing more worth asking.`;
  }

  return `${COACH}

Review the candidate's CV against the job below, the way a real hiring team would, then write a tailored version of the CV for this job.

${context(b)}${answers}

---

1. THE 10-SECOND SCAN. Recruiters and hiring managers spend about 10 seconds on a first look at a CV.
   Describe what each of these two readers would actually take in during those 10 seconds (the top third of page 1, job titles,
   company names, dates, and anything bold or numeric), whether they would keep reading, and the quickest fixes:
   - HR / talent acquisition: screens for must-have requirements, keywords, job titles, stability, gaps, location or right to work.
   - The hiring manager: screens for relevant results, scope and level, domain and tools, and "can this person do my job from day one".

2. STRENGTHS AND GAPS. Which requirements the CV clearly shows (with the evidence), and which are missing or not visible.
   Mark each gap "Must-have" or "Nice-to-have", and say whether it is likely a real gap or just not written down.

3. THE VIRTUAL HIRING PANEL. Four people discuss the candidate: the hiring manager, HR / talent acquisition, the hiring manager's boss,
   and a future teammate. Use the interviewer profiles provided where they match a role (e.g. the hiring manager's LinkedIn);
   otherwise infer a realistic persona for that seat from the job description, and leave "name" empty.
   Each gives the pros and cons of this candidate from their own seat (the boss thinks about strategy, budget and long-term potential;
   the teammate about collaboration, skills they would rely on, and workload) and a verdict.

4. EXPERIENCE QUESTIONS. Ask 4-6 short yes/no questions about experience the job needs that the CV does not show but the candidate
   might well have (e.g. "Have you ever presented findings to senior executives?"). Each must target a gap that matters.

5. THE TAILORED CV. ${rules}

${cvFormat}

Reply with JSON only, no other text, in exactly this shape:
{
  "match": { "score": 0-100, "verdict": "one sentence" },
  "ten_second": {
    "hr":              { "sees": "what they take in, in one or two sentences", "decision": "Shortlist | Maybe | Reject", "fixes": [ "" ] },
    "hiring_manager":  { "sees": "", "decision": "Shortlist | Maybe | Reject", "fixes": [ "" ] }
  },
  "strengths": [ { "skill": "", "evidence": "" } ],
  "missing":   [ { "skill": "", "importance": "Must-have | Nice-to-have", "likely": "Real gap | Not written down", "suggestion": "" } ],
  "keywords":  { "present": [ "" ], "missing": [ "" ] },
  "panel": [ { "seat": "Hiring manager | HR / Talent acquisition | Hiring manager's boss | Future teammate", "name": "",
               "pros": [ "" ], "cons": [ "" ], "verdict": "Strong yes | Yes | Maybe | No", "comment": "one sentence in their voice" } ],
  "questions": [ { "skill": "", "question": "", "why": "" } ],
  "tailored_cv": "",
  "changes": [ { "change": "", "why": "" } ]
}
Give 3-6 strengths, 2-6 missing items, up to 10 keywords each, exactly 4 panel members, 2-3 fixes per reader, 2-3 pros and cons each,
and up to 8 changes. Keep every text value short.`;
}

function questionsPrompt(b){
  const cats = 'Motivation & fit, Behavioural, Role-specific, Situational, Culture & values, Curveball';
  return `${COACH}

Write ${b.count} realistic mock interview questions for this interview, with a strong model answer to each.
Mix the categories (${cats}) to suit the role and the interview stage. Role-specific questions must test the actual skills in the job description
(technical, clinical, commercial, creative, practical - whatever the role needs). Where interviewer profiles are given, attribute some questions to the
interviewer most likely to ask them and reflect that person's background.
${b.focus ? `The candidate especially wants practice on: ${b.focus}\n` : ''}${b.avoid && b.avoid.length ? `Do not repeat these questions: ${b.avoid.join(' | ')}\n` : ''}
${context(b)}

---

Model answers are written in the first person as the candidate, built from real experience in the CV, use the STAR structure for behavioural and
situational questions, and take about a minute to say aloud (120-180 words). Use [placeholders] rather than inventing facts.

Reply with JSON only, no other text, in exactly this shape:
{ "questions": [ {
  "category": "one of: ${cats}",
  "asked_by": "interviewer name, or empty",
  "difficulty": "Easy | Medium | Hard",
  "question": "",
  "why_asked": "what the interviewer is really testing",
  "what_good_looks_like": "",
  "model_answer": "",
  "tips": [ "short do/don't tips" ]
} ] }`;
}

function ratePrompt(b){
  const m = b.metrics || {};
  const audio = !!b.audio;
  return `${COACH}

You are now rating one answer from a mock interview.

ROLE: ${b.role || 'not specified'}
QUESTION: ${b.question}
${b.what_good ? `WHAT A GOOD ANSWER COVERS: ${b.what_good}\n` : ''}${b.cv ? `CANDIDATE CV (for checking relevance):\n${b.cv}\n` : ''}
${audio ? 'The candidate\'s spoken answer is attached as audio.' : 'The candidate typed this answer (no audio).'}
${b.transcript ? `${audio ? 'Browser transcript (may contain recognition errors; trust the audio)' : 'Answer'}:\n${b.transcript}` : 'No transcript is available; transcribe the audio yourself.'}

Delivery measurements taken by the app:
- length: ${m.duration_s != null ? m.duration_s + ' s' : 'unknown'}
- words: ${m.words != null ? m.words : 'unknown'}, speaking rate: ${m.wpm != null ? m.wpm + ' words/min' : 'unknown'} (comfortable is roughly 120-160)
- filler words: ${m.fillers != null ? m.fillers : 'unknown'}${m.filler_list ? ' (' + m.filler_list + ')' : ''}
- pauses over 2 s: ${m.long_pauses != null ? m.long_pauses : 'unknown'}, longest: ${m.longest_pause_s != null ? m.longest_pause_s + ' s' : 'unknown'}

Score each dimension from 1 to 10, where 5 is an average real candidate and 8+ would impress most interviewers:
- content: relevant, specific, answers the question actually asked, evidence and results, fit to the role
- structure: clear beginning, middle and end; STAR where appropriate; sensible length
- confidence: ${audio ? 'from the voice: steadiness, volume, pace, hesitation, conviction, and assertive wording' : 'from the wording only: assertive, owns the achievements, avoids hedging (say that audio was not available)'}
- communication: clarity, concision, vocabulary suited to the audience, fillers, pace, engaging delivery
Overall is your holistic judgement, not just the average.

Reply with JSON only, no other text, in exactly this shape:
{
  "transcript": "${b.transcript ? 'the transcript, corrected from the audio where needed' : 'what the candidate said'}",
  "scores": { "content": 0, "structure": 0, "confidence": 0, "communication": 0, "overall": 0 },
  "summary": "two sentences a coach would say first",
  "feedback": { "content": "", "structure": "", "confidence": "", "communication": "" },
  "strengths": [ "" ],
  "improvements": [ "specific, actionable" ],
  "better_answer": "the candidate's own answer rewritten to score 9+, keeping their real facts and [placeholders] for missing ones"
}`;
}

/* ---------- request validation ---------- */

function readBody(body){
  const kind = body && body.kind;
  if (!MODELS[kind]) return null;
  if (kind === 'rate') {
    const b = {
      kind,
      question: str(body.question, 2000),
      what_good: str(body.what_good, 2000),
      role: str(body.role, 300),
      cv: str(body.cv, MAX_FIELD),
      transcript: str(body.transcript, 12000),
      audio: typeof body.audio === 'string' ? body.audio : '',
      metrics: body.metrics && typeof body.metrics === 'object' ? body.metrics : {}
    };
    if (!b.question || (!b.transcript && !b.audio)) return null;
    if (b.audio.length > MAX_AUDIO) return 'too_large';
    return b;
  }
  const b = {
    kind,
    jd: str(body.jd, MAX_FIELD),
    cv: str(body.cv, MAX_FIELD),
    stage: str(body.stage, 200),
    notes: str(body.notes, 4000),
    mode: body.mode === 'update' ? 'update' : 'full',
    current_cv: str(body.current_cv, MAX_FIELD),
    answers: (Array.isArray(body.answers) ? body.answers : []).slice(0, 30).map(a => ({
      question: str(a && a.question, 300), answer: str(a && a.answer, 1000) })).filter(a => a.question && a.answer),
    focus: str(body.focus, 500),
    count: Math.max(3, Math.min(20, parseInt(body.count, 10) || 6)),
    avoid: Array.isArray(body.avoid) ? body.avoid.slice(0, 60).map(q => str(q, 300)).filter(Boolean) : [],
    interviewers: (Array.isArray(body.interviewers) ? body.interviewers : []).slice(0, MAX_INTERVIEWERS).map(p => ({
      name: str(p && p.name, 120), title: str(p && p.title, 200), profile: str(p && p.profile, MAX_PROFILE)
    })).filter(p => p.name || p.profile)
  };
  if (!b.jd) return null;
  if (kind === 'cv' && (!b.cv || (b.mode === 'update' && !b.current_cv))) return null;
  return b;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ok = allowedOrigins(env).includes(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    if (!ok) return reply(403, { error: 'origin_not_allowed' });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, origin);
    if (!env.OPENROUTER_API_KEY_HIREPILOT) return reply(500, { error: 'not_configured' }, origin);

    // optional per-visitor limit, if a rate-limit binding named LIMITER is attached
    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return reply(429, { error: 'rate_limited' }, origin);
    }

    let raw;
    try { raw = await request.json(); } catch (e) { return reply(400, { error: 'bad_request' }, origin); }
    const b = readBody(raw);
    if (b === 'too_large') return reply(413, { error: 'too_large' }, origin);
    if (!b) return reply(400, { error: 'bad_request' }, origin);

    const prompt = b.kind === 'cv' ? cvPrompt(b) : b.kind === 'plan' ? planPrompt(b) : b.kind === 'questions' ? questionsPrompt(b) : ratePrompt(b);
    const content = b.audio
      ? [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: b.audio, format: 'wav' } }]
      : prompt;
    const payload = {
      model: MODELS[b.kind],
      messages: [{ role: 'user', content }],
      max_tokens: b.kind === 'questions' || b.kind === 'cv' ? 12000 : b.kind === 'plan' ? 6000 : 3000,
      temperature: b.kind === 'rate' ? 0.2 : 0.5
    };
    if (b.kind === 'rate') payload.reasoning = { effort: 'low' };

    let res;
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY_HIREPILOT,
          'Content-Type': 'application/json',
          'HTTP-Referer': SITE + '/HirePilot/',
          'X-Title': 'HirePilot'
        },
        body: JSON.stringify(payload)
      });
    } catch (e) { return reply(502, { error: 'upstream_unreachable' }, origin); }

    if (res.status === 429) return reply(429, { error: 'rate_limited' }, origin);
    if (res.status === 402) return reply(402, { error: 'out_of_credit' }, origin);
    if (!res.ok) return reply(502, { error: 'upstream_error', status: res.status }, origin);

    const out = await res.json().catch(() => null);
    const text = out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
    if (!text) return reply(502, { error: 'empty_completion' }, origin);
    const data = parseJson(text);
    if (!data) return reply(502, { error: 'invalid_json' }, origin);
    return reply(200, { data }, origin);
  }
};
