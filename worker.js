// ============================================================
//  PROXY GAMBAR TENCOMIC - Cloudflare Worker
//  Menambahkan header Referer dan CORS untuk akses gambar
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    // ----- CORS Preflight (OPTIONS) -----
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ----- Validasi parameter -----
    if (!target) {
      return new Response(
        '❌ Parameter "url" tidak ditemukan.\nGunakan: ?url=https://manhua.acimg.cn/...',
        { 
          status: 400,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }
      );
    }

    // ----- Validasi URL -----
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('❌ URL tidak valid.', { status: 400 });
    }

    // ----- KEAMANAN: Hanya domain tertentu yang diizinkan -----
    const allowedHosts = [
      'manhua.acimg.cn',
      'gtimgcdn.ac.qq.com',
      'acimg.cn'
    ];
    const isAllowed = allowedHosts.some(host => 
      targetUrl.hostname === host || targetUrl.hostname.endsWith('.' + host)
    );
    if (!isAllowed) {
      return new Response('❌ Domain tidak diizinkan.', { status: 403 });
    }

    // ----- Buat request baru dengan header yang diperlukan -----
    const headers = new Headers();
    headers.set('Referer', 'https://ac.qq.com/');       // PENTING!
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    headers.set('Accept', 'image/webp,image/apng,image/*,*/*;q=0.8');
    headers.set('Accept-Language', 'id-ID,id;q=0.9,en;q=0.8');
    headers.set('Accept-Encoding', 'gzip, deflate, br');

    const modifiedRequest = new Request(target, {
      headers,
      redirect: 'follow',  // ikuti redirect jika ada
    });

    try {
      const response = await fetch(modifiedRequest);

      // Jika gagal, kirim status error
      if (!response.ok) {
        return new Response(
          `❌ Gagal mengambil gambar. Status: ${response.status}`,
          { status: response.status }
        );
      }

      // ----- Buat response baru dengan CORS dan Cache -----
      const newResponse = new Response(response.body, response);
      
      // Izinkan akses dari mana saja (CORS)
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      
      // Cache di Cloudflare selama 1 hari (kurangi beban)
      newResponse.headers.set('Cache-Control', 'public, max-age=86400');
      
      // Pertahankan tipe konten asli
      const contentType = response.headers.get('Content-Type');
      if (contentType) {
        newResponse.headers.set('Content-Type', contentType);
      }

      return newResponse;

    } catch (error) {
      return new Response(
        `❌ Internal error: ${error.message}`,
        { status: 500 }
      );
    }
  }
};
