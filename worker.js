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
        return new Response(JSON.stringify({ status: "error", message: "Parameter 'url' wajib diisi" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
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
        return new Response(JSON.stringify({ status: "error", message: "Gagal fetch gambar: " + e.message }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // Endpoint utama: /?url=<chapter_url>
    const chapterUrl = url.searchParams.get("url");

    if (!chapterUrl) {
      return new Response(JSON.stringify({ status: "error", message: "Parameter 'url' wajib diisi" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    let html;
    try {
      const res = await fetch(chapterUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (!res.ok) {
        return new Response(JSON.stringify({ status: "error", message: "HTTP " + res.status }), {
          status: res.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      html = await res.text();
    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: "Gagal ambil HTML: " + e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Cari DATA (coba beberapa pola)
    let dataMatch =
      html.match(/window\.DATA\s*=\s*"([^"]+)"/) ||
      html.match(/window\["DATA"\]\s*=\s*"([^"]+)"/) ||
      html.match(/var\s+DATA\s*=\s*"([^"]+)"/) ||
      html.match(/var\s+DATA\s*=\s*'([^']+)'/);

    if (!dataMatch) {
      return new Response(JSON.stringify({ status: "error", message: "DATA tidak ditemukan di HTML" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Cari nonce (coba beberapa pola)
    let nonceMatch =
      html.match(/window\[("|')nonce("|')\]\s*=\s*("|')([^"']+)("|')/) ||
      html.match(/window\.nonce\s*=\s*("|')([^"']+)("|')/) ||
      html.match(/var\s+nonce\s*=\s*("|')([^"']+)("|')/);

    if (!nonceMatch) {
      return new Response(JSON.stringify({ status: "error", message: "NONCE tidak ditemukan di HTML" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const rawBase64 = dataMatch[1];
    const nonce = nonceMatch[2] || nonceMatch[1];

    // Decode DATA dengan nonce (algoritma Tencent Comic)
    function decodeData(data, nonce) {
      const rawArr = data.split("");
      const tokens = nonce.match(/\d+[a-zA-Z]+/g);
      if (tokens) {
        for (let i = tokens.length - 1; i >= 0; i--) {
          const token = tokens[i];
          // Pisahkan angka (posisi) dan huruf (chars) dari akhir token
          const m = token.match(/^(\d+)([a-zA-Z]+)$/);
          if (!m) continue;
          const pos = parseInt(m[1], 10);
          const chars = m[2];
          // Hapus chars yang sebelumnya ditarik dari posisi tsb, lalu sisipkan kembali di pos asli
          // Algoritma Tencent: chars diambil dari rawArr[pos..pos+chars.length]
          // Untuk decode, kita sisipkan chars pada posisi 'pos' rawArr
          rawArr.splice(pos, 0, chars);
        }
      }
      const base64Str = rawArr.join("");
      // Bersihkan karakter non-base64
      const cleanBase64 = base64Str.replace(/[^A-Za-z0-9+/=]/g, "");
      const jsonString = atob(cleanBase64);
      return JSON.parse(jsonString);
    }

    let result;
    try {
      result = decodeData(rawBase64, nonce);
    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: "Gagal decode DATA: " + e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const pictureList = result.picture || [];
    if (pictureList.length === 0) {
      return new Response(JSON.stringify({ status: "error", message: "Tidak ada gambar di chapter ini" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const rawUrls = pictureList.map((p) => p.url);
    const proxyBase = url.origin + "/img?url=";
    const proxyUrls = rawUrls.map((u) => proxyBase + encodeURIComponent(u));

    const responseData = {
      status: "success",
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
