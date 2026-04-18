import { connect } from 'cloudflare:sockets';

const UUID = "5b75df69-62e0-4f8d-82f4-c4763c6a9ec3";

// 反代IP配置：留空则直连失败后自动使用默认反代
let 反代IP = '';

// ✅ 解析地址端口（支持 host:port、IPv6、.tp端口 格式）
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

// ✅ 动态反代参数获取（参照 Ak1.32 的 反代参数获取()）
// 支持以下格式：
//   ?proxyip=1.2.3.4
//   /proxyip.1.2.3.4/...
//   /proxyip=1.2.3.4/...
//   /pyip=1.2.3.4/...
//   /ip=1.2.3.4/...
//   多个IP逗号分隔时随机选一个
async function 反代参数获取(request, 当前反代IP) {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;
  const pathLower = pathname.toLowerCase();

  // query 参数优先级最高：?proxyip=
  if (searchParams.has('proxyip')) {
    const 路参IP = searchParams.get('proxyip');
    return 路参IP.includes(',')
      ? 路参IP.split(',')[Math.floor(Math.random() * 路参IP.split(',').length)]
      : 路参IP;
  }

  // path 参数：/proxyip.xxx、/proxyip=xxx、/pyip=xxx、/ip=xxx
  const proxyMatch = pathLower.match(/\/(proxyip[.=]|pyip=|ip=)([^/]+)/);
  if (proxyMatch) {
    const 路参IP = proxyMatch[1] === 'proxyip.' ? `proxyip.${proxyMatch[2]}` : proxyMatch[2];
    return 路参IP.includes(',')
      ? 路参IP.split(',')[Math.floor(Math.random() * 路参IP.split(',').length)]
      : 路参IP;
  }

  // 无动态参数，返回原配置值（留空则用 colo 默认反代）
  return 当前反代IP ? 当前反代IP : request.cf.colo + '.PrOxYip.CmLiuSsSs.nEt';
}

const buildUUID = (a, i) => Array.from(a.slice(i, i + 16))
  .map(n => n.toString(16).padStart(2, '0'))
  .join('')
  .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

const extractVlessFromProtobuf = (rawPayload) => {
  let ptr = 0;
  if (rawPayload[ptr] === 0x0A) {
    ptr++;
    let len = 0, shift = 0;
    while (true) {
      let b = rawPayload[ptr++];
      len |= (b & 0x7F) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const start = ptr;
    const version = rawPayload[start];
    const addonLen = rawPayload[start + 17];
    const o1 = start + 18 + addonLen;
    const cmd = rawPayload[o1];
    const p = (rawPayload[o1 + 1] << 8) | rawPayload[o1 + 2];
    const t = rawPayload[o1 + 3];
    let o2 = o1 + 4, h, l;
    switch (t) {
      case 1: l = 4; h = rawPayload.slice(o2, o2 + l).join('.'); break;
      case 2: l = rawPayload[o2++]; h = new TextDecoder().decode(rawPayload.slice(o2, o2 + l)); break;
      case 3: l = 16; h = `[${Array.from({ length: 8 }, (_, i) => ((rawPayload[o2 + i * 2] << 8) | rawPayload[o2 + i * 2 + 1]).toString(16)).join(':')}]`; break;
      default: throw new Error(`[地址解析] 未知类型 ${t}`);
    }
    return {
      host: h, port: p,
      vlessPayload: rawPayload.slice(o2 + l),
      version,
      vlessHeaderSize: (o2 + l) - start
    };
  }
};

const makeProtobufGrpcFrame = (data) => {
  const len = data.length;
  let varint = [], tempLen = len;
  while (tempLen > 127) {
    varint.push((tempLen & 0x7F) | 0x80);
    tempLen >>>= 7;
  }
  varint.push(tempLen);
  const pbHeader = new Uint8Array([0x0A, ...varint]);
  const totalPayload = new Uint8Array(pbHeader.length + data.length);
  totalPayload.set(pbHeader);
  totalPayload.set(data, pbHeader.length);
  const grpcFrame = new Uint8Array(5 + totalPayload.length);
  grpcFrame[0] = 0;
  grpcFrame[1] = (totalPayload.length >>> 24) & 0xFF;
  grpcFrame[2] = (totalPayload.length >>> 16) & 0xFF;
  grpcFrame[3] = (totalPayload.length >>> 8) & 0xFF;
  grpcFrame[4] = totalPayload.length & 0xFF;
  grpcFrame.set(totalPayload, 5);
  return grpcFrame;
};

export default {
  async fetch(request) {
    const contentType = request.headers.get('content-type') || '';
    if (request.method !== 'POST' || !contentType.startsWith('application/grpc')) {
      return new Response('Not Found', { status: 404 });
    }

    // ✅ 每次请求动态获取反代IP
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

            // ✅ 先直连，失败后 fallback 到反代IP
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

