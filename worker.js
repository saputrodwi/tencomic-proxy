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
          
          // Fix: Allow both single/double quotes and flexible declarations
          debugInfo.has_DATA_var = /(?:var|let|const)?\s*DATA\s*=\s*['"]/.test(html);
          debugInfo.has_nonce_assignment = /window\.nonce\s*=|window\[\s*(?:["'][^"']*["']\s*\+?\s*)+\]\s*=/.test(html);

          if (debugInfo.has_DATA_var && debugInfo.has_nonce_assignment) {
            try {
              // Greedy match up to the LAST quote+semicolon in the file for this
              // quote style avoids truncating on a stray quote inside the blob;
              // acQqExtractData() does the robust version, reuse it here.
              const dataRaw = acQqExtractData(html);
              if (dataRaw) {
                debugInfo.data_raw_length = dataRaw.length;
                debugInfo.data_raw_sample_start = dataRaw.slice(0, 60);
                debugInfo.data_raw_sample_end = dataRaw.slice(-60);
              }

              const assignments = findAllNonceAssignments(html);
              debugInfo.nonce_assignment_count = assignments.length;
              const lastRawExpr = assignments.length ? assignments[assignments.length - 1].expr : null;
              debugInfo.nonce_raw_expr = lastRawExpr;

              const nonceResolved = lastRawExpr ? buildNonceFromExpr(lastRawExpr) : null;
              debugInfo.nonce_resolved = nonceResolved;
              debugInfo.nonce_resolved_length = nonceResolved ? nonceResolved.length : null;

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

      async function pageExists(n) {
        const pageNum = String(n).padStart(3, "0");
        const imgUrl = `${baseImageUrl}${pageNum}.jpg`;
        try {
          const res = await fetch(imgUrl, { method: "HEAD", headers: probeHeaders, redirect: "follow" });
          return { ok: res.ok, url: imgUrl };
        } catch (e) {
          return { ok: false, url: imgUrl };
        }
      }

      // Cloudflare Workers on the Free plan allow only 50 subrequests per
      // invocation. A naive 1-request-per-page linear probe runs out of
      // budget on chapters longer than ~45 pages (the request that would
      // confirm page N silently fails once the budget is exhausted, which
      // looks exactly like "page N doesn't exist" — undercounting long
      // chapters). To stay well under the budget regardless of chapter
      // length, binary-search for the highest page number that exists
      // (~9 requests covers up to 300 pages), then generate the full
      // 1..N URL list directly instead of probing every page individually.
      //
      // Trade-off: most jjaptoon chapters are numbered contiguously, but a
      // few have real gaps in the middle (e.g. 037.jpg then 071.jpg with
      // nothing in between). Skipping the per-page scan means a gap like
      // that isn't detected here — the missing URLs are still included in
      // the list, and will simply fail individually at actual download time
      // (reported as "failed" in the log) rather than corrupting the whole
      // chapter fetch or silently truncating a long, gap-free chapter.
      const HARD_MAX_PAGE = 300;

      let lo = 1, hi = HARD_MAX_PAGE;
      let highestKnownGood = 0;
      let searchCalls = 0;

      const first = await pageExists(1);
      searchCalls++;
      if (first.ok) {
        highestKnownGood = 1;
        while (lo <= hi && searchCalls < 12) {
          const mid = Math.floor((lo + hi) / 2);
          if (mid === 0) break;
          const r = await pageExists(mid);
          searchCalls++;
          if (r.ok) {
            highestKnownGood = Math.max(highestKnownGood, mid);
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
      }

      const comicImages = [];
      for (let n = 1; n <= highestKnownGood; n++) {
        const pageNum = String(n).padStart(3, "0");
        comicImages.push({ page: n, url: `${baseImageUrl}${pageNum}.jpg`, alt: "" });
      }

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
        images: comicImages.map((img) => ({
          page: img.page,
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
// AC.QQ.COM decoder
// ============================================

function safeEvalNonceExpr(expr) {
  let e = expr.trim();
  e = e.replace(/!!document\.getElementsByTagName\(['"]html['"]\)/g, "true");
  e = e.replace(/!window\.Array/g, "false");
  e = e.replace(/!!window\.Array/g, "true");
  e = e.replace(/typeof\s+window\s*!==?\s*['"]undefined['"]/g, "true");
  e = e.replace(/typeof\s+document\s*!==?\s*['"]undefined['"]/g, "true");

  e = e.replace(/Math\.pow\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    (_, a, b) => String(Math.pow(parseFloat(a), parseFloat(b))));

  if (!/^[\d\s+\-*/%().<>=!?:truefalse]+$/i.test(e)) {
    throw new Error("Unrecognized nonce expression pattern: " + expr);
  }

  return evalArithmeticBooleanTernary(e);
}

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

// Find every `window[<key-expr>] = <value-expr>;` or `window.nonce = <value-expr>;`
// assignment in the page, evaluate <key-expr> generically (it's always a
// concatenation of string literals, split in different ways across pages,
// e.g. 'n'+'once', 'no'+'nce', 'n'+'onc'+'e', etc.), and keep the value
// expression from whichever assignment's key evaluates to exactly "nonce".
// The LAST such assignment in document order wins (later script wins,
// matching normal JS execution/assignment order).
function findAllNonceAssignments(html) {
  const results = [];

  // window.nonce = <expr>;
  const dotRe = /window\.nonce\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = dotRe.exec(html)) !== null) {
    results.push({ index: m.index, expr: m[1] });
  }

  // window[ <string-literal-concatenation> ] = <expr>;
  const bracketRe = /window\[\s*((?:["'][^"']*["']\s*\+?\s*)+)\]\s*=\s*([^;\n]+)/g;
  while ((m = bracketRe.exec(html)) !== null) {
    const keyExpr = m[1];
    // Evaluate the key: concatenate all string literal pieces.
    const literals = keyExpr.match(/["']([^"']*)["']/g);
    if (!literals) continue;
    const key = literals.map((s) => s.slice(1, -1)).join("");
    if (key === "nonce") {
      results.push({ index: m.index, expr: m[2] });
    }
  }

  results.sort((a, b) => a.index - b.index);
  return results;
}

function extractNonce(html) {
  const assignments = findAllNonceAssignments(html);
  if (assignments.length === 0) return null;
  const lastExpr = assignments[assignments.length - 1].expr;
  return buildNonceFromExpr(lastExpr);
}

// FIX: Resolve ternary operations completely securely before parsing strings
function buildNonceFromExpr(expr) {
  let e = expr.trim();

  // Known DOM checks replace
  e = e.replace(/!!document\.getElementsByTagName\(['"]html['"]\)/g, "true");
  e = e.replace(/!window\.Array/g, "false");
  e = e.replace(/!!window\.Array/g, "true");
  e = e.replace(/typeof\s+window\s*!==?\s*['"]undefined['"]/g, "true");
  e = e.replace(/typeof\s+document\s*!==?\s*['"]undefined['"]/g, "true");
  e = e.replace(/window\s*!==?\s*undefined/g, "true");
  e = e.replace(/document\s*!==?\s*undefined/g, "true");

  // Resolve outermost ternary (true/false ? A : B) natively
  const ternaryMatch = /^(true|false)\s*\?\s*(.+)$/.exec(e);
  if (ternaryMatch) {
    const condition = ternaryMatch[1] === "true";
    const rest = ternaryMatch[2];
    let depth = 0;
    let inStr = null;
    let colonIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (inStr) {
        if (c === inStr && rest[i - 1] !== "\\") inStr = null;
      } else {
        if (c === "'" || c === '"') inStr = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === ":" && depth === 0) { colonIdx = i; break; }
      }
    }
    if (colonIdx !== -1) {
      const a = rest.substring(0, colonIdx).trim();
      const b = rest.substring(colonIdx + 1).trim();
      e = condition ? a : b;
    }
  }

  const pieces = splitTopLevelPlus(e);
  let result = "";

  for (const piece of pieces) {
    const p = piece.trim();

    const strMatch = /^['"]([^'"]*)['"]$/.exec(p);
    if (strMatch) {
      result += strMatch[1];
      continue;
    }

    // Capture standard eval execution robustly without outer dependencies
    const evalMatch = /eval\((["'])((?:(?!\1).)*)\1\)/.exec(p);
    if (evalMatch) {
      const innerExpr = evalMatch[2];
      const value = safeEvalNonceExpr(innerExpr);
      result += String(+value);
      continue;
    }

    if (/^\d+$/.test(p)) {
      result += p;
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

  // nonce here is the fully-resolved value (a hex-like string mixing
  // digits and letters, e.g. "553a089ee71a1118e2e809dfb35bf504").
  // Junk substrings were spliced into DATA at positions/lengths encoded
  // by tokens of the form <digits><letters> found in this string.
  // Tokens must be removed in the ORIGINAL order returned by the regex,
  // processed back-to-front (last token first) — do NOT sort by index,
  // since later (leftward) removals shift positions for tokens that
  // still need to be processed, and the original algorithm relies on
  // strictly reverse-array-order processing rather than numeric order.
  const N = nonce.match(/\d+[a-zA-Z]+/g) || [];
  let j = N.length;
  while (j > 0) {
    j -= 1;
    const token = N[j];
    const digits = /^\d+/.exec(token)[0];
    const letters = token.replace(/\d+/g, "");
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

// Robustly extract the DATA string literal's raw contents. Using a
// non-greedy (['"])(.*?)\1 regex is unsafe here: if the base64 blob
// itself ever contains a quote character before its real end, it
// truncates early. Instead, find the opening quote after `DATA =`,
// then scan forward for that same quote character immediately
// followed by `;` (the actual statement terminator used on this site).
function acQqExtractData(html) {
  const declIdx = /(?:var|let|const)?\s*DATA\s*=\s*/i.exec(html);
  if (!declIdx) return null;
  const afterDecl = declIdx.index + declIdx[0].length;
  const quoteChar = html[afterDecl];
  if (quoteChar !== "'" && quoteChar !== '"') return null;

  const contentStart = afterDecl + 1;
  // DATA is often declared as part of a multi-variable `var` statement
  // (e.g. `var DATA = '...', ID = _v.comic.id, ...`), so its string
  // literal can be terminated by either `;` or `,`, not just `;`.
  let closeIdx = -1;
  for (let i = contentStart; i < html.length; i++) {
    if (html[i] === quoteChar && html[i - 1] !== "\\") {
      const next = html[i + 1];
      if (next === ";" || next === ",") {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return null;
  return html.slice(contentStart, closeIdx);
}

function decodeAcQqChapterData(html) {
  const dataRaw = acQqExtractData(html);
  if (!dataRaw) throw new Error("DATA variable not found in page HTML");

  const nonce = extractNonce(html);
  if (!nonce) throw new Error("nonce assignment not found in page HTML");

  const cleanedB64 = cleanAcQqData(dataRaw, nonce);
  const jsonText = acQqBase64ToUtf8(cleanedB64);
  return JSON.parse(jsonText);
}
