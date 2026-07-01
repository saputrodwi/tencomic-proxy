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

    // ===== Endpoint proxy gambar =====
    if (url.pathname === "/img") {
      const imageUrl = url.searchParams.get("url");
      if (!imageUrl) return jsonResp({ status: "error", message: "Parameter 'url' wajib diisi" }, 400);
      
      try {
        const imgRes = await fetch(imageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://ac.qq.com/",
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

    // ===== Endpoint utama =====
    let chapterUrl = url.searchParams.get("url");
    if (!chapterUrl) return jsonResp({ status: "error", message: "Parameter 'url' wajib diisi" }, 400);

    // KONVERSI MOBILE -> DESKTOP
    chapterUrl = chapterUrl.replace(/^https?:\/\/m\.ac\.qq\.com\/chapter\//i, "https://ac.qq.com/ComicView/");
    if (/m\.ac\.qq\.com\/chapter/i.test(chapterUrl)) {
      chapterUrl = chapterUrl.replace(/m\.ac\.qq\.com\/chapter/i, "ac.qq.com/ComicView");
    }
    chapterUrl = chapterUrl.replace(/^http:\/\//i, "https://");

    // FETCH HTML
    let html;
    try {
      const res = await fetch(chapterUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (!res.ok) return jsonResp({ status: "error", message: "HTTP " + res.status + " dari " + chapterUrl }, res.status);
      html = await res.text();
    } catch (e) {
      return jsonResp({ status: "error", message: "Gagal ambil HTML: " + e.message }, 500);
    }

    // ===== EXTRACT DATA =====
    let dataMatch =
      html.match(/var\s+DATA\s*=\s*'([^']+)'/) ||
      html.match(/var\s+DATA\s*=\s*"([^"]+)"/) ||
      html.match(/window\.DATA\s*=\s*"([^"]+)"/) ||
      html.match(/window\["DATA"\]\s*=\s*"([^"]+)"/);

    if (!dataMatch) {
      return jsonResp({
        status: "error",
        message: "DATA tidak ditemukan di HTML. Pastikan URL adalah chapter desktop (ac.qq.com/ComicView/...)",
        url: chapterUrl,
        hint: "Coba URL: https://ac.qq.com/ComicView/index/id/XXXX/cid/YY"
      }, 404);
    }
    const dataStr = dataMatch[1];

    // ===== EXTRACT & EVALUATE NONCE =====
    let nonce = null;
    let nonceExpr = null;

    const nonceStmtMatch = html.match(/window\["[^"]+"\s*\+\s*"[^"]+"\]\s*=\s*[^;]+;/);
    if (nonceStmtMatch) {
      const stmt = nonceStmtMatch[0];
      const exprM = stmt.match(/=\s*([\s\S]+?);\s*$/);
      if (exprM) {
        nonceExpr = exprM[1].trim();
      }
    }

    if (!nonceExpr) {
      const direct =
        html.match(/window\.nonce\s*=\s*['"]([^'"]+)['"]/) ||
        html.match(/data-mpmvr="([^"]+)"/) ||
        html.match(/window\["nonce"\]\s*=\s*['"]([^'"]+)['"]/);
      if (direct) nonce = direct[1] || direct[2];
    }

    if (nonceExpr && !nonce) {
      try {
        const fn = new Function(
          'window', 'Math', 'parseInt', 'Array', 'String', 'Number', 'Boolean', 'eval',
          'return (' + nonceExpr + ');'
        );
        nonce = fn(
          { Array, Math, parseInt, String, Number, Boolean },
          Math, parseInt, Array, String, Number, Boolean, eval
        );
      } catch (e) {
        return jsonResp({
          status: "error",
          message: "Gagal evaluasi nonce: " + e.message,
          nonceExpr: nonceExpr.slice(0, 300)
        }, 500);
      }
    }

    if (!nonce) {
      return jsonResp({
        status: "error",
        message: "NONCE tidak ditemukan di HTML atau gagal dievaluasi"
      }, 404);
    }

    // ===== DECODE DATA =====
    function decodeData(data, nonceStr) {
      const T = data.split('');
      const N = nonceStr.match(/\d+[a-zA-Z]+/g) || [];
      let len = N.length;
      while (len--) {
        const m = N[len].match(/^(\d+)([a-zA-Z]+)$/);
        if (!m) continue;
        const locate = parseInt(m[1], 10) & 255;
        const str = m[2];
        T.splice(locate, str.length);
      }
      const b64 = T.join('');
      return base64DecodeUtf8(b64);
    }

    function base64DecodeUtf8(str) {
      const keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const input = str.replace(/[^A-Za-z0-9+/=]/g, "");
      const bytes = [];
      let i = 0;
      while (i < input.length) {
        const enc1 = keyStr.indexOf(input.charAt(i++));
        const enc2 = keyStr.indexOf(input.charAt(i++));
        const enc3 = keyStr.indexOf(input.charAt(i++));
        const enc4 = keyStr.indexOf(input.charAt(i++));
        const b1 = (enc1 << 2) | (enc2 >> 4);
        const b2 = ((enc2 & 15) << 4) | (enc3 >> 2);
        const b3 = ((enc3 & 3) << 6) | enc4;
        bytes.push(b1);
        if (enc3 !== 64) bytes.push(b2);
        if (enc4 !== 64) bytes.push(b3);
      }
      const uint8 = new Uint8Array(bytes);
      const text = new TextDecoder('utf-8').decode(uint8);
      return JSON.parse(text);
    }

    let result;
    try {
      result = decodeData(dataStr, nonce);
    } catch (e) {
      return jsonResp({
        status: "error",
        message: "Gagal decode DATA: " + e.message,
        nonceSample: String(nonce).slice(0, 100),
        dataSample: dataStr.slice(0, 100)
      }, 500);
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
      comicTitle: (result.comic && result.comic.title) || null,
      chapterName: (result.chapter && result.chapter.cTitle) || null,
      chapterCid: (result.chapter && result.chapter.cid) || null,
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
  }
};

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
