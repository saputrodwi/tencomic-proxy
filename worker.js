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

    // === CARI DATA DAN NONCE DI DALAM SCRIPT BLOCK YANG SAMA ===
    const scriptBlocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    
    let dataStr = null;
    let targetScript = null;

    for (const script of scriptBlocks) {
      if (/var\s+DATA\s*=|window\.DATA\s*=|window\["DATA"\]\s*=/.test(script)) {
        const dataMatch = script.match(/var\s+DATA\s*=\s*'([\s\S]+?)'/) ||
                          script.match(/var\s+DATA\s*=\s*"([\s\S]+?)"/) ||
                          script.match(/window\.DATA\s*=\s*"([\s\S]+?)"/) ||
                          script.match(/window\["DATA"\]\s*=\s*"([\s\S]+?)"/);
        if (dataMatch && dataMatch[1] && dataMatch[1].length > 100) {
          dataStr = dataMatch[1];
          targetScript = script;
          break;
        }
      }
    }

    if (!dataStr || !targetScript) return jsonResp({ error: "DATA tidak ditemukan di HTML.", url: chapterUrl }, 404);

    // === EKSTRAK NONCE DARI TARGET SCRIPT ===
    let nonce = null;

    // Strategi 1: Cari string literal langsung
    const directPatterns = [
      /window\["no"\s*\+\s*"nce"\]\s*=\s*['"]([^'"]+)['"]/,
      /window\["nonce"\]\s*=\s*['"]([^'"]+)['"]/,
      /window\.nonce\s*=\s*['"]([^'"]+)['"]/,
      /var\s+nonce\s*=\s*['"]([^'"]+)['"]/,
      /nonce\s*=\s*['"]([^'"]+)['"]/
    ];

    for (const pattern of directPatterns) {
      const m = targetScript.match(pattern);
      if (m && m[1] && m[1].length >= 16) {
        nonce = m[1];
        break;
      }
    }

    // Strategi 2: Jika ada expression dengan eval() atau concatenation
    if (!nonce) {
      const exprPatterns = [
        /window\["no"\s*\+\s*"nce"\]\s*=\s*([^;]+);/,
        /window\["nonce"\]\s*=\s*([^;]+);/,
        /window\.nonce\s*=\s*([^;]+);/,
        /var\s+nonce\s*=\s*([^;]+);/,
        /nonce\s*=\s*([^;]+);/
      ];

      for (const pattern of exprPatterns) {
        const m = targetScript.match(pattern);
        if (m && m[1]) {
          const expr = m[1].trim();
          
          const stringMatches = [...expr.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)];
          const strings = stringMatches.map(match => match[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
          
          const evalMatch = expr.match(/eval\s*\(\s*['"]([^'"]+)['"]\s*\)/);
          let evalResult = '';
          if (evalMatch) {
            try {
              let val = safeMathEval(evalMatch[1]);
              const radixMatch = expr.match(/\.toString\s*\(\s*(\d+)\s*\)/);
              if (radixMatch) {
                const radix = parseInt(radixMatch[1], 10);
                evalResult = Math.round(val).toString(radix);
              } else {
                evalResult = String(val);
              }
            } catch (e) {}
          }
          
          if (strings.length > 0) {
            const mainStrings = strings.filter(s => s.length > 3 && s !== evalMatch?.[1]);
            if (mainStrings.length >= 2 && evalResult) {
              nonce = mainStrings[0] + evalResult + mainStrings[1];
            } else if (mainStrings.length === 1 && evalResult) {
              nonce = mainStrings[0] + evalResult;
            } else if (mainStrings.length > 0) {
              nonce = mainStrings.join('');
            }
          }
          
          if (nonce && nonce.length >= 16) break;
        }
      }
    }

    // Strategi 3: Fallback - cari MD5 hash (32 hex chars) di targetScript
    if (!nonce) {
      const md5Match = targetScript.match(/['"]([a-f0-9]{32})['"]/i);
      if (md5Match) nonce = md5Match[1];
    }

    // Strategi 4: Fallback - cari string alphanumeric 16-100 chars dengan pola \d+[a-zA-Z]+
    if (!nonce) {
      const allStrings = [...targetScript.matchAll(/['"]([a-zA-Z0-9]{16,100})['"]/g)].map(m => m[1]);
      for (const s of allStrings) {
        if (/\d+[a-zA-Z]+/.test(s) && (s.match(/\d+[a-zA-Z]+/g) || []).length >= 3) {
          nonce = s;
          break;
        }
      }
    }

    if (!nonce) return jsonResp({ 
      error: "NONCE tidak ditemukan di dalam script block DATA.",
      scriptSnippet: targetScript.substring(0, 500)
    }, 404);

    // === DECODE DATA ===
    function decodeData(data, nonceStr) {
      const T = data.split('');
      const N = nonceStr.match(/\d+[a-zA-Z]+/g) || [];
      
      if (N.length === 0) throw new Error("Nonce tidak memiliki pola \\d+[a-zA-Z]+. Nonce: '" + nonceStr + "'");

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
      
      const padLen = (4 - (cleanStr.length % 4)) % 4;
      const paddedStr = cleanStr + "=".repeat(padLen);
      
      if (paddedStr.length < 10) throw new Error("Base64 terlalu pendek: " + paddedStr);
      
      const binaryString = atob(paddedStr);
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
        dataSample: dataStr.substring(0, 100),
        scriptSnippet: targetScript.substring(0, 300)
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

function safeMathEval(str) {
  str = str.trim();
  str = str.replace(/!!([0-9.]+)/g, (m, p1) => parseFloat(p1) !== 0 ? '1' : '0');
  str = str.replace(/!([0-9.]+)/g, (m, p1) => parseFloat(p1) !== 0 ? '0' : '1');
  str = str.replace(/!!true/g, '1').replace(/!!false/g, '0');
  str = str.replace(/!true/g, '0').replace(/!false/g, '1');
  str = str.replace(/true/g, '1').replace(/false/g, '0');
  
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === ' ') { i++; continue; }
    if (/[0-9.]/.test(str[i])) {
      let num = '';
      while (i < str.length && /[0-9.]/.test(str[i])) { num += str[i]; i++; }
      tokens.push({ type: 'NUM', value: parseFloat(num) });
    } else if ('+-*/()'.includes(str[i])) {
      tokens.push({ type: 'OP', value: str[i] });
      i++;
    } else {
      i++;
    }
  }
  
  let pos = 0;
  function parseExpr() {
    let node = parseTerm();
    while (pos < tokens.length && tokens[pos].type === 'OP' && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      node = op === '+' ? node + right : node - right;
    }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (pos < tokens.length && tokens[pos].type === 'OP' && (tokens[pos].value === '*' || tokens[pos].value === '/')) {
      const op = tokens[pos++].value;
      const right = parseFactor();
      node = op === '*' ? node * right : node / right;
    }
    return node;
  }
  function parseFactor() {
    if (pos >= tokens.length) return 0;
    if (tokens[pos].type === 'OP' && tokens[pos].value === '(') {
      pos++; const node = parseExpr(); if (tokens[pos] && tokens[pos].value === ')') pos++; return node;
    }
    if (tokens[pos].type === 'OP' && tokens[pos].value === '-') {
      pos++; return -parseFactor();
    }
    if (tokens[pos].type === 'OP' && tokens[pos].value === '+') {
      pos++; return parseFactor();
    }
    return tokens[pos++].value;
  }
  
  return parseExpr();
}
