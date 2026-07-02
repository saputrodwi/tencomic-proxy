export default {
  async fetch(request) {
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

    if (url.pathname === "/img") {
      const imageUrl = url.searchParams.get("url");
      if (!imageUrl) return jsonResp({ error: "Parameter 'url' wajib diisi" }, 400);
      try {
        const imgRes = await fetch(imageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Referer": "https://ac.qq.com/",
          },
        });
        const buf = await imgRes.arrayBuffer();
        return new Response(buf, {
          status: imgRes.status,
          headers: {
            "Content-Type": imgRes.headers.get("Content-Type") || "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      } catch (e) {
        return jsonResp({ error: "Gagal fetch gambar: " + e.message }, 502);
      }
    }

    let chapterUrl = url.searchParams.get("url");
    if (!chapterUrl) return jsonResp({ error: "Parameter 'url' wajib diisi." }, 400);

    chapterUrl = chapterUrl
      .replace(/^https?:\/\/m\.ac\.qq\.com\/chapter\//i, "https://ac.qq.com/ComicView/")
      .replace(/m\.ac\.qq\.com\/chapter/i, "ac.qq.com/ComicView")
      .replace(/^http:\/\//i, "https://");

    let html;
    try {
      const res = await fetch(chapterUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (!res.ok) return jsonResp({ error: "HTTP " + res.status + " dari " + chapterUrl }, res.status);
      html = await res.text();
    } catch (e) {
      return jsonResp({ error: "Gagal ambil HTML: " + e.message }, 500);
    }

    let dataStr = null;
    const dataRegexes = [
      /var\s+DATA\s*=\s*'([\s\S]+?)'/,
      /var\s+DATA\s*=\s*"([\s\S]+?)"/,
      /window\.DATA\s*=\s*"([\s\S]+?)"/,
      /window\["DATA"\]\s*=\s*"([\s\S]+?)"/,
    ];
    for (const r of dataRegexes) {
      const m = html.match(r);
      if (m && m[1] && m[1].length > 100) {
        dataStr = m[1];
        break;
      }
    }
    if (!dataStr) return jsonResp({ error: "DATA tidak ditemukan di HTML.", url: chapterUrl }, 404);

    // === BULLETPROOF NONCE EXTRACTOR ===
    // Alih-alih mengevaluasi JS yang rumit, kita langsung mencari string literal di dalam <script> tag
    let nonce = null;
    const scriptBlocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    let targetScript = null;
    
    for (const script of scriptBlocks) {
      if (script.includes('DATA') && (script.includes('nonce') || script.includes('nce'))) {
        targetScript = script;
        break;
      }
    }
    if (!targetScript) {
      for (const script of scriptBlocks) {
        if (script.includes('DATA')) {
          targetScript = script;
          break;
        }
      }
    }
    
    if (targetScript) {
      const strings = [];
      const regex = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
      let m;
      while ((m = regex.exec(targetScript)) !== null) {
        strings.push(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      }
      
      // Nonce biasanya panjangnya 32 karakter (MD5) atau sekitar 50-100 karakter.
      // DATA panjangnya ribuan karakter, jadi kita filter yang < 500 karakter.
      const candidates = strings.filter(s => 
        s.length >= 16 && 
        s.length < 500 && 
        /^[a-zA-Z0-9]+$/.test(s) &&
        /\d/.test(s) && 
        /[a-zA-Z]/.test(s)
      );
      
      if (candidates.length > 0) {
        nonce = candidates.find(s => (s.match(/\d+[a-zA-Z]+/g) || []).length >= 3) || candidates[0];
      }
    }

    if (!nonce) {
      const directMatches = [
        html.match(/window\["no"\s*\+\s*"nce"\]\s*=\s*(?:''\s*\+\s*)?['"]([^'"]{16,})['"]/),
        html.match(/window\["n"\s*\+\s*"once"\]\s*=\s*(?:''\s*\+\s*)?['"]([^'"]{16,})['"]/),
        html.match(/window\.nonce\s*=\s*['"]([^'"]{16,})['"]/),
        html.match(/window\["nonce"\]\s*=\s*['"]([^'"]{16,})['"]/)
      ];
      for (const m of directMatches) {
        if (m && m[1]) {
          nonce = m[1];
          break;
        }
      }
    }

    if (!nonce) return jsonResp({ error: "NONCE tidak ditemukan.", dataLength: dataStr.length }, 404);

    // === DECODE DATA ===
    function decodeData(data, nonceStr) {
      const T = data.split('');
      const N = nonceStr.match(/\d+[a-zA-Z]+/g) || [];
      
      if (N.length === 0) throw new Error("Nonce tidak valid: " + nonceStr);

      for (let i = N.length - 1; i >= 0; i--) {
        const token = N[i];
        const numMatch = token.match(/^(\d+)/);
        const strMatch = token.match(/[a-zA-Z]+/);
        if (!numMatch || !strMatch) continue;
        
        const locate = parseInt(numMatch[1], 10) & 255;
        const str = strMatch[0];
        T.splice(locate, str.length);
      }
      
      const b64 = T.join('');
      const cleanStr = b64.replace(/[^A-Za-z0-9+/=]/g, "");
      
      if (cleanStr.length < 10) throw new Error("Base64 terlalu pendek: " + cleanStr);
      
      const binaryString = atob(cleanStr);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    }

    let result;
    try {
      result = decodeData(dataStr, nonce);
    } catch (e) {
      return jsonResp({
        error: "Gagal decode DATA: " + e.message,
        nonce: nonce,
        dataSample: dataStr.substring(0, 100)
      }, 500);
    }

    const pictureList = result.picture || [];
    if (pictureList.length === 0) return jsonResp({ error: "Tidak ada gambar." }, 404);

    const rawUrls = pictureList.map((p) => p.url);
    const proxyBase = url.origin + "/img?url=";
    const proxyUrls = rawUrls.map((u) => proxyBase + encodeURIComponent(u));

    return new Response(JSON.stringify({
      status: "success",
      sourceUrl: chapterUrl,
      comicTitle: (result.comic && result.comic.title) || null,
      chapterName: (result.chapter && result.chapter.cTitle) || null,
      total: rawUrls.length,
      proxyUrls,
    }, null, 2), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
    });
  }
};

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
