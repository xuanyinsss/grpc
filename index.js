// ==================== Cloudflare Worker 示例 ====================

// 导入 Cloudflare Worker 的连接功能
import { connect } from 'cloudflare:sockets';

// 配置示例：设置唯一ID
const CFG = { id: '5b75df69-62e0-4f8d-82f4-c4763c6a9ec3' };

// 处理请求的主要函数
export default {
  fetch: req => req.headers.get('Upgrade') === 'websocket' ? handleWebSocket(req) : new Response('Hello world!')
};

// 初始化配置信息
const enc = new TextEncoder(), dec = new TextDecoder();
const idB = new Uint8Array(16), off = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4, 4];
for (let i = 0, c; i < 16; i++) {
  idB[i] = (((c = CFG.id.charCodeAt(i * 2 + off[i])) > 64 ? c + 9 : c) & 0xF) << 4 | (((c = CFG.id.charCodeAt(i * 2 + off[i] + 1)) > 64 ? c + 9 : c) & 0xF);
}

// 地址解析函数，根据类型返回不同的地址格式
const parseAddress = (type, bytes) => ({
  3: () => dec.decode(bytes), // 域名类型
  1: () => `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`, // IPv4 类型
  4: () => `[${Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16)).join(':')}]` // IPv6 类型
})[type]?.();

// 解析代理地址并返回包含认证信息的配置
const parseProxy = (s) => {
  const at = s.lastIndexOf('@'),
    hasAuth = at !== -1,
    [user, pass] = hasAuth ? s.slice(0, at).split(':') : [null, null],
    hp = hasAuth ? s.slice(at + 1) : s,
    col = hp.lastIndexOf(':');
  return { user, pass, host: hp.slice(0, col), port: parseInt(hp.slice(col + 1)) || 443 };
};

// 连接目标服务器的 HTTPS 请求（支持不安全和安全的代理连接）
const connectHttps = async (target, port, proxy) => {
  try {
    // 不安全连接
    if (proxy.insecure) {
      const sock = connect({ hostname: proxy.host, port: proxy.port });
      await sock.opened;
      const tls = new TlsClient(sock, { serverName: proxy.host, insecure: true });
      await tls.handshake();
      let headers = `CONNECT ${target}:${port} HTTP/1.1\r\nHost: ${target}:${port}\r\n`;
      if (proxy.user) headers += `Proxy-Authorization: Basic ${btoa(proxy.user + ':' + (proxy.pass || ''))}\r\n`;
      headers += '\r\n';
      await tls.write(enc.encode(headers));
      
      let response = '';
      while (true) {
        const data = await tls.read();
        if (!data) return null;
        response += dec.decode(data);
        if (response.includes('\r\n\r\n')) break;
        if (response.length > 1024) return null;
      }
      
      if (!/^HTTP\/1\.[01] 200/.test(response)) {
        tls.close();
        return null;
      }
      
      return tls;
    }

    // 安全连接
    const sock = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: 'on', allowHalfOpen: false });
    await sock.opened;
    const writer = sock.writable.getWriter();
    let headers = `CONNECT ${target}:${port} HTTP/1.1\r\nHost: ${target}:${port}\r\n`;
    if (proxy.user) headers += `Proxy-Authorization: Basic ${btoa(proxy.user + ':' + (proxy.pass || ''))}\r\n`;
    headers += '\r\n';
    await writer.write(enc.encode(headers));
    writer.releaseLock();
    
    const reader = sock.readable.getReader();
    const buf = new Uint8Array(256);
    let n = 0;
    while (n < 256) {
      const { value, done } = await reader.read();
      if (done || !value) {
        reader.releaseLock();
        return null;
      }
      buf.set(value, n);
      n += value.length;
      if (n >= 12 && buf[9] !== 50) {
        reader.releaseLock();
        return null;
      }
      for (let i = 0; i <= n - 4; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
          reader.releaseLock();
          if (n > i + 4) {
            const { readable, writable } = new TransformStream();
            const writableWriter = writable.getWriter();
            writableWriter.write(buf.subarray(i + 4, n));
            writableWriter.releaseLock();
            sock.readable.pipeTo(writable).catch(() => {});
            return { readable, writable: sock.writable, close: () => sock.close() };
          }
          return sock;
        }
      }
    }
    reader.releaseLock();
    return null;
  } catch (err) {
    console.error('连接错误:', err);
    return null;
  }
};

// WebSocket 处理函数
const handleWebSocket = async (req) => {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  
  const proxy = getProxy(req.url);
  if (!proxy) {
    server.close();
    return new Response(null, { status: 101, webSocket: client });
  }

  let tcp = null, writer = null;
  const closeConnection = () => {
    tcp?.close();
    server.close();
  };

  const processData = async (data) => {
    if (writer) return writer.write(data);
    if (tcp?.write) return tcp.write(data);

    const v = vless(data); // 假设 vless 函数已经定义
    if (!v) return closeConnection();
    server.send(new Uint8Array([data[0], 0]));

    tcp = await connectHttps(parseAddress(v.addrType, v.addrBytes), v.port, proxy);
    if (!tcp) return closeConnection();

    const payload = data.subarray(v.dataOffset);
    if (tcp.write) {
      if (payload.length) await tcp.write(payload);
      (async () => {
        try {
          while (true) {
            const data = await tcp.read();
            if (!data) break;
            server.send(data);
          }
        } finally {
          closeConnection();
        }
      })();
    } else {
      writer = tcp.writable.getWriter();
      if (payload.length) await writer.write(payload);
      const reader = tcp.readable.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            server.send(value);
          }
        } finally {
          reader.releaseLock();
          closeConnection();
        }
      })();
    }

    server.addEventListener('message', e => processData(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data).catch(closeConnection));
    return new Response(null, { status: 101, webSocket: client });
  };

  return processData(req.data);
};
