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

    // === BULLETPROOF NONCE EXTRACTOR (Multi-Assignment Aware) ===
    const nonceRegexes = [
      /window\["no"\s*\+\s*"nce"\]\s*=\s*([^;]+);/g,
      /window\["no"\+"nce"\]\s*=\s*([^;]+);/g,
      /window\.nonce\s*=\s*([^;]+);/g,
      /window\["nonce"\]\s*=\s*([^;]+);/g
    ];

    let matches = [];
    for (const regex of nonceRegexes) {
      let m;
      while ((m = regex.exec(html)) !== null) {
        matches.push({ index: m.index, expr: m[1].trim() });
      }
    }

    // Urutkan berdasarkan posisi di HTML dan ambil yang TERAKHIR (karena JS menimpa variabel)
    matches.sort((a, b) => a.index - b.index);
    let nonce = null;

    if (matches.length > 0) {
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          const evaluated = evaluateNonceExpression(matches[i].expr);
          if (evaluated && evaluated.length >= 16) {
            nonce = evaluated;
            break;
          }
        } catch (e) {
          // continue to next match
        }
      }
    }

    if (!nonce) return jsonResp({ error: "NONCE tidak ditemukan atau gagal dievaluasi.", dataLength: dataStr.length }, 404);

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
      
      // Fix padding untuk atob() (Cloudflare sangat ketat soal ini)
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

function safeMathEval(str) {
  str = str.trim();
  
  // Handle boolean logic obfuscation (contoh: !!1*5 -> 1*5 -> 5)
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

function evaluateNonceExpression(expr) {
  let result = '';
  let i = 0;
  
  while (i < expr.length) {
    if (expr[i] === '"' || expr[i] === "'") {
      const quote = expr[i];
      let str = '';
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          i++;
          if (expr[i] === 'n') str += '\n';
          else if (expr[i] === 't') str += '\t';
          else if (expr[i] === 'r') str += '\r';
          else str += expr[i];
        } else {
          str += expr[i];
        }
        i++;
      }
      i++;
      result += str;
    }
    else if (expr.substring(i, i + 4) === 'eval') {
      const openParen = expr.indexOf('(', i);
      if (openParen !== -1) {
        const quoteEval = expr[openParen + 1];
        const closeQuote = expr.indexOf(quoteEval, openParen + 2);
        if (closeQuote !== -1) {
          const mathStr = expr.substring(openParen + 2, closeQuote);
          let val = safeMathEval(mathStr);
          
          let closeParen = expr.indexOf(')', closeQuote);
          let endIdx = closeParen + 1;
          
          if (expr.substring(endIdx, endIdx + 9) === '.toString') {
            const openT = expr.indexOf('(', endIdx + 9);
            if (openT !== -1) {
              const closeT = expr.indexOf(')', openT + 1);
              if (closeT !== -1 && closeT > openT + 1) {
                const radixStr = expr.substring(openT + 1, closeT).trim();
                const radix = parseInt(radixStr, 10) || 10;
                val = Math.round(val).toString(radix);
                endIdx = closeT + 1;
              } else {
                val = String(Math.round(val));
                endIdx = openT + 2;
              }
            }
          } else {
            val = String(val);
          }
          
          result += val;
          i = endIdx;
          continue;
        }
      }
      i++;
    }
    else {
      i++;
    }
  }
  
  return result;
}
