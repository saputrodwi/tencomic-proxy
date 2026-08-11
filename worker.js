// umum: proxy dibatasi hanya untuk domain platform yang didukung + CDN gambarnya.
// Ini mencegah endpoint dipakai sebagai open proxy publik (lihat bug #19/#20).
// Setiap kali menambah platform baru, tambahkan juga domain halaman chapter-nya
// DAN domain CDN gambarnya (kalau beda) di daftar ini.
//
// jjaptoon sengaja diperlakukan khusus: situsnya rutin pindah domain, dan
// bukan cuma nomornya yang berubah (jjaptoon003, 004, 005, dst) — TLD-nya
// juga ikut berganti (sudah pernah dipakai: .com, .net; kemungkinan .vip
// juga pernah dipakai). CDN gambarnya juga ikut domain utama yang aktif
// saat itu (misal www.jjaptoon.net/comics-imported/...). Exact-match akan
// selalu ketinggalan kombinasi terbaru, jadi dicocokkan lewat pola yang
// menerima nomor opsional + salah satu TLD dari daftar yang pernah teramati.
// Kalau situsnya pindah ke TLD baru lagi di luar daftar ini, tambahkan di sini.
const JJAPTOON_HOST_RE = /^(www\.)?jjaptoon\d*\.(com|net|vip|xyz|top|me)$/;

const ALLOWED_HOST_SUFFIXES = [
  "twmanga.com",
  "baozimh.com",
  "baozicdn.com",
  "bzcdn.net",
  "manwa.me",
  "mwappimgs.cc",
  "311s.com",
  "wmanhua.com"
];

function isHostAllowed(hostname) {
  const h = hostname.toLowerCase();
  if (JJAPTOON_HOST_RE.test(h)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith("." + suffix));
}

// umum: batas ukuran file untuk mencegah body sangat besar menghabiskan memory
// Worker (lihat bug #23). Dicek dari header Content-Length kalau tersedia; kalau
// server tidak mengirim header itu, body tetap diperbolehkan lewat (kita tidak
// bisa tahu ukurannya tanpa membaca seluruh stream lebih dulu).
const MAX_FETCH_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * fetch() dengan redirect manual + validasi ulang setiap hop terhadap allowlist
 * (lihat bug #21). Redirect ke domain yang tidak diizinkan akan ditolak, bukan
 * diikuti diam-diam.
 */
async function safeFetch(url, options = {}, maxRedirects = 5) {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(currentUrl, { ...options, redirect: "manual" });

    const isRedirect = res.status >= 300 && res.status < 400;
    if (!isRedirect) {
      const contentLength = Number(res.headers.get("content-length") || 0);
      if (contentLength > MAX_FETCH_BYTES) {
        throw new Error(`Response too large (${contentLength} bytes, max ${MAX_FETCH_BYTES})`);
      }
      return res;
    }

    const location = res.headers.get("location");
    if (!location) return res; // redirect tanpa Location, biarkan caller yang urus

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error(`Invalid redirect Location: ${location}`);
    }

    if (!["http:", "https:"].includes(nextUrl.protocol) || !isHostAllowed(nextUrl.hostname)) {
      throw new Error(`Redirect to disallowed host blocked: ${nextUrl.hostname}`);
    }

    currentUrl = nextUrl.toString();
  }
  throw new Error("Too many redirects");
}

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: corsHeaders(request) });
    }

    const target = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("u");
    const referer = reqUrl.searchParams.get("referer") || reqUrl.searchParams.get("ref") || "";

    if (!target) {
      return new Response("Missing ?url=", { status: 400, headers: corsHeaders(request) });
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
      return new Response("Invalid URL: " + decodedTarget.substring(0, 100), { status: 400, headers: corsHeaders(request) });
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return new Response("Only http/https", { status: 400, headers: corsHeaders(request) });
    }

    // umum: proteksi SSRF — blok alamat internal terlebih dulu
    const hostname = targetUrl.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" ||
        /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        hostname.endsWith(".internal") || hostname.endsWith(".local")) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders(request) });
    }

    // umum: proxy dibatasi hanya untuk domain platform yang didukung + CDN gambarnya
    if (!isHostAllowed(hostname)) {
      return new Response(
        JSON.stringify({ error: "Host not allowed", hostname }),
        { status: 403, headers: { ...corsHeaders(request), "Content-Type": "application/json" } }
      );
    }

    // jjaptoon: gambar sudah ada langsung di <img src> HTML, jadi kita scrape URL-nya langsung
    const jjaptoonMatch = targetUrl.href.match(/^https?:\/\/[^/]*jjaptoon[^/]*\/chapters\/(\d+)/);
    if (jjaptoonMatch) {
      const chapterId = jjaptoonMatch[1];

      // Domain jjaptoon berubah dari waktu ke waktu (003, 004, dst). Coba URL asli dulu,
      // baru fallback ke domain umum tanpa nomor kalau gagal.
      const urlsToTry = [
        targetUrl.toString(),
        `https://www.jjaptoon.com/chapters/${chapterId}`,
        `https://jjaptoon.com/chapters/${chapterId}`
      ];

      let lastError = null;
      let html = null;
      let successUrl = null;

      // Timeout per domain: kalau satu domain jjaptoon sedang mati/lambat,
      // jangan menunggu sampai batas timeout Cloudflare (bisa puluhan detik).
      // Beri 8 detik per percobaan, lalu segera pindah ke domain fallback berikutnya.
      const FETCH_TIMEOUT_MS = 8000;

      for (const url of urlsToTry) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
          const pageHeaders = new Headers();
          pageHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
          pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
          pageHeaders.set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
          pageHeaders.set("Referer", new URL(url).origin + "/");

          const pageRes = await safeFetch(url, { method: "GET", headers: pageHeaders, signal: controller.signal });

          if (pageRes.ok) {
            html = await pageRes.text();
            successUrl = url;
            break;
          } else {
            lastError = `HTTP ${pageRes.status} for ${url}`;
          }
        } catch (e) {
          lastError = e.name === "AbortError" ? `Timeout (${FETCH_TIMEOUT_MS}ms) for ${url}` : e.message;
        } finally {
          clearTimeout(timeoutId);
        }
      }

      if (!html) {
        return new Response(
          JSON.stringify({
            error: "Jjaptoon chapter not found",
            detail: lastError || "All URLs failed",
            tried: urlsToTry
          }),
          { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
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

      // Gambar sekarang di-render langsung di HTML (tidak lagi kosong/JS-rendered).
      // JANGAN whitelist path CDN tertentu (comics-imported, attachment/scraping, dst) —
      // situs ini sering ganti domain/path CDN gambar tanpa pemberitahuan. Kalau path baru
      // muncul, whitelist lama akan salah membuang semua gambar chapter.
      // Sebaliknya: setiap <img> di halaman ini punya alt text berpola
      // "{judul komik} {judul chapter} {nomor halaman}" (lihat contoh di HTML asli).
      // Itu ciri konten chapter yang stabil, apa pun domain/path file gambarnya.
      // Logo situs, ikon UI, dsb tidak punya alt text berpola begini, jadi otomatis tersaring.
      const imgTagRegex = /<img\b[^>]*>/gi;
      const allImgTags = html.match(imgTagRegex) || [];

      const comicImages = [];
      let idx = 0;
      for (const tag of allImgTags) {
        const srcMatch = tag.match(/\bsrc="([^"]+)"/i);
        const altMatch = tag.match(/\balt="([^"]*)"/i);
        if (!srcMatch) continue;
        const alt = altMatch ? altMatch[1] : "";
        // Alt konten chapter selalu diakhiri nomor halaman (contoh: "... 182화 1", "... 182화 2")
        if (!/\s\d+$/.test(alt.trim())) continue;
        idx++;
        comicImages.push({ page: idx, url: srcMatch[1], alt });
      }

      if (comicImages.length === 0) {
        return new Response(
          JSON.stringify({
            error: "No comic images found in jjaptoon chapter page",
            note: "Expected <img alt=\"...{page number}\"> tags matching the chapter's page numbering. The site may have changed its markup entirely (not just the CDN path).",
            debug: { chapterId, comicTitle, chapterTitle, pageTitle, url: successUrl, totalImgTagsFound: allImgTags.length }
          }),
          { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
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
        headers: { ...corsHeaders(request), "Content-Type": "application/json" }
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
        const apiRes = await safeFetch(apiUrl, { method: "GET", headers: baoziHeaders });
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
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
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
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "Baozimh failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    // 311s: gambar sudah langsung di <img class="comic-image" src="..."> HTML, urutan sesuai posisi di halaman
    const s311Match = targetUrl.href.match(/^https?:\/\/[^/]*311s\.com\/chapter_(\d+)_(\d+)\.html/);
    if (s311Match) {
      const comicId = s311Match[1];
      const chapterId = s311Match[2];

      const s311Url = `https://www.311s.com/chapter_${comicId}_${chapterId}.html`;

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Accept-Language", "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7");
      pageHeaders.set("Referer", "https://www.311s.com/");

      try {
        const pageRes = await safeFetch(s311Url, { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : "";
        // Format title: "{comic} 阅读 - {chapter} - ..."
        let comicTitle = "";
        let chapterTitle = "";
        const titleParts = pageTitle.split(" - ");
        if (titleParts.length >= 2) {
          comicTitle = titleParts[0].replace(/阅读\s*$/, "").trim();
          chapterTitle = titleParts[1].trim();
        }

        const imgTagRegex = /<img\b[^>]*>/gi;
        const allImgTags = html.match(imgTagRegex) || [];
        const comicImages = [];
        let idx = 0;
        for (const tag of allImgTags) {
          if (!/\bclass="comic-image"/i.test(tag)) continue;
          const srcMatch = tag.match(/\bsrc="([^"]+)"/i);
          if (!srcMatch) continue;
          idx++;
          comicImages.push({ page: idx, url: srcMatch[1], alt: "" });
        }

        if (comicImages.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No comic images found in 311s chapter page",
              note: "Expected <img class=\"comic-image\" src=\"...\"> tags. The site may have changed its markup.",
              debug: { comicId, chapterId, pageTitle, url: s311Url }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        return new Response(JSON.stringify({
          source: "311s",
          comic_id: parseInt(comicId),
          chapter_id: parseInt(chapterId),
          comic_title: comicTitle,
          chapter_title: chapterTitle,
          page_title: pageTitle,
          total_images: comicImages.length,
          images: comicImages
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "311s failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    // manwa.me: URL gambar ada langsung di HTML (data-r-src), tapi isi filenya
    // adalah ciphertext AES-128-CBC, bukan gambar biasa. Key & IV sama persis:
    // "my2ecret782ecret" (statis, sudah diverifikasi lintas beberapa chapter/komik
    // berbeda). Dua kasus ditangani di sini:
    //   1. URL chapter (manwa.me/chapter/{id}) -> scrape halaman, balikin daftar url gambar
    //   2. URL gambar (mwappimgs.cc/...) -> fetch ciphertext, decrypt, serve sebagai webp
    const manwaChapterMatch = targetUrl.href.match(/^https?:\/\/(?:www\.)?manwa\.me\/chapter\/(\d+)/);
    const manwaImageMatch = targetUrl.hostname.endsWith("mwappimgs.cc");

    if (manwaChapterMatch) {
      const chapterId = manwaChapterMatch[1];

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Referer", "https://manwa.me/");

      try {
        const pageRes = await safeFetch(targetUrl.toString(), { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : "";
        const titleParts = pageTitle.split(" - ");
        const comicTitle = titleParts[0]?.trim() || "";
        const chapterTitle = titleParts[1]?.trim() || "";

        // Ambil tiap tag <img class="... content-img ... lazy_img ...">, lalu
        // extract attribute data-r-src dari masing-masing tag itu.
        const imgTagRegex = /<img\b[^>]*\bclass="[^"]*content-img[^"]*lazy_img[^"]*"[^>]*>/gi;
        const imgTags = html.match(imgTagRegex) || [];

        const comicImages = [];
        let idx = 0;
        for (const tag of imgTags) {
          const srcMatch = tag.match(/\bdata-r-src="([^"]+)"/i);
          if (!srcMatch) continue;
          idx++;
          comicImages.push({ page: idx, url: srcMatch[1] });
        }

        if (comicImages.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No comic images found in manwa.me chapter page",
              note: "Expected <img class=\"content-img lazy_img\" data-r-src=\"...\"> tags. The site may have changed its markup.",
              debug: { chapterId, pageTitle, totalImgTagsFound: imgTags.length }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        return new Response(JSON.stringify({
          source: "manwa",
          chapter_id: parseInt(chapterId),
          comic_title: comicTitle,
          chapter_title: chapterTitle,
          page_title: pageTitle,
          total_images: comicImages.length,
          images: comicImages
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "manwa.me failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    if (manwaImageMatch) {
      const imgHeaders = new Headers();
      imgHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");
      imgHeaders.set("Referer", "https://manwa.me/");

      try {
        const imgRes = await safeFetch(targetUrl.toString(), { method: "GET", headers: imgHeaders });
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);

        const encryptedBuffer = await imgRes.arrayBuffer();

        const MANWA_AES_KEY = "my2ecret782ecret";
        const keyBytes = new TextEncoder().encode(MANWA_AES_KEY);
        const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
        const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: keyBytes }, cryptoKey, encryptedBuffer);

        return new Response(decryptedBuffer, {
          status: 200,
          headers: { ...corsHeaders(request), "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "manwa.me image decrypt failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    // wmanhua.com: tidak ada enkripsi/signing sama sekali. Chapter HTML embed dua
    // variabel JS polos: `var num = eval("239")` (total halaman, isinya cuma angka
    // literal, eval() di sini kosmetik) dan `var pasd = "https://.../{uuid}/"` (base
    // folder gambar chapter ini). URL gambar tinggal `${pasd}${i}.webp` untuk i=1..num.
    // URL-nya TIDAK signed/expiring, beda dari CDN manwa/dumanwu — jadi aman dipakai
    // kapan saja setelah di-resolve, tidak perlu buru-buru.
    const wmanhuaMatch = targetUrl.href.match(/^https?:\/\/(?:www\.)?wmanhua\.com\/chapter\/(\d+)-(\d+)\.html/i);
    if (wmanhuaMatch) {
      const comicId = wmanhuaMatch[1];
      const chapterId = wmanhuaMatch[2];

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Accept-Language", "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7");
      pageHeaders.set("Referer", "https://www.wmanhua.com/");

      try {
        const pageRes = await safeFetch(targetUrl.toString(), { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const numMatch = html.match(/var\s+num\s*=\s*eval\(\s*["'](\d+)["']\s*\)/);
        const pasdMatch = html.match(/var\s+pasd\s*=\s*["']([^"']+)["']/);

        if (!numMatch || !pasdMatch) {
          return new Response(
            JSON.stringify({
              error: "No comic images found in wmanhua chapter page",
              note: "Expected `var num = eval(\"...\")` and `var pasd = \"...\"` in the page script. The site may have changed its markup.",
              debug: { comicId, chapterId }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        const pageCount = parseInt(numMatch[1], 10);
        let baseUrl = pasdMatch[1];
        if (!baseUrl.endsWith("/")) baseUrl += "/";

        if (!Number.isFinite(pageCount) || pageCount <= 0) {
          return new Response(
            JSON.stringify({ error: "Invalid page count parsed from wmanhua chapter page", detail: numMatch[1] }),
            { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        const titleMatch = html.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
        const h1Match = html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i);
        const rawTitle = (titleMatch && titleMatch[1]) || (h1Match && h1Match[1]) || "";
        const pageTitle = rawTitle.replace(/\s*\|\s*W漫画\s*$/i, "").replace(/\s+/g, " ").trim();

        // Format title: "{chapter} {comic} - ..."
        let comicTitle = "";
        let chapterTitle = "";
        const titleParts = pageTitle.split(" - ");
        const firstPart = (titleParts[0] || "").trim();
        const spaceIdx = firstPart.indexOf(" ");
        if (spaceIdx > -1) {
          chapterTitle = firstPart.slice(0, spaceIdx).trim();
          comicTitle = firstPart.slice(spaceIdx + 1).trim();
        } else {
          chapterTitle = firstPart;
        }

        const comicImages = Array.from({ length: pageCount }, (_, i) => ({
          page: i + 1,
          url: `${baseUrl}${i + 1}.webp`
        }));

        return new Response(JSON.stringify({
          source: "wmanhua",
          comic_id: parseInt(comicId),
          chapter_id: parseInt(chapterId),
          comic_title: comicTitle,
          chapter_title: chapterTitle,
          page_title: pageTitle,
          total_images: comicImages.length,
          images: comicImages
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "wmanhua failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
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
      const response = await safeFetch(targetUrl.toString(), { method: "GET", headers });
      const responseHeaders = new Headers(response.headers);
      const cors = corsHeaders(request);
      responseHeaders.set("Access-Control-Allow-Origin", cors["Access-Control-Allow-Origin"]);
      responseHeaders.set("Access-Control-Allow-Methods", cors["Access-Control-Allow-Methods"]);
      responseHeaders.set("Access-Control-Allow-Headers", cors["Access-Control-Allow-Headers"]);
      responseHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
      responseHeaders.delete("content-security-policy");
      responseHeaders.delete("x-frame-options");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } catch (error) {
      return new Response("Proxy error: " + error.message, { status: 502, headers: corsHeaders(request) });
    }
  }
};

// umum: jika frontend sudah punya domain tetap, isi di sini untuk membatasi CORS
// (lihat bug #22). Biarkan null untuk tetap mengizinkan semua origin ("*").
//
// Diisi ke domain Netlify saat ini. Kalau nanti pindah project Netlify (nama
// project berubah) atau pindah ke domain custom, update nilai ini juga —
// kalau lupa, gejalanya frontend sendiri ikut kena blokir CORS (bukan cuma
// web orang lain).
const ALLOWED_ORIGIN = "https://trialfetch.netlify.app";

function corsHeaders(request) {
  let allowOrigin = "*";
  if (ALLOWED_ORIGIN && request) {
    const origin = request.headers.get("Origin") || "";
    allowOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Cache-Control": "no-store"
  };
}
