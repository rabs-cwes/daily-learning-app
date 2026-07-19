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

  const { action, subject, context } = payload;

  try {
    if (action === "questions") {
      if (!subject) return { statusCode: 400, body: JSON.stringify({ error: "Missing subject" }) };
      const today = new Date().toDateString();
      const contextLine = context
        ? "The specific portion being studied today is: " + context + ". Base the questions on the actual, factual content of that specific portion, drawing on your own knowledge of the text."
        : "You aren't told the exact passage studied today, so base the questions on well-established, factual content that is characteristic of " + subject + " in general (real laws, verses, stories, or teachings from that text/corpus) rather than the literal day's page.";
      const text = await callClaude(apiKey, [
        {
          role: "user",
          content:
            "You are building a comprehension quiz for someone finishing today's (" + today + ") study of " + subject + ". " +
            contextLine + " " +
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
      return json200({ questions: extractQuestionObjects(text) });
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message || "AI request failed" }) };
  }
};

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
