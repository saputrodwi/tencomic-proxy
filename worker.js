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

    // === EXTRACT DATA ===
    let dataStr = null;
    const dataMatch = html.match(/var\s+DATA\s*=\s*'([\s\S]+?)'/) || 
                      html.match(/var\s+DATA\s*=\s*"([\s\S]+?)"/);
    if (dataMatch && dataMatch[1] && dataMatch[1].length > 100) {
      dataStr = dataMatch[1];
    }
    if (!dataStr) return jsonResp({ error: "DATA tidak ditemukan di HTML.", url: chapterUrl }, 404);

    // === EXTRACT NONCE ASSIGNMENTS ===
    const assignRegex = /(?:window\["no"\s*\+\s*"nce"\]|window\["n"\s*\+\s*"once"\]|window\["nonce"\]|window\.nonce|var\s+nonce)\s*=\s*([^;]+);/g;
    let matches = [];
    let m;
    while ((m = assignRegex.exec(html)) !== null) {
      matches.push({ index: m.index, expr: m[1].trim() });
    }

    // Sort descending to try the last assignment first (as it overwrites previous ones)
    matches.sort((a, b) => b.index - a.index);

    let result = null;
    let validNonce = null;

    for (const match of matches) {
      const evaluated = safeEval(match.expr);
      if (evaluated && evaluated.length >= 8) {
        try {
          const decoded = tryDecode(dataStr, evaluated);
          if (decoded && decoded.comic && decoded.picture) {
            result = decoded;
            validNonce = evaluated;
            break;
          }
        } catch (e) {
          // Invalid nonce, continue to next
        }
      }
    }

    // Fallback: Brute force if assignment extraction failed
    if (!result) {
      const candidates = new Set();
      const stringRegex = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
      let sm;
      while ((sm = stringRegex.exec(html)) !== null) {
        const s = sm[2];
        if (s.length >= 8 && s.length <= 100 && /\d/.test(s) && /[a-zA-Z]/.test(s)) {
          candidates.add(s);
        }
      }
      
      for (const candidate of candidates) {
        try {
          const decoded = tryDecode(dataStr, candidate);
          if (decoded && decoded.comic && decoded.picture) {
            result = decoded;
            validNonce = candidate;
            break;
          }
        } catch (e) {}
      }
    }

    if (!result) {
      return jsonResp({ 
        error: "Gagal decode DATA. Tidak ada kandidat nonce yang valid.",
        matchesFound: matches.length,
        hint: "Coba refresh halaman atau gunakan URL chapter yang berbeda"
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

function tryDecode(data, nonceStr) {
  const T = data.split('');
  const N = nonceStr.match(/\d+[a-zA-Z]+/g) || [];
  if (N.length === 0) return null;
  
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
  if (cleanStr.length < 10) return null;
  
  const padLen = (4 - (cleanStr.length % 4)) % 4;
  const paddedStr = cleanStr + "=".repeat(padLen);
  
  const binaryString = atob(paddedStr);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  
  return JSON.parse(new TextDecoder('utf-8').decode(bytes));
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
    } else { i++; }
  }
  
  let pos = 0;
  function parseExpr() {
    let node = parseTerm();
    while (pos < tokens.length && tokens[pos].type === 'OP' && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
      const op = tokens[pos++].value; const right = parseTerm();
      node = op === '+' ? node + right : node - right;
    }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (pos < tokens.length && tokens[pos].type === 'OP' && (tokens[pos].value === '*' || tokens[pos].value === '/')) {
      const op = tokens[pos++].value; const right = parseFactor();
      node = op === '*' ? node * right : node / right;
    }
    return node;
  }
  function parseFactor() {
    if (pos >= tokens.length) return 0;
    if (tokens[pos].type === 'OP' && tokens[pos].value === '(') {
      pos++; const node = parseExpr(); if (tokens[pos] && tokens[pos].value === ')') pos++; return node;
    }
    if (tokens[pos].type === 'OP' && tokens[pos].value === '-') { pos++; return -parseFactor(); }
    if (tokens[pos].type === 'OP' && tokens[pos].value === '+') { pos++; return parseFactor(); }
    return tokens[pos++].value;
  }
  return parseExpr();
}

function safeEval(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === ' ' || expr[i] === '\n' || expr[i] === '\r' || expr[i] === '\t') { i++; continue; }
    if (expr[i] === '"' || expr[i] === "'") {
      const quote = expr[i]; let str = ''; i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\') { i++; str += expr[i]; } else { str += expr[i]; }
        i++;
      }
      i++; tokens.push({ type: 'STRING', value: str });
    } else if (/[0-9]/.test(expr[i])) {
      let num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: 'NUMBER', value: parseFloat(num) });
    } else if ('+-*/().'.includes(expr[i])) {
      tokens.push({ type: 'OP', value: expr[i] }); i++;
    } else if (/[a-zA-Z_$]/.test(expr[i])) {
      let id = '';
      while (i < expr.length && /[a-zA-Z0-9_$]/.test(expr[i])) { id += expr[i]; i++; }
      tokens.push({ type: 'ID', value: id });
    } else { i++; }
  }

  let pos = 0;
  function peek(offset = 0) { return tokens[pos + offset]; }
  function consume() { return tokens[pos++]; }
  function expect(type, value) {
    const t = consume();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) throw new Error('Parse error');
    return t;
  }

  function parseExpr() {
    let left = parseTerm();
    while (peek() && peek().type === 'OP' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value; const right = parseTerm();
      if (op === '+') left = (typeof left === 'string' || typeof right === 'string') ? String(left) + String(right) : left + right;
      else left = left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() && peek().type === 'OP' && (peek().value === '*' || peek().value === '/')) {
      const op = consume().value; const right = parseFactor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseFactor() {
    let node; const t = peek();
    if (!t) throw new Error('Unexpected end');
    if (t.type === 'OP' && t.value === '(') { consume(); node = parseExpr(); expect('OP', ')'); }
    else if (t.type === 'STRING') { node = consume().value; }
    else if (t.type === 'NUMBER') { node = consume().value; }
    else if (t.type === 'ID') {
      const id = consume().value;
      if (id === 'eval') {
        expect('OP', '('); const arg = parseExpr(); expect('OP', ')');
        node = safeMathEval(String(arg));
      } else { node = 0; }
    } else if (t.type === 'OP' && (t.value === '+' || t.value === '-')) {
      const op = consume().value; node = parseFactor(); if (op === '-') node = -node;
    } else { throw new Error('Unexpected token'); }

    while (peek() && peek().type === 'OP' && peek().value === '.') {
      consume(); const method = expect('ID').value;
      if (method === 'toString') {
        expect('OP', '('); let radix = 10;
        if (peek() && peek().type === 'NUMBER') { radix = consume().value; }
        expect('OP', ')');
        if (typeof node === 'number') node = Math.round(node).toString(radix);
        else node = String(node);
      }
    }
    return node;
  }

  try { return String(parseExpr()); } catch (e) { return null; }
}
