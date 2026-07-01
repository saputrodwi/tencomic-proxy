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
      if (!imageUrl) return jsonResp({ status: "error", message: "Parameter 'url' wajib diisi" }, 400);
      try {
        const imgRes = await fetch(imageUrl, {
          headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://ac.qq.com/" },
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

    let chapterUrl = url.searchParams.get("url");
    if (!chapterUrl) return jsonResp({ status: "error", message: "Parameter 'url' wajib diisi" }, 400);

    chapterUrl = chapterUrl.replace(/^https?:\/\/m\.ac\.qq\.com\/chapter\//i, "https://ac.qq.com/ComicView/");
    if (/m\.ac\.qq\.com\/chapter/i.test(chapterUrl)) {
      chapterUrl = chapterUrl.replace(/m\.ac\.qq\.com\/chapter/i, "ac.qq.com/ComicView");
    }
    chapterUrl = chapterUrl.replace(/^http:\/\//i, "https://");

    let html;
    try {
      const res = await fetch(chapterUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      });
      if (!res.ok) return jsonResp({ status: "error", message: "HTTP " + res.status }, res.status);
      html = await res.text();
    } catch (e) {
      return jsonResp({ status: "error", message: "Gagal ambil HTML: " + e.message }, 500);
    }

    let dataMatch =
      html.match(/var\s+DATA\s*=\s*'([^']+)'/) ||
      html.match(/var\s+DATA\s*=\s*"([^"]+)"/) ||
      html.match(/window\.DATA\s*=\s*"([^"]+)"/) ||
      html.match(/window\["DATA"\]\s*=\s*"([^"]+)"/);

    if (!dataMatch) return jsonResp({ status: "error", message: "DATA tidak ditemukan." }, 404);
    const dataStr = dataMatch[1];

    // === TARGETED NONCE EXTRACTOR (Bypass CSP & Obfuscation) ===
    let nonce = null;
    const assignMatch = 
      html.match(/window\["no"\s*\+\s*"nce"\]\s*=\s*([^;]+);/) ||
      html.match(/window\.nonce\s*=\s*([^;]+);/) ||
      html.match(/window\["nonce"\]\s*=\s*([^;]+);/);

    if (assignMatch) {
      const expr = assignMatch[1];
      const strings = [...expr.matchAll(/"([^"]*)"/g)].map(m => m[1]);
      const evalMatch = expr.match(/eval\s*\(\s*"([^"]+)"\s*\)/);
      
      if (evalMatch) {
        const mathExpr = evalMatch[1];
        let val = 0;
        try { val = safeMathEval(mathExpr); } catch (e) {}
        
        const radixMatch = expr.match(/toString\s*\(\s*(\d+)\s*\)/);
        const radix = radixMatch ? parseInt(radixMatch[1], 10) : 10;
        
        let valStr = radix === 16 ? Math.round(val).toString(16) : String(val);
        if (valStr.endsWith('.0')) valStr = valStr.slice(0, -2);
        
        const literalStrings = strings.filter(s => s !== mathExpr);
        if (literalStrings.length >= 2) nonce = literalStrings[0] + valStr + literalStrings[literalStrings.length - 1];
        else if (literalStrings.length === 1) nonce = literalStrings[0] + valStr;
        else nonce = valStr;
      } else {
        nonce = strings.join('');
      }
    }

    if (!nonce) {
      const fallback = html.match(/data-mpmvr="([^"]+)"/) || html.match(/nonce\s*[:=]\s*['"]([^'"]+)['"]/i);
      if (fallback) nonce = fallback[1];
    }

    if (!nonce) return jsonResp({ status: "error", message: "NONCE gagal diekstrak." }, 404);

    // === DECODE DATA (Logika Asli Tencent) ===
    function decodeData(data, nonceStr) {
      const T = data.split('');
      const N = nonceStr.match(/\d+[a-zA-Z]+/g) || [];
      if (N.length === 0) throw new Error("Nonce tidak valid: " + nonceStr);
      
      let len = N.length;
      while (len--) {
        const locate = parseInt(N[len], 10) & 255;
        const str = N[len].replace(/\d+/g, '');
        T.splice(locate, str.length);
      }
      
      const b64 = T.join('');
      const cleanStr = b64.replace(/[^A-Za-z0-9+/=]/g, "");
      const binaryString = atob(cleanStr);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    }

    let result;
    try {
      result = decodeData(dataStr, nonce);
    } catch (e) {
      return jsonResp({ status: "error", message: "Gagal decode: " + e.message, nonce }, 500);
    }

    const pictureList = result.picture || [];
    if (pictureList.length === 0) return jsonResp({ status: "error", message: "Tidak ada gambar." }, 404);

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

function safeMathEval(str) {
  const tokens = str.match(/(\d+\.\d+|\d+|[+\-*/()])/g);
  if (!tokens) return 0;
  let pos = 0;
  function parseExpr() {
    let node = parseTerm();
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++]; const right = parseTerm();
      node = op === '+' ? node + right : node - right;
    }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++]; const right = parseFactor();
      node = op === '*' ? node * right : node / right;
    }
    return node;
  }
  function parseFactor() {
    if (tokens[pos] === '(') { pos++; const node = parseExpr(); pos++; return node; }
    if (tokens[pos] === '-') { pos++; return -parseFactor(); }
    return parseFloat(tokens[pos++]);
  }
  return parseExpr();
}
