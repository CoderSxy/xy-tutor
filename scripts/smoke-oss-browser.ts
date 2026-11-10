import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createFileStore } from "../apps/server/src/infra/oss.js";
const origin = "http://localhost:5173";
const store = createFileStore(process.env);
if (!store) throw Error("Configure private OSS credentials in local .env");
const key = `smoke/browser-${randomUUID()}.pdf`;
const content = "%PDF-1.7\n% browser CORS probe\n";
const grant = await store.signUpload({ key, contentType: "application/pdf" });
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/cors-probe") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>OSS 浏览器连接验证</title><main><h1>OSS 浏览器连接验证</h1><p id="status">正在验证跨域上传…</p></main><script type="module">const status=document.getElementById('status');try{const content=${JSON.stringify(content)};const upload=await fetch(${JSON.stringify(grant.url)},{method:'PUT',headers:${JSON.stringify(grant.headers)},body:new Blob([content],{type:'application/pdf'})});if(!upload.ok)throw Error();status.textContent='上传成功，正在验证封存与读取…';const prepared=await fetch('/finish',{method:'POST'});if(!prepared.ok)throw Error();const {url}=await prepared.json();const download=await fetch(url);if(!download.ok||(await download.text())!==content)throw Error();status.textContent='验证通过：Chrome 跨域上传、封存和私有读取均成功。测试只使用合成文件。';await fetch('/result',{method:'POST'});}catch{status.textContent='验证失败：请检查 CORS、网络或服务权限；页面未显示密钥或签名链接。';}</script></html>`,
      );
      return;
    }
    if (req.headers.origin !== origin) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/finish") {
      const m = await store.head(key);
      if (m.size !== Buffer.byteLength(content)) throw Error("SIZE_MISMATCH");
      const sealed = await store.seal(key);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ url: await store.signDownload(sealed, 60) }));
      return;
    }
    if (req.method === "POST" && req.url === "/result") {
      res.end("ok");
      console.log(
        "BROWSER_OSS_VERIFIED: cross-origin PUT, sealed copy and GET; synthetic data only.",
      );
      server.close();
      // Browser preconnect/SDK sockets can outlive this completed one-shot probe.
      setTimeout(() => process.exit(0), 1000).unref();
      return;
    }
    res.writeHead(404);
    res.end();
  } catch {
    res.writeHead(502);
    res.end("Probe operation failed");
  }
});
server.on("error", () => {
  console.error(
    "Cannot start isolated probe on localhost:5173; existing services are not stopped.",
  );
  process.exitCode = 1;
});
server.listen(5173, "localhost", () =>
  console.log(
    "Open http://localhost:5173/cors-probe in Chrome. No credentials or signed URLs are logged.",
  ),
);
const timeout = setTimeout(() => {
  console.error("Browser probe timed out");
  server.close();
  process.exitCode = 1;
}, 300000);
timeout.unref();
server.on("close", () => clearTimeout(timeout));
