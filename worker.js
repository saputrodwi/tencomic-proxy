// umum: proxy dibatasi hanya untuk domain platform yang didukung + CDN gambarnya.
// Ini mencegah endpoint dipakai sebagai open proxy publik (lihat bug #19/#20).
// Setiap kali menambah platform baru, tambahkan juga domain halaman chapter-nya
// DAN domain CDN gambarnya (kalau beda) di daftar ini.
// Tidak ada
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
  "wmanhua.com",
  "koudaimh.com",
  // CDN gambar Koudaimh dapat memakai host terpisah dari halaman chapter.
  // Host ini tetap dibatasi suffix-nya; jangan mengubah proxy menjadi open proxy.
  "koudaimg.com",
  "shimolife.com"
];

function isHostAllowed(hostname) {
  const h = hostname.toLowerCase();
  if (JJAPTOON_HOST_RE.test(h)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith("." + suffix));
}

// umum: rate limiting sederhana per-IP (lihat bug #2g — sebelumnya siapa
// pun bisa memakai endpoint tanpa batas, membebani kuota Worker maupun
// situs sumber). Ini in-memory (bukan KV/Durable Objects), jadi PENTING
// dipahami keterbatasannya:
//   - counter hilang tiap kali Worker instance di-restart/di-scale ulang
//     oleh Cloudflare — bukan hitungan yang benar-benar akurat/permanen;
//   - tiap instance/lokasi edge Cloudflare punya counter sendiri-sendiri
//     (tidak shared global), jadi limit efektif per pengguna bisa lebih
//     longgar dari angka yang tertulis di sini kalau request tersebar ke
//     banyak edge location;
//   - ini lapisan pertama yang menahan abuse KASAR (script yang spam
//     ratusan request per detik dari IP yang sama), bukan proteksi kuat
//     terhadap penyalahgunaan terdistribusi/serius. Untuk itu perlu
//     Durable Objects, KV dengan TTL, atau Cloudflare Rate Limiting Rules
//     di level dashboard (lebih akurat, tapi butuh setup terpisah).
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; 
const RATE_LIMIT_MAX_REQUESTS = 500; // per IP per window
const rateLimitBuckets = new Map(); // ip -> { count, windowStart }

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  return true;
}

// Bersihkan bucket lama sesekali supaya Map tidak tumbuh tanpa batas kalau
// Worker instance-nya hidup lama (banyak IP unik numpuk di memori).
let lastRateLimitCleanup = Date.now();
function cleanupRateLimitBuckets() {
  const now = Date.now();
  if (now - lastRateLimitCleanup < RATE_LIMIT_WINDOW_MS) return;
  lastRateLimitCleanup = now;
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitBuckets.delete(ip);
    }
  }
}

// umum: batas ukuran file untuk mencegah body sangat besar menghabiskan memory
// Worker (lihat bug #23).
const MAX_FETCH_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Membungkus response.body dengan TransformStream yang menghitung byte
 * secara real-time saat stream dibaca, dan menghentikan aliran begitu
 * melebihi maxBytes — bukan cuma percaya header Content-Length (yang bisa
 * tidak ada sama sekali kalau origin pakai chunked transfer, atau mewakili
 * ukuran terkompresi yang beda dari ukuran aktual setelah decompress).
 * Body baru benar-benar "membesar" saat caller memanggil .text()/
 * .arrayBuffer()/.json() — enforcement di titik itu (lewat stream), bukan
 * di titik fetch, supaya efektif untuk semua kasus di atas.
 */
function limitResponseSize(response, maxBytes) {
  if (!response.body) return response;

  let received = 0;
  const limited = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        controller.error(new Error(`Response too large (exceeded ${maxBytes} bytes while streaming)`));
        return;
      }
      controller.enqueue(chunk);
    }
  });

  const newBody = response.body.pipeThrough(limited);
  return new Response(newBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// umum: timeout default untuk subrequest yang tidak menyediakan AbortSignal
// sendiri (lihat bug #2f — sebelumnya cuma handler chapter jjaptoon yang
// punya timeout, 9 titik fetch lain tidak punya sama sekali dan bisa
// menahan Worker selama origin lambat merespons).
const DEFAULT_FETCH_TIMEOUT_MS = 15000;

// umum: header yang isinya spesifik untuk origin tertentu (misal kredensial
// app baozimh) — kalau redirect berpindah origin, header-header ini harus
// dilepas dan dibangun ulang, bukan diteruskan mentah ke origin baru yang
// mungkin tidak seharusnya menerimanya (lihat bug #2d).
const ORIGIN_SPECIFIC_HEADERS = ["origin", "referer", "app-id", "device-code", "device-id", "app-version", "cookie", "authorization"];

/**
 * fetch() dengan redirect manual + validasi ulang setiap hop terhadap allowlist
 * (lihat bug #21). Redirect ke domain yang tidak diizinkan akan ditolak, bukan
 * diikuti diam-diam. Body response non-redirect dibungkus limitResponseSize()
 * supaya batas ukuran ditegakkan lewat streaming aktual, bukan cuma header.
 * Kalau caller tidak mengirim `signal` sendiri di options, dipasang timeout
 * default di sini supaya semua handler otomatis terlindungi tanpa perlu
 * ditambahkan satu-satu.
 *
 * Semantik redirect mengikuti spek HTTP (lihat bug #2c), bukan asal mengulang
 * method+body yang sama di setiap hop:
 *   - 303 selalu didowngrade ke GET tanpa body, apa pun method aslinya;
 *   - 301/302 untuk method selain GET/HEAD didowngrade ke GET tanpa body
 *     (ini juga perilaku browser/fetch spec modern, walau standar lama
 *     mengizinkan mempertahankan method untuk 301/302);
 *   - 307/308 WAJIB mempertahankan method dan body persis seperti request
 *     asal — tidak didowngrade.
 * Header yang origin-spesifik (lihat ORIGIN_SPECIFIC_HEADERS) dilepas dan
 * dibangun ulang setiap kali redirect berpindah origin.
 */
async function safeFetch(url, options = {}, maxRedirects = 5) {
  const hasOwnSignal = !!options.signal;
  const timeoutController = hasOwnSignal ? null : new AbortController();
  const timeoutId = timeoutController
    ? setTimeout(() => timeoutController.abort(), DEFAULT_FETCH_TIMEOUT_MS)
    : null;

  try {
    let currentUrl = url;
    let currentMethod = options.method || "GET";
    let currentBody = options.body;
    let currentHeaders = options.headers instanceof Headers
      ? new Headers(options.headers)
      : new Headers(options.headers || {});
    const originalOrigin = new URL(url).origin;

    for (let i = 0; i <= maxRedirects; i++) {
      let res;
      try {
        res = await fetch(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          redirect: "manual",
          signal: hasOwnSignal ? options.signal : timeoutController.signal
        });
      } catch (err) {
        if (err.name === "AbortError" && !hasOwnSignal) {
          throw new Error(`Request timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms: ${currentUrl}`);
        }
        throw err;
      }

      const isRedirect = res.status >= 300 && res.status < 400;
      if (!isRedirect) {
        return limitResponseSize(res, MAX_FETCH_BYTES);
      }

      // Body response redirect tidak dipakai — dibatalkan supaya koneksi
      // segera dilepas, bukan dibiarkan menggantung (lihat bug 2e).
      if (res.body) { try { await res.body.cancel(); } catch {} }

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

      // Semantik method/body sesuai status code (lihat bug #2c).
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && !["GET", "HEAD"].includes(currentMethod))) {
        currentMethod = "GET";
        currentBody = undefined;
        currentHeaders.delete("content-type");
      }
      // 307/308: method dan body sengaja TIDAK diubah sama sekali.

      // Origin berubah -> lepas header origin-spesifik (lihat bug #2d).
      // TIDAK membangun ulang Referer/Origin otomatis di sini — kalau
      // request awal sengaja tidak menyertakan header itu (misal untuk CDN
      // ber-signed-URL seperti shimolife.com yang memakai
      // referrerpolicy="no-referrer" di halaman aslinya), menambahkannya
      // kembali saat redirect akan membuat request berbeda dari yang
      // diharapkan upstream dan berisiko ditolak.
      if (nextUrl.origin !== originalOrigin) {
        for (const h of ORIGIN_SPECIFIC_HEADERS) currentHeaders.delete(h);
      }

      currentUrl = nextUrl.toString();
    }
    throw new Error("Too many redirects");
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Rate limit dicek sebelum logic lain (kecuali OPTIONS preflight, yang
    // otomatis dikirim browser tiap request CORS sungguhan dan bukan
    // permintaan terpisah dari pengguna) — lihat bug #2g.
    cleanupRateLimitBuckets();
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRateLimit(clientIp)) {
      return new Response(
        JSON.stringify({ error: "Too many requests", detail: `Limit: ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s` }),
        { status: 429, headers: { ...corsHeaders(request), "Content-Type": "application/json", "Retry-After": String(RATE_LIMIT_WINDOW_MS / 1000) } }
      );
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: corsHeaders(request) });
    }

    const target = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("u");
    const referer = reqUrl.searchParams.get("referer") || reqUrl.searchParams.get("ref") || "";

    if (!target) {
      return new Response("Missing ?url=", { status: 400, headers: corsHeaders(request) });
    }

    // URLSearchParams.get() sudah mendecode query parameter sekali.
    // Jangan memanggil decodeURIComponent() lagi: signed URL gambar Koudaimh
    // dapat berisi %2F, %3D, %26, atau signature lain yang akan berubah bila
    // didecode untuk kedua kalinya.
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid URL: " + String(target).substring(0, 100), { status: 400, headers: corsHeaders(request) });
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

    // jjaptoon: URL SERIES (bukan chapter). Halaman series (Livewire/PHP,
    // server-side rendered) menampilkan SEMUA chapter langsung di satu
    // halaman HTML — sudah diverifikasi manual pakai sampel 49 chapter dan
    // 193 chapter, keduanya cocok persis dengan jumlah "총 N화" yang
    // tertulis di halaman, tanpa pagination/load-more dan tanpa duplikat
    // (beda dari wmanhua yang butuh API terpisah, dan baozimh yang render
    // dobel). Tiap chapter link berpola:
    //   <a href="/chapters/{id}" data-chapter-list-id="{id}" ...>
    //     ...<p class="truncate text-sm font-black text-zinc-100">{judul}</p>
    // Domain jjaptoon sering berganti (003, 005, dst, dan bisa juga TLD
    // beda) — dicocokkan lewat pola generik yang sama dengan handler
    // chapter di atas, bukan hardcode satu domain.
    //
    // Catatan: format judul chapter TIDAK seragam (kadang pakai judul komik
    // di depan, kadang cuma nomor, kadang ada prefix angka lama seperti
    // "0037 - 37화 : ..."), tapi semua format itu tetap punya digit yang
    // konsisten dengan nomor chapter aslinya, jadi tidak perlu normalisasi
    // khusus di sini — biarkan title apa adanya, ekstraksi nomor (kalau
    // dibutuhkan fitur rentang) sudah ditangani generik di sisi frontend.
    const jjaptoonSeriesMatch = targetUrl.href.match(/^https?:\/\/[^/]*jjaptoon[^/]*\/comics\/(\d+)/);
    if (jjaptoonSeriesMatch) {
      const comicId = jjaptoonSeriesMatch[1];

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
      pageHeaders.set("Referer", targetUrl.origin + "/");

      try {
        const pageRes = await safeFetch(targetUrl.toString(), { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const chapterLinkRe = /href="\/chapters\/(\d+)"[^>]*data-chapter-list-id="\d+"[\s\S]*?<p class="truncate text-sm font-black text-zinc-100">([^<]+)<\/p>/g;

        const chapters = [];
        let m;
        while ((m = chapterLinkRe.exec(html)) !== null) {
          const [, chapterId, title] = m;
          chapters.push({
            chapter_id: chapterId,
            chapter_title: title.trim(),
            url: `${targetUrl.origin}/chapters/${chapterId}`
          });
        }

        if (chapters.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No chapters found in jjaptoon series page",
              note: "Expected <a href=\"/chapters/{id}\" data-chapter-list-id=\"...\"> links with a following <p class=\"truncate text-sm font-black text-zinc-100\"> title. The site may have changed its markup.",
              debug: { comicId }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        return new Response(JSON.stringify({
          source: "jjaptoon",
          type: "series",
          comic_id: comicId,
          total_chapters: chapters.length,
          chapters
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "jjaptoon series fetch failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    // baozimh/twmanga: chapter diakses lewat www.twmanga.com, tapi datanya diambil dari app.baozimh.com pakai header app khusus
    const baoziMatch = targetUrl.href.match(/(?:twmanga\.com|baozimh\.com)\/(?:comic\/chapter|baozimhapp\/comic\/chapter)\/([^/]+)\/([^/?#]+)\.html/);
    if (baoziMatch) {
      const comicSlug = baoziMatch[1];
      const chapterFile = baoziMatch[2];

      const apiUrl = `https://app.baozimh.com/baozimhapp/comic/chapter/${comicSlug}/${chapterFile}.html`;

      // Kredensial app baozimh WAJIB diisi lewat Cloudflare environment
      // variable (Settings > Variables and Secrets di dashboard Worker) —
      // tidak ada fallback nilai literal di sini secara sengaja, supaya
      // file ini tetap bersih dari kredensial apa pun meski dibagikan.
      // Kalau salah satu env var belum di-set, request ditolak dini dengan
      // pesan jelas, bukan diam-diam gagal di tengah proses fetch.
      const requiredBaoziEnvKeys = ["BAOZI_APP_ID", "BAOZI_DEVICE_CODE", "BAOZI_DEVICE_ID", "BAOZI_USER_AGENT", "BAOZI_APP_VERSION"];
      const missingBaoziEnvKeys = requiredBaoziEnvKeys.filter((key) => !env || !env[key]);
      if (missingBaoziEnvKeys.length > 0) {
        return new Response(
          JSON.stringify({
            error: "Baozimh worker misconfigured",
            detail: `Missing environment variable(s): ${missingBaoziEnvKeys.join(", ")}. Set them in Cloudflare Worker Settings > Variables and Secrets.`
          }),
          { status: 500, headers: { ...corsHeaders(request), "Content-Type": "application/json" } }
        );
      }

      const baoziHeaders = new Headers();
      baoziHeaders.set("Referer", "https://appgb.baozimh.com/");
      baoziHeaders.set("app-id", env.BAOZI_APP_ID);
      baoziHeaders.set("device-code", env.BAOZI_DEVICE_CODE);
      baoziHeaders.set("device-id", env.BAOZI_DEVICE_ID);
      baoziHeaders.set("user-agent", env.BAOZI_USER_AGENT);
      baoziHeaders.set("app-version", env.BAOZI_APP_VERSION);
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

    // baozimh: URL SERIES (bukan chapter). Halaman series adalah AMP page
    // yang server-side rendered, jadi daftar chapter sudah langsung ada di
    // HTML, tidak perlu API terpisah seperti wmanhua. Tiap link chapter
    // berpola:
    //   /user/page_direct?comic_id={slug}&section_slot={S}&chapter_slot={C}
    // yang mengarah ke halaman chapter format:
    //   twmanga.com/comic/chapter/{slug}/{S}_{C}.html
    // (sudah dikenali handler chapter di atas, yang otomatis redirect ke
    // app.baozimh.com — jadi tidak perlu khawatir soal chapter panjang
    // terpotong per 50 gambar, itu cuma masalah kalau scraping twmanga
    // langsung tanpa lewat app.baozimh.com).
    //
    // PENTING: HTML-nya merender link chapter DUA KALI (kemungkinan preview
    // "chapter terbaru" + daftar lengkap), jadi WAJIB dedupe berdasarkan
    // (section_slot, chapter_slot) sebelum dipakai, dan diurutkan ulang
    // secara eksplisit (bukan andalkan urutan HTML apa adanya, yang
    // ternyata tidak selalu strictly berurutan) — sudah diverifikasi
    // manual pakai sampel 402-chapter, hasilnya tetap benar setelah
    // dedupe+sort meski HTML mentahnya berantakan.
    const baoziSeriesMatch = targetUrl.href.match(/^https?:\/\/(?:www\.)?baozimh\.com\/comic\/([^/?#]+)\/?$/i);
    if (baoziSeriesMatch) {
      const comicSlug = baoziSeriesMatch[1];

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Referer", "https://www.baozimh.com/");

      try {
        const seriesUrl = `https://www.baozimh.com/comic/${comicSlug}`;
        const pageRes = await safeFetch(seriesUrl, { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const chapterLinkRe = /href="\/user\/page_direct\?comic_id=([^&]+)&amp;section_slot=(\d+)&amp;chapter_slot=(\d+)"[^>]*class="comics-chapters__item"[^>]*><div[^>]*><span[^>]*>([^<]+)<\/span>/g;

        const seen = new Set();
        const chapters = [];
        let m;
        while ((m = chapterLinkRe.exec(html)) !== null) {
          const [, slug, sectionSlot, chapterSlot, title] = m;
          const key = `${sectionSlot}_${chapterSlot}`;
          if (seen.has(key)) continue;
          seen.add(key);
          chapters.push({
            section_slot: parseInt(sectionSlot, 10),
            chapter_slot: parseInt(chapterSlot, 10),
            chapter_title: title.trim(),
            url: `https://www.twmanga.com/comic/chapter/${slug}/${sectionSlot}_${chapterSlot}.html`
          });
        }

        // Urut ulang eksplisit terbaru -> terlama (section_slot lalu
        // chapter_slot, keduanya descending), jangan andalkan urutan HTML.
        chapters.sort((a, b) => (b.section_slot - a.section_slot) || (b.chapter_slot - a.chapter_slot));

        if (chapters.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No chapters found in baozimh series page",
              note: "Expected <a href=\"/user/page_direct?...\" class=\"comics-chapters__item\"> links. The site may have changed its markup.",
              debug: { comicSlug }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        return new Response(JSON.stringify({
          source: "baozimh",
          type: "series",
          comic_slug: comicSlug,
          total_chapters: chapters.length,
          chapters
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "baozimh series fetch failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
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

    // manwa.me: URL SERIES (bukan chapter, bukan gambar). Halaman series
    // (manwa.me/book/{id}) render semua chapter langsung di HTML dalam
    // <a href="/chapter/{id}" title="{judul}" class="chapteritem"> —
    // sudah diverifikasi manual pakai sampel 230 chapter, cocok persis
    // dengan "第230话" (chapter terbaru) yang tertulis di halaman, tanpa
    // duplikat dan tanpa pagination.
    //
    // PENTING: urutan HTML aslinya TERLAMA -> TERBARU (chapter 1 di atas),
    // kebalikan dari wmanhua/baozimh/jjaptoon yang semuanya terbaru dulu.
    // Dibalik di sini (reverse array) supaya konsisten "terbaru di atas"
    // sesuai kesepakatan lintas platform.
    //
    // Catatan: beberapa judul chapter di situs ini memakai angka Han
    // (misal "第十五话"), dan ada juga kesalahan penomoran dari situsnya
    // sendiri (satu chapter di posisi ke-11 berjudul "第1话" alih-alih
    // "第11话") — keduanya dibiarkan apa adanya, tidak dinormalisasi.
    const manwaSeriesMatch = targetUrl.href.match(/^https?:\/\/(?:www\.)?manwa\.me\/book\/(\d+)/);
    if (manwaSeriesMatch) {
      const bookId = manwaSeriesMatch[1];

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Referer", "https://manwa.me/");

      try {
        const pageRes = await safeFetch(targetUrl.toString(), { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const chapterLinkRe = /<a href="\/chapter\/(\d+)" title="([^"]+)"\s*class="chapteritem\s*">/g;

        const chapters = [];
        let m;
        while ((m = chapterLinkRe.exec(html)) !== null) {
          const [, chapterId, title] = m;
          chapters.push({
            chapter_id: chapterId,
            chapter_title: title.trim(),
            url: `https://manwa.me/chapter/${chapterId}`
          });
        }

        // Balik urutan: HTML asli terlama->terbaru, kita mau terbaru->terlama.
        chapters.reverse();

        if (chapters.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No chapters found in manwa.me series page",
              note: "Expected <a href=\"/chapter/{id}\" title=\"...\" class=\"chapteritem\"> links. The site may have changed its markup.",
              debug: { bookId }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        return new Response(JSON.stringify({
          source: "manwa",
          type: "series",
          book_id: bookId,
          total_chapters: chapters.length,
          chapters
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "manwa.me series fetch failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
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

    // wmanhua.com: URL SERIES (bukan chapter). Halaman series render maksimal
    // 24 chapter langsung di HTML, sisanya baru muncul lewat tombol "Load
    // More" di browser yang manggil endpoint JSON internal:
    //   POST https://www.wmanhua.com/comic/{comicId}
    //   Content-Type: application/json
    //   Body: {}
    // Respons: { code: 0, data: { chapters: [{ contentId, id, chapterName }, ...] } }
    // Endpoint ini balikin SEMUA chapter sekaligus dalam satu panggilan (sudah
    // diverifikasi manual, bukan perlu pagination berulang), jadi kita panggil
    // endpoint ini langsung dan skip scraping HTML sama sekali — lebih ringan
    // dan tidak akan pernah "ketinggalan" chapter yang di luar 24 pertama.
    const wmanhuaSeriesMatch = targetUrl.href.match(/^https?:\/\/(?:www\.)?wmanhua\.com\/comic\/(\d+)\.html/i);
    if (wmanhuaSeriesMatch) {
      const comicId = wmanhuaSeriesMatch[1];

      const apiHeaders = new Headers();
      apiHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
      apiHeaders.set("Content-Type", "application/json");
      apiHeaders.set("Accept", "application/json, text/plain, */*");
      apiHeaders.set("Referer", targetUrl.toString());

      try {
        const apiUrl = `https://www.wmanhua.com/comic/${comicId}`;
        const apiRes = await safeFetch(apiUrl, { method: "POST", headers: apiHeaders, body: "{}" });
        if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);

        const data = await apiRes.json();

        if (data.code !== 0 || !data.data || !Array.isArray(data.data.chapters)) {
          return new Response(
            JSON.stringify({
              error: "No chapters found in wmanhua series API response",
              note: "Expected { code: 0, data: { chapters: [...] } }. The site may have changed its API response shape.",
              debug: { comicId, responseCode: data.code }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        const chapters = data.data.chapters.map((ch) => ({
          chapter_id: ch.id,
          chapter_title: ch.chapterName,
          url: `https://www.wmanhua.com/chapter/${ch.contentId}-${ch.id}.html`
        }));

        return new Response(JSON.stringify({
          source: "wmanhua",
          type: "series",
          comic_id: parseInt(comicId),
          total_chapters: chapters.length,
          chapters
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "wmanhua series fetch failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    // koudaimh.com: URL CHAPTER. Halaman chapter tidak menaruh URL gambar
    // langsung di <img> — semua data (judul, daftar gambar, dst) dikemas jadi
    // satu blob terenkripsi AES-128-CBC di variabel JS `params = '...'` pada
    // HTML halaman. Key statis (sudah diverifikasi manual lewat simulasi
    // Python terhadap chapter asli): "5V&RoR%Jf@pJPydF" (16 byte -> AES-128).
    // IV BUKAN key seperti manwa.me — di sini IV adalah 16 byte PERTAMA dari
    // hasil base64-decode blob, dan sisanya (byte ke-17 dst) adalah ciphertext
    // sesungguhnya. Setelah didekripsi, hasilnya JSON dengan field
    // `chapter_title`, `comic_name`, `chapter_images` (array URL gambar,
    // di-host di CDN terpisah *.shimolife.com, bukan di koudaimh.com sendiri
    // — makanya shimolife.com juga perlu ada di ALLOWED_HOST_SUFFIXES).
    // crypto.subtle AES-CBC otomatis meng-unpad PKCS7 sendiri saat decrypt,
    // jadi tidak perlu unpad manual seperti port CryptoJS aslinya.
    const koudaimhChapterMatch = targetUrl.href.match(/^https?:\/\/(?:www\.|m\.)?koudaimh\.com\/manhua\/([^/]+)\/(\d+)\.html/);
    if (koudaimhChapterMatch) {
      const seriesSlug = koudaimhChapterMatch[1];
      const chapterId = koudaimhChapterMatch[2];

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Referer", "https://m.koudaimh.com/");

      try {
        const pageRes = await safeFetch(targetUrl.toString(), { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const paramsMatch = html.match(/params\s*=\s*['"]([^'"]+)/);
        if (!paramsMatch) {
          return new Response(
            JSON.stringify({
              error: "No params blob found in koudaimh chapter page",
              note: "Expected a `params = '...'` JS variable containing base64-encoded encrypted data. The site may have changed its markup.",
              debug: { seriesSlug, chapterId }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        const KOUDAIMH_AES_KEY = "5V&RoR%Jf@pJPydF";

        let data;
        try {
          const base64 = paramsMatch[1]
            .replace(/\s+/g, "")
            .replace(/-/g, "+")
            .replace(/_/g, "/");
          const paddedBase64 = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
          const rawBytes = Uint8Array.from(atob(paddedBase64), (c) => c.charCodeAt(0));
          const iv = rawBytes.slice(0, 16);
          const ciphertext = rawBytes.slice(16);

          const keyBytes = new TextEncoder().encode(KOUDAIMH_AES_KEY);
          const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
          const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, ciphertext);

          const plaintext = new TextDecoder("utf-8").decode(decryptedBuffer);
          data = JSON.parse(plaintext);
        } catch (decryptErr) {
          return new Response(
            JSON.stringify({ error: "koudaimh params decrypt failed", detail: decryptErr.message }),
            { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        const rawImages = [
          data.chapter_images,
          data.chapterImages,
          data.images,
          data.image_list
        ].find(Array.isArray) || [];

        // Format payload Koudaimh tidak selalu konsisten: versi lama mengirim
        // string URL, sedangkan beberapa chapter baru mengirim object
        // {url/src/image_url}. URL juga kadang berupa protocol-relative atau
        // berisi escape JSON/HTML. Normalisasi di Worker agar frontend tidak
        // menerima URL yang tampak valid tetapi gagal saat download.
        const comicImages = rawImages
          .map((entry, i) => {
            const rawUrl = typeof entry === "string"
              ? entry
              : entry && (entry.url || entry.src || entry.image_url || entry.imageUrl);
            if (!rawUrl || typeof rawUrl !== "string") return null;
            const normalized = rawUrl
              .replaceAll("\\/", "/")
              .replace(/&amp;/gi, "&")
              .replace(/\\u0026/gi, "&")
              .trim();
            let absolute;
            try {
              absolute = new URL(normalized, targetUrl.origin).toString();
            } catch {
              return null;
            }
            if (!["http:", "https:"].includes(new URL(absolute).protocol)) return null;
            return { page: i + 1, url: absolute };
          })
          .filter(Boolean);

        if (comicImages.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No comic images found in koudaimh chapter data",
              note: "Decrypted successfully but chapter_images was empty/missing. The site may have changed its JSON shape.",
              debug: { seriesSlug, chapterId, decryptedKeys: Object.keys(data) }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        return new Response(JSON.stringify({
          source: "koudaimh",
          comic_id: data.comic_id ?? null,
          chapter_id: data.chapter_id ?? parseInt(chapterId),
          comic_title: data.comic_name || "",
          chapter_title: data.chapter_title || "",
          total_images: comicImages.length,
          images: comicImages
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "koudaimh chapter failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    // koudaimh.com: URL SERIES (bukan chapter). Semua chapter (bisa ratusan)
    // sudah dirender langsung di HTML halaman series dalam satu blok
    // "章节目录" (daftar chapter), TIDAK ada pagination/lazy-load/API
    // tersembunyi (sudah diverifikasi manual: chapter 1 s.d. terbaru semuanya
    // ada di HTML sekali fetch). Urutan aslinya di HTML adalah lama -> baru;
    // dibalik di sini supaya konsisten dengan konvensi worker ini (chapter
    // terbaru ditampilkan duluan di modal pemilih chapter, lihat wmanhua).
    const koudaimhSeriesMatch = targetUrl.href.match(/^https?:\/\/(?:www\.|m\.)?koudaimh\.com\/manhua\/([^/]+)\/?(?:[?#].*)?$/);
    if (koudaimhSeriesMatch) {
      const seriesSlug = koudaimhSeriesMatch[1];

      const pageHeaders = new Headers();
      pageHeaders.set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
      pageHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      pageHeaders.set("Referer", "https://m.koudaimh.com/");

      try {
        const pageRes = await safeFetch(targetUrl.toString(), { method: "GET", headers: pageHeaders });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const html = await pageRes.text();

        const titleMatch = html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i);
        const comicTitle = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

        const coverMatch = html.match(/<img[^>]+src="([^"]+)"[^>]*alt="[^"]*"/i);
        const cover = coverMatch ? coverMatch[1] : "";

        const authorMatch = html.match(/作者[:：]\s*<\/?[^>]*>?\s*([^<\n]+)/i) || html.match(/作者[:：]\s*([^<\n]+)/i);
        const author = authorMatch ? authorMatch[1].trim() : "";

        const statusMatch = html.match(/状态[:：]\s*<\/?[^>]*>?\s*([^<\n]+)/i) || html.match(/状态[:：]\s*([^<\n]+)/i);
        const status = statusMatch ? statusMatch[1].trim() : "";

        const descMatch = html.match(/简介[:：]\s*<\/?[^>]*>?\s*([^<\n]+)/i) || html.match(/简介[:：]\s*([^<\n]+)/i);
        const description = descMatch ? descMatch[1].trim() : "";

        // Daftar chapter: link berpola /manhua/{slug}/{id}.html dengan teks
        // judulnya. Dua blok tampil di halaman ("最新章节" ringkas + "章节目录"
        // lengkap) — hasilnya sama-sama valid tapi bisa duplikat, jadi
        // dedupe berdasarkan chapter_id di akhir.
        const linkRegex = new RegExp(
          `<a[^>]+href="(?:https?://(?:www\\.|m\\.)?koudaimh\\.com)?/manhua/${seriesSlug}/(\\d+)\\.html"[^>]*>\\s*([\\s\\S]*?)\\s*<\\/a>`,
          "gi"
        );

        const seen = new Set();
        const chapters = [];
        let m;
        while ((m = linkRegex.exec(html)) !== null) {
          const chId = m[1];
          if (seen.has(chId)) continue;
          seen.add(chId);
          const chTitle = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
          chapters.push({
            chapter_id: parseInt(chId),
            chapter_title: chTitle,
            url: `https://m.koudaimh.com/manhua/${seriesSlug}/${chId}.html`
          });
        }

        if (chapters.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No chapters found in koudaimh series page",
              note: "Expected <a href=\"/manhua/{slug}/{id}.html\">...</a> links. The site may have changed its markup.",
              debug: { seriesSlug }
            }),
            { status: 404, headers: { ...corsHeaders(request), "Content-Type": "application/json" }}
          );
        }

        // Urutan asli di HTML lama -> baru; dibalik supaya terbaru -> terlama.
        chapters.sort((a, b) => b.chapter_id - a.chapter_id);

        return new Response(JSON.stringify({
          source: "koudaimh",
          type: "series",
          comic_title: comicTitle,
          cover,
          author,
          status,
          description,
          total_chapters: chapters.length,
          chapters
        }, null, 2), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      } catch (err) {
        return new Response(JSON.stringify({ error: "koudaimh series fetch failed", detail: err.message }), { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" }});
      }
    }

    // umum: fallback proxy generic — dimaksudkan HANYA untuk mengambil file
    // media (gambar/video) dari CDN yang sudah di-allowlist, bukan endpoint
    // HTML/JSON sembarangan di domain yang sama (lihat bug #2l — sebelumnya
    // pembatasan cuma berdasarkan hostname, jadi seluruh path di host itu
    // ikut bisa diproksi). Content-Type dari response dicek setelah fetch:
    // kalau bukan media, ditolak — ini lebih reliable daripada menebak dari
    // pola URL, karena banyak CDN manga tidak selalu punya ekstensi jelas
    // di path-nya.
    const isShimolife = targetUrl.hostname === "shimolife.com" || targetUrl.hostname.endsWith(".shimolife.com");

    const headers = new Headers();
    // Koudaimh memuat gambar chapter-nya dengan referrerpolicy="no-referrer"
    // di HTML aslinya — artinya browser asli memang TIDAK mengirim header
    // Referer/Origin sama sekali saat memuat gambar dari *.shimolife.com.
    // Meniru itu di sini (skip kedua header untuk host ini) supaya request
    // proxy terlihat sama seperti request asli yang diizinkan CDN; mengirim
    // Referer/Origin yang sebenarnya tidak pernah ada pada request asli bisa
    // membuat CDN menganggapnya request mencurigakan dan menolak dengan 403.
    const isKoudaimhCdn = isShimolife ||
      targetUrl.hostname === "koudaimg.com" || targetUrl.hostname.endsWith(".koudaimg.com") ||
      targetUrl.hostname === "koudaimh.com" || targetUrl.hostname.endsWith(".koudaimh.com");
    if (isKoudaimhCdn) {
      headers.set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
      headers.set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
      headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    } else {
      let effectiveReferer = targetUrl.origin + "/";
      let effectiveOrigin = targetUrl.origin;
      if (referer) { try { const r = new URL(referer); effectiveReferer = referer; effectiveOrigin = r.origin; } catch {} }

      headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
      headers.set("Accept", "text/html,*/*;q=0.8");
      headers.set("Referer", effectiveReferer);
      headers.set("Origin", effectiveOrigin);
    }

    try {
      let response = await safeFetch(targetUrl.toString(), { method: "GET", headers });

      // CDN Koudaimh tidak selalu konsisten soal hotlink policy. Coba
      // permintaan tanpa referer terlebih dahulu (sesuai referrerpolicy asli),
      // lalu satu fallback dengan referer halaman jika CDN membalas 401/403/429.
      // Keduanya tetap dibatasi host allowlist dan timeout safeFetch.
      if (!response.ok && isKoudaimhCdn && [401, 403, 429].includes(response.status)) {
        if (response.body) { try { await response.body.cancel(); } catch {} }
        headers.set("Referer", "https://m.koudaimh.com/");
        response = await safeFetch(targetUrl.toString(), { method: "GET", headers });
      }

      // Cek status upstream DULU sebelum menilai content-type. Sebelumnya,
      // sebuah 403 dari CDN (yang biasanya membalas halaman HTML kecil
      // berisi pesan error, bukan gambar) langsung jatuh ke pengecekan
      // isMedia di bawah dan dilaporkan sebagai 415 "Generic proxy only
      // serves media" — pesan itu menyesatkan karena masalah sebenarnya
      // adalah upstream menolak requestnya (403/429/dst), bukan proxy ini
      // yang pilih-pilih tipe konten. Membedakan ini penting untuk
      // diagnosis: 403 upstream nunjuk ke soal header/signed-URL, sedangkan
      // 415 asli nunjuk ke soal proxy dipakai untuk endpoint non-media.
      if (!response.ok) {
        if (response.body) { try { await response.body.cancel(); } catch {} }
        return new Response(
          JSON.stringify({
            error: "Upstream media request failed",
            upstreamStatus: response.status,
            upstreamStatusText: response.statusText,
            hostname: targetUrl.hostname
          }),
          { status: response.status, headers: { ...corsHeaders(request), "Content-Type": "application/json", "X-Upstream-Status": String(response.status) } }
        );
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      // Sebagian edge CDN Koudaimh mengirim image bytes sebagai
      // application/octet-stream atau tanpa Content-Type. Host-nya tetap
      // sudah lolos allowlist, jadi izinkan tipe generik hanya untuk CDN
      // Koudaimh; host lain tetap wajib mengiklankan media type.
      const isMedia = contentType.startsWith("image/") || contentType.startsWith("video/") || contentType.startsWith("audio/") ||
        (isKoudaimhCdn && (!contentType || contentType === "application/octet-stream"));
      if (!isMedia) {
        if (response.body) { try { await response.body.cancel(); } catch {} }
        return new Response(
          JSON.stringify({ error: "Generic proxy only serves media (image/video/audio)", contentType: contentType || null, hostname: targetUrl.hostname }),
          { status: 415, headers: { ...corsHeaders(request), "Content-Type": "application/json" } }
        );
      }

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
// DIMATIKAN SEMENTARA (null) — worker ini dipakai buat percobaan fitur URL
// series di akun Cloudflare terpisah dari yang production, jadi belum ada
// satu domain frontend tetap yang pasti dipakai buat tes. Nyalakan lagi
// (isi domain frontend-nya) begitu fitur ini sudah matang dan mau dipindah
// ke worker production.
const ALLOWED_ORIGIN = null;  // dibuat null karena sedang masa percobaan

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
