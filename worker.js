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

    // umum: proteksi SSRF
    const hostname = targetUrl.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" ||
        /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        hostname.endsWith(".internal") || hostname.endsWith(".local")) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders() });
    }

    // jjaptoon: img src kosong di HTML awal (render JS), jadi URL gambar direkonstruksi dari judul komik + chapter
    const jjaptoonMatch = targetUrl.href.match(/^https?:\/\/[^/]*jjaptoon[^/]*\/chapters\/(\d+)/);
    if (jjaptoonMatch) {
      const chapterId = jjaptoonMatch[1];

      // Build dynamic domain list from input + common fallbacks
      const inputHost = targetUrl.hostname;
      const domains = new Set([
        targetUrl.toString(),
        `${targetUrl.origin}/chapters/${chapterId}`
      ]);
      // www / non-www variant
      if (inputHost.startsWith('www.')) {
        domains.add(`https://${inputHost.slice(4)}/chapters/${chapterId}`);
      } else {
        domains.add(`https://www.${inputHost}/chapters/${chapterId}`);
      }
      // Known fallbacks
      domains.add(`https://www.jjaptoon.vip/chapters/${chapterId}`);
      domains.add(`https://jjaptoon.vip/chapters/${chapterId}`);
      domains.add(`https://www.jjaptoon003.com/chapters/${chapterId}`);
      domains.add(`https://jjaptoon003.com/chapters/${chapterId}`);

      let lastError = null;
      let html = null;
      let successUrl = null;

      for (const url of domains) {
        try {
          const pageHeaders = new Headers();
          pageHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
          pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
          pageHeaders.set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
          pageHeaders.set("Referer", new URL(url).origin + "/");

          const pageRes = await fetch(url, { method: "GET", headers: pageHeaders, redirect: "follow" });

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
            tried: Array.from(domains)
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

      // === NEW: Extract image URLs directly from HTML first ===
      const imageUrls = [];
      const seenUrls = new Set();

      const addUrl = (raw) => {
        let src = raw.trim();
        if (!src || src === '""' || src === "''" || src.startsWith('data:')) return;
        if (src.startsWith('//')) src = 'https:' + src;
        else if (!src.startsWith('http')) src = new URL(src, successUrl).href;
        if (seenUrls.has(src)) return;
        seenUrls.add(src);
        imageUrls.push(src);
      };

      // Pattern 1: img tag attributes (src, data-src, data-original, data-url, data-lazy-src)
      const attrNames = ['src', 'data-src', 'data-original', 'data-url', 'data-lazy-src'];
      for (const attr of attrNames) {
        const regex = new RegExp(`<img[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["'][^>]*>`, 'gi');
        let match;
        while ((match = regex.exec(html)) !== null) {
          const val = match[1].trim();
          if (val.includes('attachment/scraping/') || val.match(/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i)) {
            addUrl(val);
          }
        }
      }

      // Pattern 2: any attachment/scraping URL anywhere in HTML
      if (imageUrls.length === 0) {
        const scrapingRegex = /(https?:\/\/[^"'\s<>]+attachment\/scraping\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp|gif))/gi;
        let match;
        while ((match = scrapingRegex.exec(html)) !== null) {
          addUrl(match[1]);
        }
      }

      // If new CDN images found, return them directly
      if (imageUrls.length > 0) {
        const comicImages = imageUrls.map((url, idx) => ({
          page: idx + 1,
          url: url,
          alt: ""
        }));

        const result = {
          source: "jjaptoon",
          chapter_id: parseInt(chapterId),
          comic_title: comicTitle,
          chapter_title: chapterTitle,
          page_title: pageTitle,
          total_images: comicImages.length,
          images: comicImages
        };

        return new Response(JSON.stringify(result, null, 2), {
          status: 200,
          headers: { ...corsHeaders(), "Content-Type": "application/json" }
        });
      }

      // === FALLBACK: Old title-based reconstruction ===
      const domain = new URL(successUrl).hostname;
      const folderPath = `${comicTitle}/${chapterTitle}`;
      const encodedFolder = folderPath.split("/").map(encodeURIComponent).join("/");
      const baseImageUrl = `https://${domain}/storage/comics-imported/${encodedFolder}/`;

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
        headers: { ...corsHeaders(), "Content-Type": "application/json" }
      });
    }

    // baozimh/twmanga: chapter diakses lewat www.twmanga.com, tapi datanya diambil dari app.baozimh.com pakai header app khusus
    const baoziMatch = targetUrl.href.match(/(?:twmanga\.com|baozimh\.com)\/(?:comic\/chapter|baozimhapp\/comic\/chapter)\/([^/]+)\/([^/?#]+)\.html/);
    if (baoziMatch) {
      const comicSlug = baoziMatch[1];
      const chapterFile = baoziMatch[2];

      const apiUrl = `https://app.baozimh.com/baozimhapp/comic/chapter/${comicSlug}/${chapterFile}.html`;

      const baoziHeaders = new Headers();
      baoziHeaders.set("Referer", "https://appgb.baozimh.com/");
      baoziHeaders.set("app-id", "cn.sts.xiaoyun.ordermeals");
      baoziHeaders.set("device-code", "6ca052067aa9833084daaa6ffeba0913");
      baoziHeaders.set("device-id", "RKQ1.201217.002");
      baoziHeaders.set("user-agent", "baozimh_android/1.0.31/gb/adset");
      baoziHeaders.set("app-version", "1.0.31");
      baoziHeaders.set("Accept-Encoding", "gzip");
      baoziHeaders.set("Connection", "Keep-Alive");

      try {
        const apiRes = await fetch(apiUrl, { method: "GET", headers: baoziHeaders, redirect: "follow" });
        if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);
        const html = await apiRes.text();

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : "";
        const titleParts = pageTitle.split(" - ");
        const chapterTitle = titleParts[0]?.trim() || "";
        const comicTitle = titleParts[1]?.trim() || "";

        const imgRegex = /<img\b[^>]*\bclass="comic-contain__item"[^>]*>/gi;
        const imgTags = html.match(imgRegex) || [];

        const comicImages = imgTags.map((tag, idx) => {
          const srcMatch = tag.match(/data-src="([^"]+)"/i);
          const idxMatch = tag.match(/data-index="(\d+)"/i);
          const wMatch = tag.match(/data-w="(\d+)"/i);
          const hMatch = tag.match(/data-h="(\d+)"/i);
          return {
            page: idxMatch ? parseInt(idxMatch[1]) + 1 : idx + 1,
            url: srcMatch ? srcMatch[1] : null,
            width: wMatch ? parseInt(wMatch[1]) : null,
            height: hMatch ? parseInt(hMatch[1]) : null
          };
        }).filter(img => img.url);

        if (comicImages.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No comic images found in baozimh chapter page",
              note: "Expected <img class=\"comic-contain__item\" data-src=\"...\"> tags. The site may have changed its markup.",
              debug: { comicSlug, chapterFile, pageTitle, apiUrl }
            }),
            { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" }}
          );
        }

        return new Response(JSON.stringify({
          source: "baozimh",
          comic_slug: comicSlug,
          chapter_file: chapterFile,
          comic_title: comicTitle,
          chapter_title: chapterTitle,
          page_title: pageTitle,
          total_images: comicImages.length,
          images: comicImages
        }, null, 2), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "Baozimh failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" }});
      }
    }

    // umum: fallback proxy generic untuk URL apa saja yang tidak dikenali di atas
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
