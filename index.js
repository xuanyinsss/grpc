import { connect } from 'cloudflare:sockets';

let UUID = "5b75df69-62e0-4f8d-82f4-c4763c6a9ec3";
let 反代IP = "";

// UUID 校验
function isValidUUID(uuid) {
  const reg = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return reg.test(uuid);
}

if (!isValidUUID(UUID)) {
  throw new Error("UUID 不合法");
}

// ====== 入口 ======
export default {
  async fetch(request, env) {
    UUID = env.UUID || UUID;
    反代IP = env.PROXYIP || 反代IP;

    const url = new URL(request.url);

    // ✅ 输出 VLESS 链接
    if (url.pathname === `/${UUID}`) {
      return new Response(getVLESSLink(UUID, request.headers.get("host")), {
        headers: { "content-type": "text/plain" }
      });
    }

    // ✅ 只允许 gRPC
    const contentType = request.headers.get('content-type') || '';
    if (request.method !== 'POST' || !contentType.includes('application/grpc')) {
      return new Response('Not Found', { status: 404 });
    }

    const 当前反代IP = await 获取反代IP(request);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    processStream(request.body.getReader(), writer, 当前反代IP)
      .catch(err => console.log("错误:", err));

    return new Response(readable, {
      headers: {
        "Content-Type": "application/grpc",
        "grpc-status": "0"
      }
    });
  }
};

// ====== 反代逻辑（保留你的）======
async function 获取反代IP(request) {
  const url = new URL(request.url);

  if (url.searchParams.has('proxyip')) {
    return url.searchParams.get('proxyip');
  }

  const match = url.pathname.match(/\/(proxyip|ip|pyip)[.=]([^/]+)/i);
  if (match) return match[2];

  return 反代IP || request.cf.colo + '.PrOxYip.CmLiuSsSs.nEt';
}

// ====== gRPC核心 ======
async function processStream(reader, writer, proxyIP) {
  let buffer = new Uint8Array(0);
  let socket, sockWriter, sockReader;
  let first = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer = concat(buffer, value);

    while (buffer.length >= 5) {
      const len = (buffer[1]<<24)|(buffer[2]<<16)|(buffer[3]<<8)|buffer[4];
      if (buffer.length < len + 5) break;

      const data = buffer.slice(5, 5 + len);
      buffer = buffer.slice(5 + len);

      if (first) {
        first = false;

        const info = parseVLESS(data);

        if (!info.valid) throw new Error("UUID 错误");

        try {
          socket = connect({ hostname: info.host, port: info.port });
          await socket.opened;
        } catch {
          socket = connect({ hostname: proxyIP, port: 443 });
          await socket.opened;
        }

        sockWriter = socket.writable.getWriter();
        sockReader = socket.readable.getReader();

        await writer.write(frame(new Uint8Array([0, 0])));
        pipe(sockReader, writer);

        if (info.payload.length)
          await sockWriter.write(info.payload);

      } else {
        await sockWriter.write(strip(data));
      }
    }
  }
}

// ====== VLESS解析（加UUID验证）======
function parseVLESS(buf) {
  const id = [...buf.slice(1,17)]
    .map(b=>b.toString(16).padStart(2,'0')).join('')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');

  if (id !== UUID) return { valid:false };

  const port = (buf[19]<<8)|buf[20];
  const type = buf[21];

  let host="", idx=22;

  if (type===1) host = buf.slice(idx,idx+4).join('.');
  if (type===2) {
    const l = buf[idx++];
    host = new TextDecoder().decode(buf.slice(idx,idx+l));
  }

  return {
    valid:true,
    host,
    port,
    payload: buf.slice(idx)
  };
}

// ====== 工具 ======
function concat(a,b){
  const c=new Uint8Array(a.length+b.length);
  c.set(a);c.set(b,a.length);return c;
}

function strip(d){
  if(d[0]!==0x0A) return d;
  let i=1; while(d[i++]&0x80);
  return d.slice(i);
}

function frame(d){
  const out=new Uint8Array(5+d.length);
  out[0]=0;
  out[1]=d.length>>24;
  out[2]=d.length>>16;
  out[3]=d.length>>8;
  out[4]=d.length;
  out.set(d,5);
  return out;
}

async function pipe(r,w){
  while(true){
    const {done,value}=await r.read();
    if(done) break;
    await w.write(frame(value));
  }
}

// ====== VLESS链接 ======
function getVLESSLink(uuid, host){
  return `vless://${uuid}@${host}:443?encryption=none&security=tls&type=grpc&serviceName=grpc&fp=randomized&sni=${host}#gRPC-${host}`;
}
