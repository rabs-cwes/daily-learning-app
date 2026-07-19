// Netlify serverless function: generates multiple-choice comprehension-check
// questions using the Claude API. The API key lives only in the Netlify
// environment variable ANTHROPIC_API_KEY -- it is never sent to the browser.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify's environment variables." })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { action, subject, context, sefariaRef, resolveCalendar } = payload;

  try {
    if (action === "questions") {
      if (!subject) return { statusCode: 400, body: JSON.stringify({ error: "Missing subject" }) };
      const today = new Date().toDateString();

      let material = null;
      let refUsed = null;
      try {
        let ref = sefariaRef || null;
        if (!ref && resolveCalendar) ref = await resolveCalendarRef(resolveCalendar);
        if (ref) {
          material = await fetchSefariaText(ref);
          if (material) refUsed = material.ref;
        }
      } catch (e) {
        material = null; // fall back to the general-knowledge prompt below
      }

      let contentLine;
      if (material) {
        contentLine =
          "Here is the ACTUAL text studied today (" + refUsed + ")" +
          (material.isHebrew ? ", given in Hebrew -- read it directly and write the quiz in English" : "") +
          ":\n\n\"\"\"\n" + material.text + "\n\"\"\"\n\n" +
          "Base every question strictly on facts, details, names, numbers, or ideas that literally appear in this passage. " +
          "Do not ask about anything outside it, and do not use outside/general knowledge to fill gaps.";
      } else {
        contentLine = context
          ? "The specific portion being studied today is: " + context + ". Base the questions on the actual, factual content of that specific portion, drawing on your own knowledge of the text."
          : "You aren't told the exact passage studied today, so base the questions on well-established, factual content that is characteristic of " + subject + " in general (real laws, verses, stories, or teachings from that text/corpus) rather than the literal day's page.";
      }

      const text = await callClaude(apiKey, [
        {
          role: "user",
          content:
            "You are building a comprehension quiz for someone finishing today's (" + today + ") study of " + subject + ". " +
            contentLine + " " +
            "Write exactly 5 multiple-choice questions that test factual recall or understanding of the actual material " +
            "(specific facts, definitions, halachot, narrative details, names, numbers, or ideas that are objectively true or false) " +
            "-- never a question of personal opinion, preference, or open-ended reflection. Every question must have exactly one " +
            "objectively correct answer among the 4 options. Vary the angle across the 5 questions (a core fact, a specific detail, " +
            "a definition or term, a practical application, a common point of confusion). Make incorrect options plausible, not silly. " +
            "\n\nReturn ONLY a JSON array of exactly 5 objects, no markdown formatting, code fences, or commentary, in this exact shape: " +
            '[{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "one short sentence on why that answer is correct"}]. ' +
            "correctIndex is the 0-based index into options of the single correct answer."
        }
      ]);
      return json200({ questions: extractQuestionObjects(text), groundedIn: refUsed });
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message || "AI request failed" }) };
  }
};

const SEFARIA_TEXT_API = "https://www.sefaria.org/api/texts/";
const SEFARIA_CALENDARS_API = "https://www.sefaria.org/api/calendars";
const MAX_CONTEXT_CHARS = 6000;

// Resolves a Sefaria ref for a "kind" of item that follows a Sefaria-published
// daily/weekly cycle but wasn't given an explicit ref by the frontend.
async function resolveCalendarRef(kind) {
  const res = await fetch(SEFARIA_CALENDARS_API);
  if (!res.ok) return null;
  const data = await res.json();
  const items = data.calendar_items || [];
  const match = items.find((it) => {
    const t = ((it.title && it.title.en) || "").toLowerCase();
    if (kind === "rambam") return t.indexOf("rambam") >= 0 && t.indexOf("3") >= 0;
    return t.indexOf("parashat hashavua") >= 0;
  });
  return match ? match.url : null;
}

function flattenSefariaText(node) {
  if (Array.isArray(node)) return node.map(flattenSefariaText).join(" ");
  if (typeof node === "string") return node.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}

async function fetchSefariaText(ref) {
  const url = SEFARIA_TEXT_API + encodeURI(ref) + "?context=0&commentary=0";
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const en = flattenSefariaText(data.text || []).trim();
  const he = flattenSefariaText(data.he || []).trim();
  if (en) return { text: en.slice(0, MAX_CONTEXT_CHARS), isHebrew: false, ref: data.ref || ref };
  if (he) return { text: he.slice(0, MAX_CONTEXT_CHARS), isHebrew: true, ref: data.ref || ref };
  return null;
}

async function callClaude(apiKey, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error("Claude API error " + res.status + ": " + errText);
  }

  const data = await res.json();
  const block = data.content && data.content[0];
  return (block && block.text) || "";
}

function json200(obj) {
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}

function extractQuestionObjects(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      const qs = parsed.filter(isValidMcQuestion);
      if (qs.length) return qs.slice(0, 5);
    }
  } catch (e) {
    // malformed JSON from the model -- nothing usable to recover here,
    // the frontend falls back to its own offline placeholder questions
  }
  return [];
}

function isValidMcQuestion(q) {
  return (
    q &&
    typeof q.question === "string" &&
    q.question.trim() &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every((o) => typeof o === "string" && o.trim()) &&
    typeof q.correctIndex === "number" &&
    q.correctIndex >= 0 &&
    q.correctIndex <= 3
  );
}
