const express = require("express");

const app = express();
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}
if (!ASSISTANT_ID) {
  console.error("Missing ASSISTANT_ID");
  process.exit(1);
}

const OPENAI_BASE = "https://api.openai.com/v1";

function openAIHeaders({ beta = false, json = true } = {}) {
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };
  if (json) headers["Content-Type"] = "application/json";
  if (beta) headers["OpenAI-Beta"] = "assistants=v2";
  return headers;
}

async function openAI(path, { method = "GET", body, beta = false } = {}) {
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    method,
    headers: openAIHeaders({ beta, json: body !== undefined }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.error?.message || `OpenAI request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function createThread() {
  return openAI("/threads", { method: "POST", body: {}, beta: true });
}

async function addUserMessage(threadId, text) {
  return openAI(`/threads/${threadId}/messages`, {
    method: "POST",
    beta: true,
    body: {
      role: "user",
      content: [{ type: "text", text }],
    },
  });
}

async function createRun(threadId) {
  return openAI(`/threads/${threadId}/runs`, {
    method: "POST",
    beta: true,
    body: { assistant_id: ASSISTANT_ID },
  });
}

async function getRun(threadId, runId) {
  return openAI(`/threads/${threadId}/runs/${runId}`, { method: "GET", beta: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRunComplete(threadId, runId) {
  for (let i = 0; i < 40; i++) {
    const run = await getRun(threadId, runId);
    if (run.status === "completed") return run;
    if (["failed", "cancelled", "expired"].includes(run.status)) {
      throw new Error(run.last_error?.message || `Run ${run.status}`);
    }
    await sleep(400);
  }
  throw new Error("Timed out waiting for assistant response");
}

async function listMessages(threadId, limit = 20) {
  return openAI(`/threads/${threadId}/messages?limit=${limit}`, { method: "GET", beta: true });
}

function extractLatestAssistantText(messagesList) {
  const data = Array.isArray(messagesList?.data) ? messagesList.data : [];
  const assistantMsg = data.find((m) => m.role === "assistant");
  if (!assistantMsg) return null;

  const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
  const textBlock = blocks.find((b) => b.type === "text" && b.text?.value);
  return textBlock?.text?.value ?? null;
}

// --- Routes ---

app.post("/chat/start", async (req, res) => {
  try {
    const thread = await createThread();
    res.json({ threadId: thread.id });
  } catch (e) {
    res.status(500).json({ error: e.message, details: e.data });
  }
});

app.post("/chat/send", async (req, res) => {
  const { threadId, message } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'message' string" });
  }

  try {
    const tid = threadId && typeof threadId === "string" ? threadId : (await createThread()).id;

    await addUserMessage(tid, message);
    const run = await createRun(tid);
    await waitForRunComplete(tid, run.id);

    const msgs = await listMessages(tid, 20);
    const reply = extractLatestAssistantText(msgs);

    res.json({ threadId: tid, reply: reply || "" });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
