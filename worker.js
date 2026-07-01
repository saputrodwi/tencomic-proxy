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
    const chapterUrlParam = url.searchParams.get("url");

    // ===== Endpoint proxy gambar =====
    if (url.pathname === "/img") {
      const imageUrl = url.searchParams.get("url");
      if (!imageUrl) return jsonResp({ error: "Parameter 'url' wajib diisi" }, 400);
      try {
        const imgRes = await fetch(imageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Referer": "https://ac.qq.com/",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
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

    // ===== Endpoint Debug =====
    if (url.pathname === "/debug" && chapterUrlParam) {
      let debugUrl = chapterUrlParam
        .replace(/^https?:\/\/m\.ac\.qq\.com\/chapter\//i, "https://ac.qq.com/ComicView/")
        .replace(/m\.ac\.qq\.com\/chapter/i, "ac.qq.com/ComicView")
        .replace(/^http:\/\//i, "https://");
      
      const res = await fetch(debugUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      const html = await res.text();
      
      const dataMatches = [];
      const regexes = [
        /var\s+DATA\s*=\s*'([\s\S]+?)'/g,
        /var\s+DATA\s*=\s*"([\s\S]+?)"/g,
        /window\.DATA\s*=\s*"([\s\S]+?)"/g,
        /window\["DATA"\]\s*=\s*"([\s\S]+?)"/g,
      ];
      regexes.forEach(r => {
        let m;
        while ((m = r.exec(html)) !== null) dataMatches.push({ regex: r.source, match: m[1].substring(0, 200) });
      });
      
      const nonceMatches = [];
      const nonceRegexes = [
        /window\["no"\s*\+\s*"nce"\]\s*=\s*([\s\S]+?);/g,
        /window\.nonce\s*=\s*([\s\S]+?);/g,
        /window\["nonce"\]\s*=\s*([\s\S]+?);/g,
        /data-mpmvr="([^"]+)"/g,
        /nonce\s*[:=]\s*['"]([^'"]+)['"]/gi,
      ];
      nonceRegexes.forEach(r => {
        let m;
        while ((m = r.exec(html)) !== null) nonceMatches.push({ regex: r.source, match: m[1].substring(0, 300) });
      });
      
      return jsonResp({
        url: debugUrl,
        htmlLength: html.length,
        dataMatches,
        nonceMatches,
        htmlSnippet: html.substring(0, 2000),
      });
    }

    // ===== Endpoint utama =====
    if (!chapterUrlParam) return jsonResp({ error: "Parameter 'url' wajib diisi. Contoh: ?url=https://ac.qq.com/ComicView/index/id/657667/cid/141855" }, 400);

    let chapterUrl = chapterUrlParam
      .replace(/^https?:\/\/m\.ac\.qq\.com\/chapter\//i, "https://ac.qq.com/ComicView/")
      .replace(/m\.ac\.qq\.com\/chapter/i, "ac.qq.com/ComicView")
      .replace(/^http:\/\//i, "https://");

    // FETCH HTML
    let html;
    try {
      const res = await fetch(chapterUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
        },
      });
      if (!res.ok) return jsonResp({ error: "HTTP " + res.status + " dari " + chapterUrl }, res.status);
      html = await res.text();
    } catch (e) {
      return jsonResp({ error: "Gagal ambil HTML: " + e.message }, 500);
    }

    // ===== EXTRACT DATA =====
    let dataStr = null;
    const dataRegexes = [
      /var\s+DATA\s*=\s*'([\s\S]+?)'/,
      /var\s+DATA\s*=\s*"([\s\S]+?)"/,
      /window\.DATA\s*=\s*"([\s\S]+?)"/,
      /window\["DATA"\]\s*=\s*"([\s\S]+?)"/,
      /DATA\s*=\s*'([\s\S]+?)'/,
      /DATA\s*=\s*"([\s\S]+?)"/,
    ];
    for (const r of dataRegexes) {
      const m = html.match(r);
      if (m && m[1] && m[1].length > 100) {
        dataStr = m[1];
        break;
      }
    }
    if (!dataStr) return jsonResp({ error: "DATA tidak ditemukan di HTML.", url: chapterUrl }, 404);

    // ===== EXTRACT NONCE =====
    let nonce = null;
    let nonceExpr = null;
    
    // Strategi 1: Cari nonce expression yang perlu dievaluasi
    const exprRegexes = [
      /window\["no"\s*\+\s*"nce"\]\s*=\s*([\s\S]+?);/,
      /window\["nonce"\]\s*=\s*([\s\S]+?);/,
      /window\.nonce\s*=\s*([\s\S]+?);/,
    ];
    for (const r of exprRegexes) {
      const m = html.match(r);
      if (m && m[1]) {
        nonceExpr = m[1].trim();
        break;
      }
    }
    
    // Strategi 2: Cari nonce langsung (string literal)
    if (!nonceExpr) {
      const directRegexes = [
        /window\["no"\s*\+\s*"nce"\]\s*=\s*['"]([^'"]+)['"]/,
        /window\["nonce"\]\s*=\s*['"]([^'"]+)['"]/,
        /window\.nonce\s*=\s*['"]([^'"]+)['"]/,
        /data-mpmvr="([^"]+)"/,
        /nonce\s*[:=]\s*['"]([^'"]+)['"]/i,
      ];
      for (const r of directRegexes) {
        const m = html.match(r);
        if (m && m[1]) {
          nonce = m[1];
          break;
        }
      }
    }
    
    // Strategi 3: Evaluasi expression jika ditemukan
    if (nonceExpr && !nonce) {
      try {
        nonce = evaluateNonceExpression(nonceExpr);
        if (nonce !== null && nonce !== undefined) {
          nonce = String(nonce);
        }
      } catch (e) {
        // Fallback: coba extract string dari expression
        const strings = [...nonceExpr.matchAll(/"([^"]*)"/g)].map(m => m[1]);
        const singleStrings = [...nonceExpr.matchAll(/'([^']*)'/g)].map(m => m[1]);
        const allStrings = [...strings, ...singleStrings];
        
        // Coba evaluasi math sederhana
        const evalMatch = nonceExpr.match(/eval\s*\(\s*"([^"]+)"\s*\)/);
        let mathResult = '';
        if (evalMatch) {
          try {
            mathResult = String(evaluateMath(evalMatch[1]));
          } catch (e2) {}
        }
        
        // Gabungkan
        if (allStrings.length > 0) {
          if (mathResult) {
            nonce = allStrings.join('') + mathResult;
          } else {
            nonce = allStrings.join('');
          }
        }
      }
    }
    
    // Strategi 4: Cari di dalam script tag dengan pola acak
    if (!nonce) {
      const scriptMatches = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
      for (const script of scriptMatches) {
        const m = script.match(/['"]([^'"]{20,50})['"]/);
        if (m && m[1] && /\d+[a-zA-Z]/.test(m[1])) {
          nonce = m[1];
          break;
        }
      }
    }

    if (!nonce) {
      return jsonResp({ 
        error: "NONCE tidak ditemukan. Coba endpoint /debug?url=... untuk melihat HTML mentah.",
        dataLength: dataStr.length,
        htmlLength: html.length,
      }, 404);
    }

    // ===== DECODE DATA =====
    function decodeData(data, nonceStr) {
      const T = data.split('');
      const N = nonceStr.match(/\d+[a-zA-Z]+/g) || [];
      
      if (N.length === 0) {
        throw new Error("Nonce tidak memiliki pola \\d+[a-zA-Z]+. Nonce: '" + nonceStr + "'");
      }

      // Loop dari belakang (penting!)
      for (let i = N.length - 1; i >= 0; i--) {
        const token = N[i];
        const numMatch = token.match(/^(\d+)/);
        const strMatch = token.match(/[a-zA-Z]+/);
        
        if (!numMatch || !strMatch) continue;
        
        const locate = parseInt(numMatch[1], 10) & 255;
        const str = strMatch[0];
        
        // Hapus karakter dari array
        T.splice(locate, str.length);
      }
      
      const b64 = T.join('');
      const cleanStr = b64.replace(/[^A-Za-z0-9+/=]/g, "");
      
      if (cleanStr.length < 10) {
        throw new Error("Base64 terlalu pendek setelah cleaning: '" + cleanStr + "'");
      }
      
      // Decode base64
      let decoded;
      try {
        const binaryString = atob(cleanStr);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        decoded = new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        throw new Error("Base64 decode gagal: " + e.message + ". Clean string: '" + cleanStr.substring(0, 100) + "'");
      }
      
      // Parse JSON
      try {
        return JSON.parse(decoded);
      } catch (e) {
        throw new Error("JSON parse gagal: " + e.message + ". Decoded start: '" + decoded.substring(0, 100) + "'");
      }
    }

    let result;
    try {
      result = decodeData(dataStr, nonce);
    } catch (e) {
      return jsonResp({
        error: "Gagal decode DATA: " + e.message,
        nonce: nonce,
        nonceExpr: nonceExpr || "null",
        dataLength: dataStr.length,
        dataSample: dataStr.substring(0, 200),
        hint: "Coba endpoint /debug?url=" + encodeURIComponent(chapterUrl) + " untuk melihat HTML mentah"
      }, 500);
    }

    const pictureList = result.picture || [];
    if (pictureList.length === 0) {
      return jsonResp({ error: "Tidak ada gambar di chapter ini" }, 404);
    }

    const rawUrls = pictureList.map((p) => p.url);
    const proxyBase = url.origin + "/img?url=";
    const proxyUrls = rawUrls.map((u) => proxyBase + encodeURIComponent(u));

    return new Response(JSON.stringify({
      status: "success",
      sourceUrl: chapterUrl,
      comicTitle: (result.comic && result.comic.title) || null,
      chapterName: (result.chapter && result.chapter.cTitle) || null,
      total: rawUrls.length,
      rawUrls,
      proxyUrls,
    }, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }
};

// ===== HELPER FUNCTIONS =====

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Evaluasi ekspresi matematika sederhana (hanya +, -, *, /, parentheses)
function evaluateMath(expr) {
  expr = expr.trim();
  
  // Tokenize
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === ' ') { i++; continue; }
    
    if (/[0-9.]/.test(expr[i])) {
      let num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: 'NUMBER', value: parseFloat(num) });
      continue;
    }
    
    if ('+-*/()'.includes(expr[i])) {
      tokens.push({ type: 'OP', value: expr[i] });
      i++;
      continue;
    }
    
    i++;
  }
  
  // Parse
  let pos = 0;
  
  function parseExpression() {
    let left = parseTerm();
    while (pos < tokens.length && tokens[pos].type === 'OP' && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  
  function parseTerm() {
    let left = parseFactor();
    while (pos < tokens.length && tokens[pos].type === 'OP' && (tokens[pos].value === '*' || tokens[pos].value === '/')) {
      const op = tokens[pos++].value;
      const right = parseFactor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }
  
  function parseFactor() {
    if (pos >= tokens.length) throw new Error('Unexpected end');
    
    if (tokens[pos].type === 'OP' && tokens[pos].value === '(') {
      pos++;
      const result = parseExpression();
      if (pos < tokens.length && tokens[pos].type === 'OP' && tokens[pos].value === ')') pos++;
      return result;
    }
    
    if (tokens[pos].type === 'OP' && tokens[pos].value === '-') {
      pos++;
      return -parseFactor();
    }
    
    if (tokens[pos].type === 'OP' && tokens[pos].value === '+') {
      pos++;
      return parseFactor();
    }
    
    if (tokens[pos].type === 'NUMBER') {
      return tokens[pos++].value;
    }
    
    throw new Error('Unexpected token: ' + JSON.stringify(tokens[pos]));
  }
  
  return parseExpression();
}

// Evaluasi ekspresi nonce yang kompleks
function evaluateNonceExpression(expr) {
  const tokens = [];
  let i = 0;
  
  // Tokenize
  while (i < expr.length) {
    if (expr[i] === ' ' || expr[i] === '\n' || expr[i] === '\r' || expr[i] === '\t') { i++; continue; }
    
    // String literal
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
      i++; // skip closing quote
      tokens.push({ type: 'STRING', value: str });
      continue;
    }
    
    // Number literal
    if (/[0-9]/.test(expr[i]) || (expr[i] === '.' && i + 1 < expr.length && /[0-9]/.test(expr[i+1]))) {
      let num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: 'NUMBER', value: parseFloat(num) });
      continue;
    }
    
    // Identifier
    if (/[a-zA-Z_$]/.test(expr[i])) {
      let id = '';
      while (i < expr.length && /[a-zA-Z0-9_$]/.test(expr[i])) {
        id += expr[i];
        i++;
      }
      tokens.push({ type: 'ID', value: id });
      continue;
    }
    
    // Operators
    if ('+-*/().,'.includes(expr[i])) {
      tokens.push({ type: 'OP', value: expr[i] });
      i++;
      continue;
    }
    
    i++;
  }
  
  // Parse
  let pos = 0;
  
  function peek(offset = 0) { return tokens[pos + offset]; }
  function consume() { return tokens[pos++]; }
  function expect(type, value) {
    const t = consume();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${type}${value ? ' ' + value : ''}`);
    }
    return t;
  }
  
  function parseExpression() {
    let left = parseTerm();
    while (peek() && peek().type === 'OP' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      if (op === '+') {
        left = (typeof left === 'string' || typeof right === 'string') 
          ? String(left) + String(right) 
          : left + right;
      } else {
        left = left - right;
      }
    }
    return left;
  }
  
  function parseTerm() {
    let left = parseFactor();
    while (peek() && peek().type === 'OP' && (peek().value === '*' || peek().value === '/')) {
      const op = consume().value;
      const right = parseFactor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }
  
  function parseFactor() {
    const t = peek();
    if (!t) throw new Error('Unexpected end');
    
    // Unary operators
    if (t.type === 'OP' && (t.value === '+' || t.value === '-')) {
      const op = consume().value;
      const factor = parseFactor();
      return op === '+' ? factor : -factor;
    }
    
    // Parenthesized expression
    if (t.type === 'OP' && t.value === '(') {
      consume();
      const result = parseExpression();
      expect('OP', ')');
      return parsePostfix(result);
    }
    
    // String literal
    if (t.type === 'STRING') {
      consume();
      return parsePostfix(t.value);
    }
    
    // Number literal
    if (t.type === 'NUMBER') {
      consume();
      return parsePostfix(t.value);
    }
    
    // Identifier (function call or property access)
    if (t.type === 'ID') {
      return parseIdentifier();
    }
    
    throw new Error('Unexpected token: ' + JSON.stringify(t));
  }
  
  function parseIdentifier() {
    const id = consume().value;
    let obj = resolveIdentifier(id);
    
    // Handle dot notation
    while (peek() && peek().type === 'OP' && peek().value === '.') {
      consume(); // skip '.'
      const prop = expect('ID').value;
      
      if (peek() && peek().type === 'OP' && peek().value === '(') {
        // Method call
        consume(); // skip '('
        const args = [];
        if (peek() && !(peek().type === 'OP' && peek().value === ')')) {
          args.push(parseExpression());
          while (peek() && peek().type === 'OP' && peek().value === ',') {
            consume();
            args.push(parseExpression());
          }
        }
        expect('OP', ')');
        
        // Call method
        if (typeof obj === 'function') {
          obj = obj(...args);
        } else if (obj && typeof obj[prop] === 'function') {
          obj = obj[prop](...args);
        } else if (prop === 'toString') {
          const radix = args[0] || 10;
          obj = typeof obj === 'number' ? obj.toString(radix) : String(obj);
        } else {
          throw new Error(prop + ' is not a function');
        }
      } else {
        // Property access
        if (obj && typeof obj === 'object') {
          obj = obj[prop];
        } else {
          obj = undefined;
        }
      }
    }
    
    // Handle direct function call
    if (peek() && peek().type === 'OP' && peek().value === '(') {
      consume(); // skip '('
      const args = [];
      if (peek() && !(peek().type === 'OP' && peek().value === ')')) {
        args.push(parseExpression());
        while (peek() && peek().type === 'OP' && peek().value === ',') {
          consume();
          args.push(parseExpression());
        }
      }
      expect('OP', ')');
      
      if (typeof obj === 'function') {
        obj = obj(...args);
      } else {
        throw new Error(id + ' is not a function');
      }
    }
    
    return parsePostfix(obj);
  }
  
  function parsePostfix(value) {
    // Handle method calls on result (e.g., (1+2).toString())
    while (peek() && peek().type === 'OP' && peek().value === '.') {
      consume(); // skip '.'
      const prop = expect('ID').value;
      
      if (peek() && peek().type === 'OP' && peek().value === '(') {
        consume(); // skip '('
        const args = [];
        if (peek() && !(peek().type === 'OP' && peek().value === ')')) {
          args.push(parseExpression());
          while (peek() && peek().type === 'OP' && peek().value === ',') {
            consume();
            args.push(parseExpression());
          }
        }
        expect('OP', ')');
        
        if (value && typeof value[prop] === 'function') {
          value = value[prop](...args);
        } else if (prop === 'toString') {
          const radix = args[0] || 10;
          value = typeof value === 'number' ? value.toString(radix) : String(value);
        } else {
          throw new Error(prop + ' is not a function on ' + typeof value);
        }
      } else {
        if (value && typeof value === 'object') {
          value = value[prop];
        } else {
          value = undefined;
        }
      }
    }
    return value;
  }
  
  function resolveIdentifier(id) {
    switch (id) {
      case 'parseInt': return parseInt;
      case 'parseFloat': return parseFloat;
      case 'String': return String;
      case 'Number': return Number;
      case 'Math': return Math;
      case 'eval':
        return (expr) => {
          if (typeof expr !== 'string') throw new Error('eval arg must be string');
          return evaluateMath(expr);
        };
      case 'undefined': return undefined;
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      default:
        throw new Error('Unknown identifier: ' + id);
    }
  }
  
  return parseExpression();
}
