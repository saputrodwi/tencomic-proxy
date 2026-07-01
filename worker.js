// ============================================================
//  WORKER V2 - SCRAPER + PROXY TENCOMIC
//  Menerima parameter "url", mengambil HTML, mendekode DATA,
//  lalu mengembalikan daftar URL gambar asli + proxy.
// ============================================================

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const chapterUrl = url.searchParams.get('url');

    // Jika tidak ada parameter url, tampilkan form sederhana atau error
    if (!chapterUrl) {
      return new Response('❌ Parameter "url" wajib diisi. Contoh: ?url=https://m.ac.qq.com/chapter/index/id/657667/cid/141855', { status: 400 });
    }

    // --- 1. Ambil HTML halaman chapter ---
    let html;
    try {
      const response = await fetch(chapterUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': 'pgv_pvid=123456789;', // opsional
        }
      });
      html = await response.text();
    } catch (e) {
      return new Response('❌ Gagal mengambil halaman: ' + e.message, { status: 500 });
    }

    // --- 2. Ekstrak DATA dan NONCE dari HTML ---
    const dataMatch = html.match(/window\.DATA\s*=\s*'([^']+)'/);
    const nonceMatch = html.match(/window\.nonce\s*=\s*'([^']+)'/);
    // Fallback untuk window["n"+"once"]
    if (!nonceMatch) {
      const fallbackMatch = html.match(/window\["n"\+"once"\]\s*=\s*'([^']+)'/);
      if (fallbackMatch) nonceMatch[1] = fallbackMatch[1];
    }

    if (!dataMatch || !nonceMatch) {
      return new Response('❌ Tidak dapat menemukan data di halaman (mungkin perlu login atau halaman tidak valid).', { status: 404 });
    }

    const rawData = dataMatch[1];
    const nonce = nonceMatch[1];

    // --- 3. Fungsi DECODE (sama persis dengan logika JS Tencent) ---
    function decodeData(data, nonce) {
      const rawArr = data.split('');
      const pattern = nonce.match(/\d+[a-zA-Z]+/g);
      if (pattern) {
        for (let i = pattern.length - 1; i >= 0; i--) {
          const pos = parseInt(pattern[i], 10);
          const chars = pattern[i].replace(/\d+/g, '');
          rawArr.splice(pos, chars.length);
        }
      }
      const base64 = rawArr.join('');
      const jsonString = atob(base64);
      return JSON.parse(jsonString);
    }

    // --- 4. Eksekusi decode ---
    let result;
    try {
      result = decodeData(rawData, nonce);
    } catch (e) {
      return new Response('❌ Gagal mendekode data: ' + e.message, { status: 500 });
    }

    // Ambil daftar gambar
    const pictureList = result.picture || [];
    if (pictureList.length === 0) {
      return new Response('❌ Tidak ada gambar ditemukan di chapter ini.', { status: 404 });
    }

    // Buat URL asli
    const rawUrls = pictureList.map(p => p.url);

    // --- 5. Konversi ke URL PROXY (otomatis) ---
    const proxyBase = url.origin + '/?url='; // Gunakan worker ini sendiri sebagai proxy
    const proxyUrls = rawUrls.map(u => proxyBase + encodeURIComponent(u));

    // --- 6. Kembalikan JSON ---
    const responseData = {
      status: 'success',
      total: rawUrls.length,
      rawUrls: rawUrls,
      proxyUrls: proxyUrls
    };

    return new Response(JSON.stringify(responseData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      }
    });
  }
};
