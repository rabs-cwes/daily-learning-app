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

  const { action, subject, context, sefariaRef, resolveCalendar, citationStyle, includeRashi, calYear, calMonth, calDay } = payload;

  try {
    if (action === "questions") {
      if (!subject) return { statusCode: 400, body: JSON.stringify({ error: "Missing subject" }) };
      const today = new Date().toDateString();

      let ref = sefariaRef || null;
      try {
        if (!ref && resolveCalendar) ref = await resolveCalendarRef(resolveCalendar, calYear, calMonth, calDay);
      } catch (e) {
        ref = null;
      }

      // Rambam's daily reading is 3 separate chapters. A single request asking
      // the model to spread questions across all 3 is unreliable in practice --
      // it tends to cluster on the first chapter. Instead, split into one
      // request per chapter so each one physically can't see the others.
      if (ref && resolveCalendar === "rambam") {
        const range = parseChapterRange(ref);
        if (range && range.to > range.from) {
          const chapters = [];
          for (let c = range.from; c <= range.to; c++) chapters.push(c);
          const counts = distributeCount(5, chapters.length);

          const results = await Promise.all(
            chapters.map(async (chapterNum, i) => {
              const chapterRef = range.bookPrefix + "." + chapterNum;
              const material = await fetchSefariaText(chapterRef, {});
              if (!material || counts[i] === 0) return [];
              return generateQuestions(apiKey, subject, today, material, "rambam", counts[i]);
            })
          );

          const allQuestions = [].concat(...results).slice(0, 5);
          const dayLink = "https://www.sefaria.org/" + encodeURI(ref);
          return json200({ questions: allQuestions, groundedIn: "Rambam perek " + chapters.join(", "), dayLink });
        }
      }

      let material = null;
      let refUsed = null;
      let dayLink = null;
      try {
        if (ref) {
          dayLink = "https://www.sefaria.org/" + encodeURI(ref);
          material = await fetchSefariaText(ref, { includeRashi: !!includeRashi });
          if (material) refUsed = material.ref;
        }
      } catch (e) {
        material = null; // fall back to the general-knowledge prompt below
      }

      const questions = await generateQuestions(apiKey, subject, today, material, citationStyle, 5, context);
      return json200({ questions, groundedIn: refUsed, dayLink });
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message || "AI request failed" }) };
  }
};

// Splits total questions as evenly as possible across n buckets, front-loaded
// (e.g. distributeCount(5, 3) -> [2, 2, 1]).
function distributeCount(total, n) {
  const base = Math.floor(total / n);
  let extra = total % n;
  const counts = [];
  for (let i = 0; i < n; i++) {
    counts.push(base + (extra > 0 ? 1 : 0));
    if (extra > 0) extra--;
  }
  return counts;
}

// Parses a Sefaria ref like "Mishneh_Torah,_X.6-8" into { bookPrefix, from, to }.
function parseChapterRange(ref) {
  const m = ref.match(/^(.*)\.(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const from = parseInt(m[2], 10);
  const to = m[3] ? parseInt(m[3], 10) : from;
  return { bookPrefix: m[1], from, to };
}

async function generateQuestions(apiKey, subject, today, material, citationStyle, count, context) {
  let contentLine;
  let requestLocationFields = false;
  if (material) {
    requestLocationFields = true;
    contentLine =
      "Here is the ACTUAL text studied today (" + material.ref + ")" +
      (material.isHebrew ? ", given in Hebrew -- read it directly and write the quiz in English" : "") +
      ". Each segment is prefixed with its exact location in brackets, like [3:23] for chapter:verse or chapter:halacha" +
      (material.hasRashi ? ", and Rashi's commentary is included in its own labeled section, also bracket-labeled" : "") +
      ":\n\n\"\"\"\n" + material.text + "\n\"\"\"\n\n" +
      "Base every question strictly on facts, details, names, numbers, or ideas that literally appear in this passage. " +
      "Do not ask about anything outside it, and do not use outside/general knowledge to fill gaps. " +
      citationInstruction(citationStyle) + " " +
      rashiCoverageInstruction(citationStyle, material.hasRashi, count);
  } else {
    contentLine = context
      ? "The specific portion being studied today is: " + context + ". Base the questions on the actual, factual content of that specific portion, drawing on your own knowledge of the text."
      : "You aren't told the exact passage studied today, so base the questions on well-established, factual content that is characteristic of " + subject + " in general (real laws, verses, stories, or teachings from that text/corpus) rather than the literal day's page.";
  }

  const schemaLine = requestLocationFields
    ? '[{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "one short sentence explaining why that answer is correct", "sourceLocation": "3:26", "isRashi": false}]. ' +
      "\"sourceLocation\" is the exact bracketed chapter:verse / chapter:halacha location the correct answer comes from (numbers only, no labels). " +
      "\"isRashi\" is true only if sourceLocation points to a Rashi comment rather than the plain verse."
    : '[{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "one short sentence explaining why that answer is correct"}].';

  const text = await callClaude(apiKey, [
    {
      role: "user",
      content:
        "You are building a comprehension quiz for someone finishing today's (" + today + ") study of " + subject + ". " +
        contentLine + " " +
        "Write exactly " + count + " multiple-choice question" + (count === 1 ? "" : "s") + " that test factual recall or understanding of the actual material " +
        "(specific facts, definitions, halachot, narrative details, names, numbers, or ideas that are objectively true or false) " +
        "-- never a question of personal opinion, preference, or open-ended reflection. Every question must have exactly one " +
        "objectively correct answer among the 4 options. " + (count > 1 ? "Vary the angle across the questions (a core fact, a specific detail, " +
        "a definition or term, a practical application, a common point of confusion). " : "") + "Make incorrect options plausible, not silly. " +
        "Write all Hebrew names and terms (people, places, offerings, halachic terms, etc.) spelled with English letters using " +
        "traditional Ashkenazic Hebrew pronunciation, not full English translations and not Modern/Sephardic transliteration -- " +
        "for example \"Moshe\" not \"Moses\", \"Korban Tomid\" not \"the daily offering\", \"Aharon\" not \"Aaron\", " +
        "\"Shabbos\" not \"Shabbat\", \"Bais Hamikdash\" not \"Temple\" where a Hebrew term fits naturally. " +
        "\n\nReturn ONLY a JSON array of exactly " + count + " object" + (count === 1 ? "" : "s") + ", no markdown formatting, code fences, or commentary, in this exact shape: " +
        schemaLine +
        " correctIndex is the 0-based index into options of the single correct answer."
    }
  ]);

  return extractQuestionObjects(text, count).map((q) => attachSourceUrl(q, material));
}

function citationInstruction(style) {
  if (style === "tanakh") return "For each explanation, cite the precise source as \"Perek X, Posuk Y\" (or \"Rashi on Perek X, Posuk Y\") using the bracketed location markers.";
  if (style === "rambam") return "For each explanation, cite the precise source as \"Perek X, Halacha Y\" using the bracketed location markers.";
  if (style === "kitzur") return "For each explanation, cite the precise source as \"Siman X, Se'if Y\" using the bracketed location markers.";
  return "For each explanation, cite the precise source location using the bracketed location markers (e.g. daf/amud for Gemara).";
}

function rashiCoverageInstruction(style, hasRashi, count) {
  if (style === "tanakh" && hasRashi && count > 1) {
    return "At least " + Math.min(2, count) + " of the " + count + " questions must be based specifically on Rashi's commentary " +
      "(not just the plain verse) -- test understanding of what Rashi explains, adds, or emphasizes beyond the plain text, " +
      "citing him by name in the question or answer as appropriate.";
  }
  return "";
}

// Builds a precise Sefaria URL for a question's cited source, falling back to
// the whole passage's material link when a precise per-question URL can't be built.
function attachSourceUrl(q, material) {
  q.sourceUrl = (material && material.dayLink) || (material ? "https://www.sefaria.org/" + encodeURI(material.ref) : null);
  if (material && material.book && q.sourceLocation && /^\d+:\d+$/.test(q.sourceLocation)) {
    let prefix = material.book.replace(/\s+/g, "_");
    if (q.isRashi) prefix = "Rashi_on_" + prefix;
    const loc = q.sourceLocation.replace(":", ".");
    q.sourceUrl = "https://www.sefaria.org/" + encodeURI(prefix + "." + loc);
  }
  return q;
}

const SEFARIA_TEXT_API = "https://www.sefaria.org/api/texts/";
const SEFARIA_CALENDARS_API = "https://www.sefaria.org/api/calendars";
const MAX_CONTEXT_CHARS = 120000;

// Resolves a Sefaria ref for a "kind" of item that follows a Sefaria-published
// daily/weekly cycle but wasn't given an explicit ref by the frontend.
async function resolveCalendarRef(kind, year, month, day) {
  let url = SEFARIA_CALENDARS_API;
  if (year && month && day) url += "?year=" + year + "&month=" + month + "&day=" + day;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const items = data.calendar_items || [];
  const match = items.find((it) => {
    const t = ((it.title && it.title.en) || "").toLowerCase();
    if (kind === "rambam") return t.indexOf("rambam") >= 0 && t.indexOf("3") >= 0;
    return t.indexOf("parashat hashavua") >= 0;
  });
  if (!match) return null;

  if (kind === "parasha") {
    // Chabad's daily Chumash-with-Rashi cycle covers exactly one aliyah per
    // day (Sunday = 1st aliyah ... Saturday = 7th), not the whole parasha.
    // Use that day's specific aliyah instead of the full weekly range.
    const aliyot = match.extraDetails && match.extraDetails.aliyot;
    if (aliyot && aliyot.length && year && month && day) {
      const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const aliyahRef = aliyot[Math.min(dow, aliyot.length - 1)];
      if (aliyahRef) {
        const technical = humanRefToTechnical(aliyahRef);
        if (technical) return technical;
      }
    }
  }

  return match.url;
}

// Converts a Sefaria human-readable ref ("Deuteronomy 3:23-4:4") into the
// dotted technical ref format the text API expects ("Deuteronomy.3.23-4.4").
function humanRefToTechnical(ref) {
  const m = ref.match(/^(.+?)\s+(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/);
  if (!m) return null;
  const book = m[1].replace(/\s+/g, "_");
  let result = book + "." + m[2] + "." + m[3];
  if (m[5]) result += "-" + (m[4] ? m[4] + "." : "") + m[5];
  return result;
}

function joinDeep(node) {
  if (Array.isArray(node)) return node.map(joinDeep).join(" ");
  if (typeof node === "string") return node.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}

// Flattens Sefaria's (possibly nested, chapter->verse) text array into lines
// labeled with their exact [chapter:verse] (or [chapter:halacha]) location,
// so the model can cite a precise source instead of guessing.
function labelSefariaSegments(data, field) {
  const node = data[field];
  if (!Array.isArray(node) || node.length === 0) return "";
  const startOuter = (data.sections && data.sections[0]) || 1;
  const startInner = (data.sections && data.sections[1]) || 1;
  const lines = [];
  const isNestedOuter = Array.isArray(node[0]);

  if (isNestedOuter) {
    node.forEach((chapterArr, ci) => {
      const chapterNum = startOuter + ci;
      const innerStart = ci === 0 ? startInner : 1;
      chapterArr.forEach((seg, vi) => {
        const t = joinDeep(seg);
        if (t) lines.push("[" + chapterNum + ":" + (innerStart + vi) + "] " + t);
      });
    });
  } else {
    node.forEach((seg, vi) => {
      const t = joinDeep(seg);
      if (t) lines.push("[" + startOuter + ":" + (startInner + vi) + "] " + t);
    });
  }
  return lines.join("\n");
}

async function fetchSefariaTextRaw(ref) {
  const url = SEFARIA_TEXT_API + encodeURI(ref) + "?context=0&commentary=0";
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchSefariaText(ref, opts) {
  opts = opts || {};
  const data = await fetchSefariaTextRaw(ref);
  if (!data) return null;

  const labeledEn = labelSefariaSegments(data, "text");
  const labeledHe = labelSefariaSegments(data, "he");
  let combined = labeledEn || labeledHe;
  if (!combined) return null;
  const isHebrew = !labeledEn && !!labeledHe;

  let hasRashi = false;
  if (opts.includeRashi) {
    try {
      const rashiData = await fetchSefariaTextRaw("Rashi_on_" + ref);
      if (rashiData) {
        const rashiLabeled = labelSefariaSegments(rashiData, "text") || labelSefariaSegments(rashiData, "he");
        if (rashiLabeled) {
          combined += "\n\n--- RASHI'S COMMENTARY ---\n" + rashiLabeled;
          hasRashi = true;
        }
      }
    } catch (e) {
      // Rashi not available for this ref -- proceed with the base text only
    }
  }

  return {
    text: combined.slice(0, MAX_CONTEXT_CHARS),
    isHebrew,
    hasRashi,
    book: data.book,
    ref: data.ref || ref,
    dayLink: "https://www.sefaria.org/" + encodeURI(ref)
  };
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
      max_tokens: 2200,
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

function extractQuestionObjects(text, limit) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      const qs = parsed.filter(isValidMcQuestion);
      if (qs.length) return qs.slice(0, limit || 5);
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
