// Netlify serverless function: generates and grades comprehension-check
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

  const { action, subject, question, answer } = payload;

  try {
    if (action === "question") {
      if (!subject) return { statusCode: 400, body: JSON.stringify({ error: "Missing subject" }) };
      const today = new Date().toDateString();
      const text = await callClaude(apiKey, [
        {
          role: "user",
          content:
            "You are a warm, encouraging Torah study companion helping someone check their own understanding. " +
            "Write ONE short comprehension question (at most two sentences) about today's (" + today + ") " +
            "daily portion of " + subject + ", as commonly studied via the Chabad.org / Sefaria daily study cycle. " +
            "You don't know the exact text, so keep the question general enough to fit a typical day's portion, " +
            "but ask about a concept, lesson, or detail rather than a yes/no question. " +
            "Return ONLY the question itself, with no preamble, quotation marks, or label."
        }
      ]);
      return json200({ question: text.trim() });
    }

    if (action === "feedback") {
      if (!question || !answer) return { statusCode: 400, body: JSON.stringify({ error: "Missing question or answer" }) };
      const text = await callClaude(apiKey, [
        {
          role: "user",
          content:
            "You are a warm, encouraging Torah study companion. The student was asked:\n\"" + question + "\"\n" +
            "They answered:\n\"" + answer + "\"\n\n" +
            "In 2-3 short, warm sentences: affirm what they understood well, and if something seems thin or off, " +
            "gently note what's worth revisiting. Do not be clinical or use a letter grade."
        }
      ]);
      return json200({ feedback: text.trim() });
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
      max_tokens: 300,
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
