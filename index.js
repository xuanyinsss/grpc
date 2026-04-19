import { connect } from 'cloudflare:sockets';

const UUID = "5b75df69-62e0-4f8d-82f4-c4763c6a9ec3";

// 反代IP配置：留空则直连失败后自动使用默认反代
let 反代IP = '';

// 解析地址端口（支持 host:port、IPv6、.tp端口格式）
async function 解析地址端口(proxyIP) {
  proxyIP = proxyIP.toLowerCase();
  let 地址 = proxyIP, 端口 = 443;
  if (proxyIP.includes('.tp')) {
    const tpMatch = proxyIP.match(/\.tp(\d+)/);
    if (tpMatch) 端口 = parseInt(tpMatch[1], 10);
    return [地址, 端口];
  }
  if (proxyIP.includes(']:')) {
    const parts = proxyIP.split(']:');
    地址 = parts[0] + ']';
    端口 = parseInt(parts[1], 10) || 端口;
  } else if (proxyIP.includes(':') && !proxyIP.startsWith('[')) {
    const colonIndex = proxyIP.lastIndexOf(':');
    地址 = proxyIP.slice(0, colonIndex);
    端口 = parseInt(proxyIP.slice(colonIndex + 1), 10) || 端口;
  }
  return [地址, 端口];
}

// 动态获取反代IP
async function 反代参数获取(request, 当前反代IP) {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;
  const pathLower = pathname.toLowerCase();

  // 从 query 参数获取 proxyip
  if (searchParams.has('proxyip')) {
    const 路参IP = searchParams.get('proxyip');
    return 路参IP.includes(',')
      ? 路参IP.split(',')[Math.floor(Math.random() * 路参IP.split(',').length)]
      : 路参IP;
  }

  // 从 path 参数获取 proxyip
  const proxyMatch = pathLower.match(/\/(proxyip[.=]|pyip=|ip=)([^/]+)/);
  if (proxyMatch) {
    const 路参IP = proxyMatch[1] === 'proxyip.' ? `proxyip.${proxyMatch[2]}` : proxyMatch[2];
    return 路参IP.includes(',')
      ? 路参IP.split(',')[Math.floor(Math.random() * 路参IP.split(',').length)]
      : 路参IP;
  }

  // 无动态参数，返回原配置值
  return 当前反代IP ? 当前反代IP : request.cf.colo + '.PrOxYip.CmLiuSsSs.nEt';
}

// 处理 gRPC 请求
export default {
  async fetch(request) {
    const contentType = request.headers.get('content-type') || '';
    if (request.method !== 'POST' || !contentType.startsWith('application/grpc')) {
      return new Response('Not Found', { status: 404 });
    }

    // 每次请求动态获取反代IP
    const 当前反代IP = await 反代参数获取(request, 反代IP);

    const { readable, writable } = new TransformStream();
    const responseWriter = writable.getWriter();

    processStream(request.body.getReader(), responseWriter, 当前反代IP).catch(e => console.error(`[流异常]`, e.message));

    return new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'application/grpc', 'grpc-status': '0' }
    });
  }
};

// 处理流的函数
async function processStream(clientReader, responseWriter, proxyIP) {
  let buffer = new Uint8Array(0);
  let socket = null, writer = null, reader = null, isFirst = true;

  try {
    while (true) {
      const { done, value } = await clientReader.read();
      if (done) break;

      buffer = concatBuffer(buffer, value);

      while (buffer.length >= 5) {
        const grpcLen = ((buffer[1] << 24) >>> 0) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
        if (buffer.length >= 5 + grpcLen) {
          const grpcData = buffer.slice(5, 5 + grpcLen);
          buffer = buffer.slice(5 + grpcLen);

          if (isFirst) {
            isFirst = false;
            const { host, port, vlessPayload, version } = extractVlessFromProtobuf(grpcData);
            console.log(`[Target] ${host}:${port}`);

            // 先尝试直连，失败后 fallback 到反代IP
            try {
              socket = connect({ hostname: host, port: port });
              await socket.opened;
            } catch {
              const [反代IP地址, 反代IP端口] = await 解析地址端口(proxyIP);
              console.log(`[反代] fallback to ${反代IP地址}:${反代IP端口}`);
              socket = connect({ hostname: 反代IP地址, port: 反代IP端口 });
              await socket.opened;
            }

            writer = socket.writable.getWriter();
            reader = socket.readable.getReader();

            await responseWriter.write(makeProtobufGrpcFrame(new Uint8Array([version, 0])));
            pipeToClient(reader, responseWriter);

            if (vlessPayload.length > 0) await writer.write(vlessPayload);
          } else {
            const pureData = stripProtobufHeader(grpcData);
            if (writer) await writer.write(pureData);
          }
        } else break;
      }
    }
  } catch (e) {
    console.error(`[致命错误]`, e.message);
  } finally {
    cleanup(socket, writer, reader, responseWriter);
  }
}

// 辅助函数
function stripProtobufHeader(data) {
  if (data[0] !== 0x0A) return data;
  let p = 1;
  while (data[p++] & 0x80);
  return data.slice(p);
}

async function pipeToClient(reader, writer) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(makeProtobufGrpcFrame(value));
    }
  } catch (e) {
  } finally {
    try { await writer.close(); } catch(e) {}
  }
}

function concatBuffer(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0); c.set(b, a.length); return c;
}

function cleanup(s, w, r, rw) {
  try { w?.releaseLock(); r?.releaseLock(); s?.close(); } catch(e) {}
  try { rw.close(); } catch(e) {}
}
