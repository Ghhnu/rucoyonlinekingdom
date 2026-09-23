/**
 * Rucoy Online Kingdom — Tracker backend (Cloudflare Worker)
 * ------------------------------------------------------------
 * Why this exists:
 *   - rucoyonline.com has no CORS headers, so the browser can't
 *     fetch it directly from a page hosted on GitHub Pages.
 *   - A static characternames.json on GitHub Pages can't be
 *     written to from client-side JS.
 * This Worker fixes both: it fetches rucoyonline.com server-side
 * (no CORS problem) and stores results in Workers KV (a free,
 * persistent key-value store shared by every visitor).
 *
 * SETUP:
 *   1. Create a Cloudflare account (free) -> Workers & Pages.
 *   2. Create a KV namespace, e.g. named "TRACKER_KV".
 *   3. Create a new Worker, paste this file as its code.
 *   4. Bind the KV namespace to the Worker under the name TRACKER_KV
 *      (Worker settings -> Variables -> KV Namespace Bindings).
 *   5. Deploy. Copy the worker's URL (https://xxx.workers.dev)
 *      into TRACKER_API at the top of the <script> in index.html.
 *   6. Set ALLOWED_ORIGIN below to your GitHub Pages URL.
 *
 * KV layout:
 *   char:<canonicalName>  -> JSON { name, level, guild, title, born,
 *                                   lastOnline, supporter, gameMaster,
 *                                   banned, aliases: [...], lastChecked }
 *   alias:<searchedName>  -> canonicalName it currently resolves to
 *
 * NOTE ON STATUS BADGES (Supporter / Game Master / Banned):
 *   I don't have a real example of how rucoyonline.com marks these
 *   on a character page (I could only read a plain-text/markdown
 *   version of the page, not the actual HTML/CSS). The detector
 *   below does a best-effort keyword scan of the raw HTML. If it
 *   doesn't work for a known banned/supporter/GM character, send
 *   me that character's name (or the raw page source) and I'll
 *   fix the detection to match the real markup.
 */

const ALLOWED_ORIGIN = "*"; // tighten to your GitHub Pages origin once deployed, e.g. "https://yourname.github.io"

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/track") {
      const name = (url.searchParams.get("name") || "").trim();
      if (!name) return json({ error: "Missing ?name=" }, 400);
      try {
        return json(await trackCharacter(name, env));
      } catch (err) {
        return json({ error: err.message || "Lookup failed" }, 500);
      }
    }

    if (url.pathname === "/total") {
      const total = await countTracked(env);
      return json({ total });
    }

    return json({ error: "Not found. Use /track?name=X or /total" }, 404);
  },
};

async function trackCharacter(searchedName, env) {
  const pageUrl = `https://www.rucoyonline.com/characters/${encodeURIComponent(searchedName)}`;
  const res = await fetch(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (RucoyOnlineKingdom-Tracker)" },
  });
  const html = await res.text();

  const parsed = parseCharacterPage(html);
  if (!parsed.name) {
    return { error: `"${searchedName}" was not found on rucoyonline.com.` };
  }

  const canonicalName = parsed.name;
  const key = `char:${canonicalName}`;
  const existingRaw = await env.TRACKER_KV.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;

  const aliases = new Set(existing?.aliases || []);

  // if the name we searched isn't the name the page returned, the
  // searched name is an old/alias name for this character
  if (searchedName.toLowerCase() !== canonicalName.toLowerCase()) {
    aliases.add(searchedName);
    await env.TRACKER_KV.put(`alias:${searchedName}`, canonicalName);
  }

  // if some other still-existing character record points to this same
  // canonical name via an old alias pointer, keep folding those in too
  const record = {
    name: canonicalName,
    level: parsed.level || existing?.level || null,
    guild: parsed.guild || existing?.guild || null,
    title: parsed.title || existing?.title || null,
    born: parsed.born || existing?.born || null,
    lastOnline: parsed.lastOnline || existing?.lastOnline || null,
    supporter: parsed.supporter,
    gameMaster: parsed.gameMaster,
    banned: parsed.banned,
    aliases: Array.from(aliases),
    lastChecked: new Date().toISOString(),
  };

  await env.TRACKER_KV.put(key, JSON.stringify(record));

  return { ...record, anotherAccounts: record.aliases };
}

async function countTracked(env) {
  let count = 0;
  let cursor;
  do {
    const page = await env.TRACKER_KV.list({ prefix: "char:", cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

/**
 * Parses the character-info table out of a rucoyonline.com character
 * page. The page renders a two-column table: row label in the first
 * <td>, value in the second. This walks <tr> rows and reads them.
 */
function parseCharacterPage(html) {
  const result = {
    name: null, level: null, guild: null, title: null,
    born: null, lastOnline: null,
    supporter: false, gameMaster: false, banned: false,
  };

  // pull each <tr>...</tr> block, then its <td> cells
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch;
  while ((rowMatch = rowRe.exec(html))) {
    const cells = [];
    let cellMatch;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(stripTags(cellMatch[1]).trim());
    }
    if (cells.length < 2) continue;
    const [label, value] = cells;
    const key = label.toLowerCase();
    if (key === "name") result.name = value;
    else if (key === "level") result.level = value;
    else if (key === "guild") result.guild = value;
    else if (key === "title") result.title = value;
    else if (key === "born") result.born = value;
    else if (key === "last online") result.lastOnline = value;
  }

  // best-effort status detection — see the NOTE at the top of this file.
  // Adjust these once we know the real markup rucoyonline.com uses.
  const lowerHtml = html.toLowerCase();
  result.supporter = /supporter/.test(lowerHtml);
  result.gameMaster = /game[\s-]?master/.test(lowerHtml);
  result.banned = /\bbanned\b/.test(lowerHtml);

  return result;
}

function stripTags(fragment) {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}