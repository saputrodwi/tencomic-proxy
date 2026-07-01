export default {
  async fetch(request) {
    // Handle CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response('❌ Parameter "url" wajib diisi', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // Validasi URL
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('❌ URL tidak valid', { status: 400 });
    }

    // Batasi domain yang diizinkan
    const allowed = ['manhua.acimg.cn', 'gtimgcdn.ac.qq.com', 'acimg.cn'];
    const isAllowed = allowed.some(h => 
      targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h)
    );
    if (!isAllowed) {
      return new Response('❌ Domain tidak diizinkan', { status: 403 });
    }

    // Request dengan header Referer
    const headers = new Headers({
      'Referer': 'https://ac.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/webp,image/*,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    });

    try {
      const response = await fetch(target, { headers });

      if (!response.ok) {
        return new Response(`❌ Gagal: HTTP ${response.status}`, { status: response.status });
      }

      // Response dengan CORS
      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.set('Cache-Control', 'public, max-age=86400');
      
      // Pertahankan content-type
      const ct = response.headers.get('Content-Type');
      if (ct) newResponse.headers.set('Content-Type', ct);

      return newResponse;

    } catch (err) {
      return new Response(`❌ Error: ${err.message}`, { status: 500 });
    }
  }
};
