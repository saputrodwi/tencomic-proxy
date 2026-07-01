export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);

    // Endpoint proxy gambar: /img?url=<image_url>
    if (url.pathname === "/img") {
      const imageUrl = url.searchParams.get("url");
      if (!imageUrl) {
        return jsonResp({ status: "error", message: "Parameter 'url' wajib diisi" }, 400);
      }
      try {
        const imgRes = await fetch(imageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://m.ac.qq.com/",
          },
        });
        const buf = await imgRes.arrayBuffer();
        return new Response(buf, {
          status: imgRes.status,
          headers: {
            "Content-Type": imgRes.headers.get("Content-Type") || "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (e) {
        return jsonResp({ status: "error", message: "Gagal fetch gambar: " + e.message }, 502);
      }
    }

    // Endpoint utama: /?url=<chapter_url>
    let chapterUrl = url.searchParams.get("url");
    if (!chapterUrl) {
      return jsonResp({ status: "error", message: "Parameter 'url' wajib diisi" }, 400);
    }

    // Konversi URL desktop ke URL mobile (konsisten, regex mobile lebih reliable)
    // https://ac.qq.com/ComicView/index/id/X/cid/Y  -> https://m.ac.qq.com/chapter/index/id/X/cid/Y
    chapterUrl = chapterUrl.replace(
      /^https?:\/\/ac\.qq\.com\/ComicView\//i,
      "https://m.ac.qq.com/chapter/"
    );
    // Jika masih pakai ac.qq.com/ComicView (mis. varian lain), paksa ke mobile
    if (/ac\.qq\.com\/ComicView/i.test(chapterUrl)) {
      chapterUrl = chapterUrl.replace(/ac\.qq\.com\/ComicView/i, "m.ac.qq.com/chapter");
    }
    // Pastikan pakai https
    chapterUrl = chapterUrl.replace(/^http:\/\//i, "https://");

    let html;
    try {
      const res = await fetch(chapterUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (!res.ok) {
        return jsonResp({ status: "error", message: "HTTP " + res.status + " dari " + chapterUrl }, res.status);
      }
      html = await res.text();
    } catch (e) {
      return jsonResp({ status: "error", message: "Gagal ambil HTML: " + e.message }, 500);
    }

    // Cari DATA - coba beberapa pola (mobile: data: '...', desktop: window.DATA="...")
    let dataMatch =
      html.match(/data\s*:\s*'(.+?)'/) ||
      html.match(/window\.DATA\s*=\s*"([^"]+)"/) ||
      html.match(/window\["DATA"\]\s*=\s*"([^"]+)"/) ||
      html.match(/var\s+DATA\s*=\s*'([^']+)'/) ||
      html.match(/var\s+DATA\s*=\s*"([^"]+)"/);

    if (!dataMatch) {
      return jsonResp({ status: "error", message: "DATA tidak ditemukan di HTML" }, 404);
    }
    const rawStr = dataMatch[1];

    // Cari NONCE - coba beberapa pola (mobile: data-mpmvr="...", desktop: window.nonce="...")
    let nonceMatch =
      html.match(/data-mpmvr="(.+?)"/) ||
      html.match(/window\[("|')nonce("|')\]\s*=\s*("|')([^"']+)("|')/) ||
      html.match(/window\.nonce\s*=\s*("|')([^"']+)("|')/);

    if (!nonceMatch) {
      return jsonResp({ status: "error", message: "NONCE tidak ditemukan di HTML" }, 404);
    }
    // Untuk pola data-mpmvr, group(1). Untuk pola window.nonce, group(2).
    const nonce = nonceMatch[1] || nonceMatch[2];

    // Decode DATA dengan nonce (algoritma Tencent Comic - versi hapus)
    function decodeData(data, nonce) {
      const t = data.split("");
      const tokens = nonce.match(/\d+[a-zA-Z]+/g) || [];
      // Loop dari AKHIR ke AWAL
      for (let i = tokens.length - 1; i >= 0; i--) {
        const m = tokens[i].match(/^(\d+)([a-zA-Z]+)$/);
        if (!m) continue;
        let locate = parseInt(m[1], 10) & 255; // bitwise AND 255
        const chars = m[2];
        // Hapus chars dari posisi locate
        t.splice(locate, chars.length);
      }
      const base64Str = t.join("");
      // Bersihkan karakter non-base64 jika ada
      const clean = base64Str.replace(/[^A-Za-z0-9+/=]/g, "");
      const jsonString = atob(clean);
      return JSON.parse(jsonString);
    }

    let result;
    try {
      result = decodeData(rawStr, nonce);
    } catch (e) {
      return jsonResp(
        { status: "error", message: "Gagal decode DATA: " + e.message, raw: rawStr.slice(0, 80), nonce: nonce },
        500
      );
    }

    const pictureList = result.picture || [];
    if (pictureList.length === 0) {
      return jsonResp({ status: "error", message: "Tidak ada gambar di chapter ini" }, 404);
    }

    const rawUrls = pictureList.map((p) => p.url);
    const proxyBase = url.origin + "/img?url=";
    const proxyUrls = rawUrls.map((u) => proxyBase + encodeURIComponent(u));

    const responseData = {
      status: "success",
      sourceUrl: chapterUrl,
      chapter: result.chapter || null,
      chapterName: result.chapterName || result.chapterNameCn || null,
      total: rawUrls.length,
      rawUrls,
      proxyUrls,
    };

    return new Response(JSON.stringify(responseData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};

// Helper response JSON
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
