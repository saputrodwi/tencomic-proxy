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
