export default {
  async fetch(request) {
    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response('Missing ?url parameter', { status: 400 });
    }

    // Validasi domain (hanya izinkan manhua.acimg.cn)
    const allowed = ['manhua.acimg.cn', 'gtimgcdn.ac.qq.com', 'acimg.cn'];
    let targetUrl;
    try { targetUrl = new URL(target); } catch { return new Response('Invalid URL', { status: 400 }); }
    if (!allowed.some(h => targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h))) {
      return new Response('Forbidden', { status: 403 });
    }

    // Request dengan Referer
    const headers = new Headers({
      'Referer': 'https://ac.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });

    const response = await fetch(target, { headers });
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Cache-Control', 'public, max-age=86400');
    return newResponse;
  }
};
