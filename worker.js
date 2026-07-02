export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: corsHeaders() });
    }

    const target = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("u");
    const referer = reqUrl.searchParams.get("referer") || reqUrl.searchParams.get("ref") || "";

    // TEMPORARY DEBUG ENDPOINT — remove after diagnosing the acqq issue.
    // Visit /?debug=acqq&url=<encoded chapter URL> to see exactly what's
    // happening: whether the regex matches, whether DATA/nonce are found,
    // and the raw decode error if any — without needing eval() or guessing.
    if (reqUrl.searchParams.get("debug") === "acqq" && target) {
      let decodedForDebug = target;
      for (let i = 0; i < 3; i++) {
        try {
          const nd = decodeURIComponent(decodedForDebug);
          if (nd === decodedForDebug) break;
          decodedForDebug = nd;
        } catch { break; }
      }
      let debugInfo = { input_url: decodedForDebug };
      try {
        const u = new URL(decodedForDebug);
        debugInfo.parsed_href = u.href;
        const m = u.href.match(/ac\.qq\.com\/ComicView\/index\/id\/(\d+)\/cid\/(\d+)/);
        debugInfo.regex_matched = !!m;
        if (m) debugInfo.matched_ids = { comicId: m[1], chapterCid: m[2] };

        if (m) {
          const pageHeaders = new Headers();
          pageHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
          pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
          pageHeaders.set("Referer", "https://ac.qq.com/");
          const pageRes = await fetch(u.toString(), { method: "GET", headers: pageHeaders, redirect: "follow" });
          debugInfo.fetch_status = pageRes.status;
          const html = await pageRes.text();
          debugInfo.html_length = html.length;
          debugInfo.has_DATA_var = /var DATA = '/.test(html);
          debugInfo.has_nonce_assignment = /window\[\s*["']n["']\s*\+?\s*["']?once["']?\s*\]\s*=/.test(html) || /window\[\s*["']no["']\s*\+\s*["']nce["']\s*\]\s*=/.test(html);

          if (debugInfo.has_DATA_var && debugInfo.has_nonce_assignment) {
            try {
              const decoded = decodeAcQqChapterData(html);
              debugInfo.decode_success = true;
              debugInfo.total_images = (decoded.picture || []).length;
            } catch (decodeErr) {
              debugInfo.decode_success = false;
              debugInfo.decode_error = decodeErr.message;
              debugInfo.decode_stack = decodeErr.stack;
            }
          }
        }
      } catch (outerErr) {
        debugInfo.outer_error = outerErr.message;
        debugInfo.outer_stack = outerErr.stack;
      }
      return new Response(JSON.stringify(debugInfo, null, 2), {
        status: 200,
        headers: { ...corsHeaders(), "Content-Type": "application/json" }
      });
    }

    if (!target) {
      return new Response("Missing ?url=", { status: 400, headers: corsHeaders() });
    }

    let decodedTarget = target;
    for (let i = 0; i < 3; i++) {
      try {
        const newDecoded = decodeURIComponent(decodedTarget);
        if (newDecoded === decodedTarget) break;
        decodedTarget = newDecoded;
      } catch { break; }
    }

    let targetUrl;
    try {
      targetUrl = new URL(decodedTarget);
    } catch {
      return new Response("Invalid URL: " + decodedTarget.substring(0, 100), { status: 400, headers: corsHeaders() });
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return new Response("Only http/https", { status: 400, headers: corsHeaders() });
    }

    // SSRF protection
    const hostname = targetUrl.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" ||
        /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        hostname.endsWith(".internal") || hostname.endsWith(".local")) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders() });
    }

    // ============================================
    // KUAIKAN MANHUA - Support multiple URL patterns
    // ============================================
    // Both of these are chapter (comic) ids, just different routes/domains:
    // Pattern 1: m.kuaikanmanhua.com/mobile/comics/{id}
    // Pattern 2: www.kuaikanmanhua.com/webs/comic-next/{id}
    // (Confirmed: comic-next/{id} pages show image URLs containing /image/c{id}/,
    //  and og:url resolves to .../web/comic/{id} — so {id} here is the chapter id,
    //  not a series/topic id. The series/topic id appears separately, e.g. /web/topic/{topicId}.)
    const kuaikanMatch = targetUrl.href.match(/kuaikanmanhua\.com\/.*?(\d{5,})/);
    if (kuaikanMatch) {
      const chapterId = kuaikanMatch[1];

      const apiUrl = `https://m.kuaikanmanhua.com/v2/mweb/comic/${chapterId}`;
      const apiHeaders = new Headers();
      apiHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");
      apiHeaders.set("Accept", "application/json, text/plain, */*");
      apiHeaders.set("Referer", "https://m.kuaikanmanhua.com/");
      apiHeaders.set("Origin", "https://m.kuaikanmanhua.com");
      apiHeaders.set("Sec-Fetch-Dest", "empty");
      apiHeaders.set("Sec-Fetch-Mode", "cors");
      apiHeaders.set("Sec-Fetch-Site", "same-origin");
      apiHeaders.set("Sec-Ch-Ua-Mobile", "?1");

      try {
        const apiRes = await fetch(apiUrl, { method: "GET", headers: apiHeaders, redirect: "follow" });
        const apiJson = await apiRes.json();
        const comicInfo = apiJson?.data?.comic_info;
        const topicInfo = apiJson?.data?.topic_info;
        if (!comicInfo) throw new Error("Chapter not found");

        return new Response(JSON.stringify({
          source: "kuaikanmanhua", chapter_id: comicInfo.id, title: comicInfo.title,
          cover: comicInfo.cover_image_url, is_free: comicInfo.is_free, need_vip: comicInfo.need_vip,
          topic: topicInfo ? { id: topicInfo.id, title: topicInfo.title, author: topicInfo.user?.nickname } : null,
          images: comicInfo.images || [],
          comic_images: (comicInfo.comic_images || []).map(img => ({ url: img.url, width: img.width, height: img.height }))
        }, null, 2), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "Kuaikan failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" }});
      }
    }

    // ============================================
    // JJAPTOON - Support multiple domains + try with redirect
    // ============================================
    const jjaptoonMatch = targetUrl.href.match(/^https?:\/\/[^/]*jjaptoon[^/]*\/chapters\/(\d+)/);
    if (jjaptoonMatch) {
      const chapterId = jjaptoonMatch[1];

      // Try the original URL first, if 404 try alternative domains
      const urlsToTry = [
        targetUrl.toString(),
        `https://www.jjaptoon003.com/chapters/${chapterId}`,
        `https://jjaptoon003.com/chapters/${chapterId}`
      ];

      let lastError = null;
      let html = null;
      let successUrl = null;

      for (const url of urlsToTry) {
        try {
          const pageHeaders = new Headers();
          pageHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
          pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
          pageHeaders.set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
          pageHeaders.set("Referer", new URL(url).origin + "/");

          const pageRes = await fetch(url, {
            method: "GET",
            headers: pageHeaders,
            redirect: "follow"
          });

          if (pageRes.ok) {
            html = await pageRes.text();
            successUrl = url;
            break;
          } else {
            lastError = `HTTP ${pageRes.status} for ${url}`;
          }
        } catch (e) {
          lastError = e.message;
        }
      }

      if (!html) {
        return new Response(
          JSON.stringify({ 
            error: "Jjaptoon chapter not found",
            detail: lastError || "All URLs failed",
            tried: urlsToTry
          }),
          { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" }}
        );
      }

      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].trim() : "";

      let comicTitle = "";
      let chapterTitle = "";

      if (pageTitle.includes(" - ")) {
        const parts = pageTitle.split(" - ");
        comicTitle = parts[0].trim();
        chapterTitle = parts[1].trim();
      }

      // jjaptoon serves chapter pages via client-side JS (all <img> tags in the
      // initial HTML have empty src), so scraping <img>/<script> tags doesn't work.
      // Instead we reconstruct the storage folder URL from the page title and
      // probe sequential filenames (001.jpg, 002.jpg, ...) until we hit a 404.
      //
      // Folder pattern (confirmed from live example):
      // https://www.jjaptoon003.com/storage/comics-imported/{comicTitle}/{comicTitle} {N}화/{page}.jpg

      if (!comicTitle || !chapterTitle) {
        return new Response(
          JSON.stringify({
            error: "Could not parse comic/chapter title from page",
            note: "Image folder is built from the page title, which could not be split into comic_title and chapter_title.",
            debug: { chapterId, pageTitle, url: successUrl }
          }),
          { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" }}
        );
      }

      const folderPath = `${comicTitle}/${chapterTitle}`;
      const encodedFolder = folderPath.split("/").map(encodeURIComponent).join("/");
      const baseImageUrl = `https://www.jjaptoon003.com/storage/comics-imported/${encodedFolder}/`;

      const probeHeaders = new Headers();
      probeHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
      probeHeaders.set("Referer", successUrl);

      const comicImages = [];
      const MAX_PAGES = 200; // safety ceiling
      let consecutiveMisses = 0;

      for (let n = 1; n <= MAX_PAGES; n++) {
        const pageNum = String(n).padStart(3, "0");
        const imgUrl = `${baseImageUrl}${pageNum}.jpg`;
        try {
          const headRes = await fetch(imgUrl, { method: "HEAD", headers: probeHeaders, redirect: "follow" });
          if (headRes.ok) {
            comicImages.push({ url: imgUrl, alt: "" });
            consecutiveMisses = 0;
          } else {
            consecutiveMisses++;
            // stop once we've missed twice in a row (handles occasional flaky 404 on a real page)
            if (consecutiveMisses >= 2) break;
          }
        } catch (e) {
          consecutiveMisses++;
          if (consecutiveMisses >= 2) break;
        }
      }

      // Drop a possible trailing false-positive if the very last miss wasn't checked twice
      if (comicImages.length === 0) {
        return new Response(
          JSON.stringify({
            error: "No comic images found at reconstructed storage URL",
            note: "The image folder path is built from the page title. If the site changed its title format or file extension, this pattern needs updating.",
            debug: { chapterId, comicTitle, chapterTitle, triedBaseUrl: baseImageUrl, url: successUrl }
          }),
          { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" }}
        );
      }

      const result = {
        source: "jjaptoon",
        chapter_id: parseInt(chapterId),
        comic_title: comicTitle,
        chapter_title: chapterTitle,
        page_title: pageTitle,
        total_images: comicImages.length,
        images: comicImages.map((img, idx) => ({
          page: idx + 1,
          url: img.url,
          alt: img.alt
        }))
      };

      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json"
        }
      });
    }

    // Shinigami support removed — it blocks Cloudflare Workers requests.

    // ============================================
    // AC.QQ.COM - Free chapters, requires custom deobfuscation
    // ============================================
    const acqqMatch = targetUrl.href.match(/ac\.qq\.com\/ComicView\/index\/id\/(\d+)\/cid\/(\d+)/);
    if (acqqMatch) {
      const [, comicId, chapterCid] = acqqMatch;

      try {
        const pageHeaders = new Headers();
        pageHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        pageHeaders.set("Referer", "https://ac.qq.com/");

        const pageRes = await fetch(targetUrl.toString(), { method: "GET", headers: pageHeaders, redirect: "follow" });
        if (!pageRes.ok) {
          throw new Error(`HTTP ${pageRes.status} fetching chapter page`);
        }
        const html = await pageRes.text();

        const decoded = decodeAcQqChapterData(html);

        const images = (decoded.picture || []).map((p, idx) => ({
          page: idx + 1,
          url: p.url,
          width: p.width,
          height: p.height
        }));

        if (images.length === 0) {
          return new Response(JSON.stringify({
            error: "No images found after decoding ac.qq.com chapter data",
            debug: { comicId, chapterCid }
          }), { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" }});
        }

        return new Response(JSON.stringify({
          source: "acqq",
          comic_id: decoded.comic.id,
          comic_title: decoded.comic.title,
          chapter_id: decoded.chapter.cid,
          chapter_title: decoded.chapter.cTitle,
          total_images: images.length,
          images
        }, null, 2), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }});

      } catch (err) {
        return new Response(JSON.stringify({
          error: "ac.qq.com: failed to decode chapter data",
          detail: err.message,
          note: "This site obfuscates its chapter image data; the decoder may need updating if the site changed its format.",
          debug: { comicId, chapterCid }
        }), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" }});
      }
    }

    // Fallback proxy
    let effectiveReferer = targetUrl.origin + "/";
    let effectiveOrigin = targetUrl.origin;
    if (referer) { try { const r = new URL(referer); effectiveReferer = referer; effectiveOrigin = r.origin; } catch {} }

    const headers = new Headers();
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    headers.set("Accept", "text/html,*/*;q=0.8");
    headers.set("Referer", effectiveReferer);
    headers.set("Origin", effectiveOrigin);

    try {
      const response = await fetch(targetUrl.toString(), { method: "GET", headers, redirect: "follow" });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
      responseHeaders.set("Access-Control-Allow-Headers", "*");
      responseHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
      responseHeaders.delete("content-security-policy");
      responseHeaders.delete("x-frame-options");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } catch (error) {
      return new Response("Proxy error: " + error.message, { status: 502, headers: corsHeaders() });
    }
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Cache-Control": "no-store"
  };
}

// ============================================
// AC.QQ.COM decoder — no eval(), safe for Cloudflare Workers.
//
// The chapter page embeds `var DATA = '<base64-ish string>'`, which is not
// plain base64: certain character ranges must be stripped first, per removal
// instructions derived from `window.nonce`. The nonce itself is sometimes a
// plain hex string, and sometimes assembled from small inline JS expressions
// like `(+eval("Math.pow(1,3)+1+1")).toString()`. Since eval() is disallowed
// in Workers, the limited expression grammar actually seen on this site is
// parsed and evaluated by hand below instead of using eval().
//
// Algorithm (reverse engineered from ac.page.chapter.view_v2.7.0.js):
//   T = DATA.split('')
//   N = nonce.match(/\d+[a-zA-Z]+/g)
//   for each match in N, iterating from the LAST match to the FIRST:
//       locate = parseInt(leadingDigits) & 255
//       removeCount = length of the trailing letters part
//       T.splice(locate, removeCount)
//   cleanedBase64 = T.join('')
//   json = JSON.parse(utf8Decode(base64Decode(cleanedBase64)))
// ============================================

function safeEvalNonceExpr(expr) {
  let e = expr.trim();

  // Known browser-environment stand-ins the site's nonce script tends to probe.
  // These are always true/defined in a real browser, so hardcode their effect.
  e = e.replace(/!!document\.getElementsByTagName\(['"]html['"]\)/g, "true");
  e = e.replace(/!window\.Array/g, "false");
  e = e.replace(/!!window\.Array/g, "true");
  e = e.replace(/typeof\s+window\s*!==?\s*['"]undefined['"]/g, "true");
  e = e.replace(/typeof\s+document\s*!==?\s*['"]undefined['"]/g, "true");

  // Math.pow(a,b)
  e = e.replace(/Math\.pow\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    (_, a, b) => String(Math.pow(parseFloat(a), parseFloat(b))));

  if (!/^[\d\s+\-*/%().<>=!?:truefalse]+$/i.test(e)) {
    throw new Error("Unrecognized nonce expression pattern: " + expr);
  }

  return evalArithmeticBooleanTernary(e);
}

// Minimal recursive-descent evaluator for: number literals, true/false,
// + - * / % with parens and unary +/-/!, comparisons (< > <= >= == ===),
// and the ternary operator. No identifiers, no function calls, no eval.
function evalArithmeticBooleanTernary(src) {
  let pos = 0;
  const s = src.replace(/\s+/g, "");

  function startsWith(tok) { return s.startsWith(tok, pos); }
  function consume(tok) {
    if (!startsWith(tok)) throw new Error(`Expected '${tok}' at ${pos} in '${s}'`);
    pos += tok.length;
  }

  function parseTernary() {
    const cond = parseComparison();
    if (startsWith("?")) {
      consume("?");
      const a = parseTernary();
      consume(":");
      const b = parseTernary();
      return cond ? a : b;
    }
    return cond;
  }

  function parseComparison() {
    let left = parseAdditive();
    while (true) {
      if (startsWith("<=")) { consume("<="); left = left <= parseAdditive(); }
      else if (startsWith(">=")) { consume(">="); left = left >= parseAdditive(); }
      else if (startsWith("===")) { consume("==="); left = left === parseAdditive(); }
      else if (startsWith("==")) { consume("=="); left = left == parseAdditive(); }
      else if (startsWith("<")) { consume("<"); left = left < parseAdditive(); }
      else if (startsWith(">")) { consume(">"); left = left > parseAdditive(); }
      else break;
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (true) {
      if (startsWith("+")) { consume("+"); left = left + parseMultiplicative(); }
      else if (startsWith("-")) { consume("-"); left = left - parseMultiplicative(); }
      else break;
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (true) {
      if (startsWith("*")) { consume("*"); left = left * parseUnary(); }
      else if (startsWith("/")) { consume("/"); left = left / parseUnary(); }
      else if (startsWith("%")) { consume("%"); left = left % parseUnary(); }
      else break;
    }
    return left;
  }

  function parseUnary() {
    if (startsWith("!")) { consume("!"); return parseUnary() ? false : true; }
    if (startsWith("+")) { consume("+"); return +parseUnary(); }
    if (startsWith("-")) { consume("-"); return -parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    if (startsWith("(")) {
      consume("(");
      const v = parseTernary();
      consume(")");
      return v;
    }
    if (startsWith("true")) { consume("true"); return true; }
    if (startsWith("false")) { consume("false"); return false; }
    const m = /^\d+(\.\d+)?/.exec(s.slice(pos));
    if (m) { pos += m[0].length; return parseFloat(m[0]); }
    throw new Error(`Unexpected token at ${pos} in '${s}'`);
  }

  const result = parseTernary();
  if (pos !== s.length) throw new Error(`Trailing input at ${pos} in '${s}'`);
  return result;
}

// Extract the final nonce value from a chapter page's HTML, WITHOUT eval().
function extractNonce(html) {
  const assignRe = /window\[\s*["']n["']\s*\+?\s*["']?once["']?\s*\]\s*=\s*([^;]+);|window\[\s*["']no["']\s*\+\s*["']nce["']\s*\]\s*=\s*([^;]+);/g;
  let match;
  let lastExpr = null;
  while ((match = assignRe.exec(html)) !== null) {
    lastExpr = match[1] || match[2];
  }
  if (!lastExpr) return null;
  return buildNonceFromExpr(lastExpr);
}

// Parse an expression like:
//   '' + '6adacb40f9dfb6994505268ae7fed911'
// or:
//   "d56fb1" + (+eval("9 * 0")).toString() + "8" + (+eval("Math.pow(1,3)+1+1")).toString() + ...
function buildNonceFromExpr(expr) {
  const pieces = splitTopLevelPlus(expr);
  let result = "";
  for (const piece of pieces) {
    const p = piece.trim();

    const strMatch = /^['"]([^'"]*)['"]$/.exec(p);
    if (strMatch) {
      result += strMatch[1];
      continue;
    }

    const evalMatch = /^\(\+eval\((["'])((?:(?!\1).)*)\1\)\)\.toString\(\)$/.exec(p);
    if (evalMatch) {
      const innerExpr = evalMatch[2];
      const value = safeEvalNonceExpr(innerExpr);
      result += String(+value);
      continue;
    }

    throw new Error("Unrecognized nonce piece: " + p);
  }
  return result;
}

function splitTopLevelPlus(expr) {
  const pieces = [];
  let depth = 0;
  let inStr = null;
  let current = "";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (inStr) {
      current += c;
      if (c === inStr && expr[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; current += c; continue; }
    if (c === "(") { depth++; current += c; continue; }
    if (c === ")") { depth--; current += c; continue; }
    if (c === "+" && depth === 0) { pieces.push(current); current = ""; continue; }
    current += c;
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}

function cleanAcQqData(dataRaw, nonce) {
  const T = dataRaw.split("");
  const N = nonce.match(/\d+[a-zA-Z]+/g) || [];
  for (let j = N.length - 1; j >= 0; j--) {
    const m = N[j];
    const digits = /^\d+/.exec(m)[0];
    const letters = m.replace(/\d+/g, "");
    const locate = parseInt(digits, 10) & 255;
    T.splice(locate, letters.length);
  }
  return T.join("");
}

function acQqBase64ToUtf8(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Main entry point: given the raw chapter page HTML, return the parsed
// comic/chapter/picture data, or throw with a descriptive message.
function decodeAcQqChapterData(html) {
  const dataMatch = /var DATA = '([^']+)'/.exec(html);
  if (!dataMatch) throw new Error("DATA variable not found in page HTML");
  const dataRaw = dataMatch[1];

  const nonce = extractNonce(html);
  if (!nonce) throw new Error("nonce assignment not found in page HTML");

  const cleanedB64 = cleanAcQqData(dataRaw, nonce);
  const jsonText = acQqBase64ToUtf8(cleanedB64);
  return JSON.parse(jsonText);
}
