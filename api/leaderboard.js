const LEADERBOARD_KEY = "nzp:leaderboard:v1";
const LEADERBOARD_MAX = 5;

function sanitizeText(value, maxLen, fallback) {
  const raw = (value == null ? "" : String(value))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  if (!raw) return fallback;
  return raw.slice(0, maxLen);
}

function sanitizeLevel(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(255, n));
}

function sanitizeTs(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return Math.floor(Date.now() / 1000);
  }
  return n;
}

function normalizeEntry(input) {
  return {
    name: sanitizeText(input?.name, 24, "Unknown Soldier"),
    map: sanitizeText(input?.map, 48, "Unknown Map"),
    level: sanitizeLevel(input?.level),
    ts: sanitizeTs(input?.ts)
  };
}

function rankTop(entries) {
  return entries
    .map(normalizeEntry)
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return b.ts - a.ts;
    })
    .slice(0, LEADERBOARD_MAX);
}

function getKvConfig() {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");
  }
  return { baseUrl, token };
}

async function kvCommand(parts) {
  const { baseUrl, token } = getKvConfig();
  const path = parts.map((part) => encodeURIComponent(String(part))).join("/");
  const response = await fetch(`${baseUrl}/${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`KV command failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function kvLoadEntries() {
  const payload = await kvCommand(["get", LEADERBOARD_KEY]);
  if (!payload || payload.result == null) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload.result);
    if (!Array.isArray(parsed)) return [];
    return rankTop(parsed);
  } catch (_err) {
    return [];
  }
}

async function kvSaveEntries(entries) {
  await kvCommand(["set", LEADERBOARD_KEY, JSON.stringify(entries)]);
}

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (_err) {
      return {};
    }
  }
  if (typeof req.body === "object") return req.body;
  return {};
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "GET") {
      const limitValue = Number.parseInt(req.query?.limit, 10);
      const limit = Number.isFinite(limitValue)
        ? Math.max(1, Math.min(LEADERBOARD_MAX, limitValue))
        : LEADERBOARD_MAX;

      const entries = await kvLoadEntries();
      res.status(200).json({ ok: true, entries: entries.slice(0, limit) });
      return;
    }

    if (req.method === "POST") {
      const input = parseBody(req);
      const entry = normalizeEntry({
        name: input.name,
        map: input.map,
        level: input.level,
        ts: Math.floor(Date.now() / 1000)
      });

      const existing = await kvLoadEntries();
      const nextEntries = rankTop([entry, ...existing]);
      await kvSaveEntries(nextEntries);

      res.status(200).json({ ok: true, entries: nextEntries });
      return;
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).json({ ok: false, error: "method_not_allowed" });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "leaderboard_unavailable",
      detail: err && err.message ? err.message : "unknown_error"
    });
  }
};
