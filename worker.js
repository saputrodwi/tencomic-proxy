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
    if (dataMatch && dataMatch[1].length > 100) {
      dataStr = dataMatch[1];
    }
    if (!dataStr) return jsonResp({ error: "DATA tidak ditemukan di HTML.", url: chapterUrl }, 404);

    // === BRUTE-FORCE NONCE EXTRACTOR & VALIDATOR ===
    const candidates = [];
    const seen = new Set();

    function addCandidate(s, priority) {
      // Filter: panjang 10-100, mengandung angka dan huruf
      if (s && !seen.has(s) && s.length >= 10 && s.length <= 100 && /\d/.test(s) && /[a-zA-Z]/.test(s)) {
        seen.add(s);
        candidates.push({ s, priority });
      }
    }

    // Priority 1: Explicit nonce assignments (Paling mungkin)
    const explicitRegexes = [
      /(?:var\s+nonce|window\["no"\s*\+\s*"nce"\]|window\["nonce"\]|window\.nonce)\s*=\s*['"]([^'"]+)['"]/gi,
      /nonce\s*[:=]\s*['"]([a-zA-Z0-9]{10,100})['"]/gi,
      /content=['"]([a-zA-Z0-9]{10,100})['"][^>]*nonce/gi
    ];
    for (const regex of explicitRegexes) {
      let m;
      while ((m = regex.exec(html)) !== null) addCandidate(m[1], 1);
    }

    // Priority 2: Strings in the same script block as DATA
    const scriptBlocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    let dataScript = null;
    for (const script of scriptBlocks) {
      if (/var\s+DATA\s*=/.test(script)) {
        dataScript = script;
        break;
      }
    }
    if (dataScript) {
      const strings = [...dataScript.matchAll(/['"]([a-zA-Z0-9]{10,100})['"]/g)].map(m => m[1]);
      strings.forEach(s => addCandidate(s, 2));
    }

    // Priority 3: All other script blocks
    for (const script of scriptBlocks) {
      if (script === dataScript) continue;
      const strings = [...script.matchAll(/['"]([a-zA-Z0-9]{10,100})['"]/g)].map(m => m[1]);
      strings.forEach(s => addCandidate(s, 3));
    }

    // Sort by priority and limit to 50 to avoid CPU timeout di Cloudflare
    candidates.sort((a, b) => a.priority - b.priority);
    const topCandidates = candidates.slice(0, 50).map(c => c.s);

    // === TRY DECODE WITH EACH CANDIDATE ===
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
      
      const text = new TextDecoder('utf-8').decode(bytes);
      return JSON.parse(text); // Jika ini sukses, berarti nonce BENAR!
    }

    let result = null;
    let validNonce = null;

    for (const candidate of topCandidates) {
      try {
        const decoded = tryDecode(dataStr, candidate);
        if (decoded && decoded.comic && decoded.picture) {
          result = decoded;
          validNonce = candidate;
          break; // Berhenti karena sudah menemukan nonce yang valid
        }
      } catch (e) {
        // Kandidat salah, lanjut ke kandidat berikutnya
      }
    }

    if (!result) {
      return jsonResp({ 
        error: "Gagal decode DATA. Tidak ada kandidat nonce yang valid di HTML.",
        candidatesTested: topCandidates.length,
        topCandidatesSample: topCandidates.slice(0, 5)
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
