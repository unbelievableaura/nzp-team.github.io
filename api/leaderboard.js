const { sql } = require("@vercel/postgres");
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

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS nzp_leaderboard_entries (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(24) NOT NULL,
      map VARCHAR(48) NOT NULL,
      level INTEGER NOT NULL,
      ts BIGINT NOT NULL
    )
  `;
}

async function dbGetTopEntries(limit) {
  const safeLimit = Math.max(1, Math.min(LEADERBOARD_MAX, limit));
  const result = await sql`
    SELECT name, map, level, ts
    FROM nzp_leaderboard_entries
    ORDER BY level DESC, ts DESC
    LIMIT ${safeLimit}
  `;

  return rankTop(result.rows || []);
}

async function dbInsertEntry(entry) {
  await sql`
    INSERT INTO nzp_leaderboard_entries (name, map, level, ts)
    VALUES (${entry.name}, ${entry.map}, ${entry.level}, ${entry.ts})
  `;

  // Keep table bounded without affecting ranking behavior.
  await sql`
    DELETE FROM nzp_leaderboard_entries
    WHERE id NOT IN (
      SELECT id
      FROM nzp_leaderboard_entries
      ORDER BY level DESC, ts DESC
      LIMIT 500
    )
  `;
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
    if (!process.env.POSTGRES_URL) {
      throw new Error("Missing POSTGRES_URL");
    }

    await ensureSchema();

    if (req.method === "GET") {
      const limitValue = Number.parseInt(req.query?.limit, 10);
      const limit = Number.isFinite(limitValue)
        ? Math.max(1, Math.min(LEADERBOARD_MAX, limitValue))
        : LEADERBOARD_MAX;

      const entries = await dbGetTopEntries(limit);
      res.status(200).json({ ok: true, entries });
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

      await dbInsertEntry(entry);
      const nextEntries = await dbGetTopEntries(LEADERBOARD_MAX);

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
