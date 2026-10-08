// A title and a one- or two-sentence description drafted from the transcript, for the owner to
// edit. Providers: Workers AI (production), OpenAI (OPENAI_API_KEY, local), a fake (tests).

const WORKERS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export function describeProvider(env) {
  if (env.TRANSCRIBE_FAKE) return 'fake';
  if (env.AI) return 'workers-ai';
  if (env.OPENAI_API_KEY) return 'openai';
  return null;
}

// Head and tail of a long transcript; the middle matters least for a summary.
export function transcriptText(words, max = 6000) {
  const text = words.map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max * 0.7)} … ${text.slice(-max * 0.3)}`;
}

function prompt(owner, text) {
  return `Here is the transcript of a short screen recording ${owner ? `by ${owner} ` : ''}that he is about to send someone as a link.

Write, as he would himself (first person, plain and specific, no hype, never "In this video"):
- "title": at most 8 words, no quotes, no date
- "description": one or two sentences, at most 220 characters, saying what the recording shows or asks

Reply with JSON only: {"title": "...", "description": "..."}

Transcript:
${text}`;
}

// → { title, description } (either may be ''), or throws.
export async function draftDescription(env, words) {
  const p = describeProvider(env);
  if (!p) throw new Error('No description provider');
  const text = transcriptText(words);
  if (p === 'fake') return { title: 'Quick Shuttle test', description: `A short test recording: ${text.split(' ').slice(0, 8).join(' ')}…`.slice(0, 220) };
  const msg = prompt(env.OWNER_NAME || '', text);
  let raw;
  if (p === 'workers-ai') {
    const out = await env.AI.run(WORKERS_MODEL, { messages: [{ role: 'user', content: msg }], max_tokens: 300, temperature: 0.3 });
    raw = out && (typeof out.response === 'string' ? out.response : JSON.stringify(out.response || ''));
  } else {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.DESCRIBE_MODEL || 'gpt-4o-mini', temperature: 0.3, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: msg }] }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    raw = (await r.json()).choices?.[0]?.message?.content;
  }
  return parseDraft(raw);
}

export function parseDraft(raw) {
  const s = String(raw || '');
  const m = s.match(/\{[\s\S]*\}/);
  let o = {};
  try { o = JSON.parse(m ? m[0] : s); } catch {}
  const clean = (x, n) => String(x || '').replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim().slice(0, n);
  return { title: clean(o.title, 80), description: clean(o.description, 300) };
}
