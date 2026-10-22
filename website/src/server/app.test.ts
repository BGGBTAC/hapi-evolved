import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "./app.ts";

const indexHtml = "<!doctype html><title>spa-shell</title>";
const assetBytes = randomBytes(4096);

let root: string;
let server: Server;
let port: number;

function send(method: string, urlPath: string, destination = port, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: destination, method, path: urlPath, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on("error", reject);
      req.end();
    },
  );
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), "website-server-test-"));
  const publicDir = path.join(root, "public");
  mkdirSync(path.join(publicDir, "assets"), { recursive: true });
  writeFileSync(path.join(publicDir, "index.html"), indexHtml);
  writeFileSync(path.join(publicDir, "assets", "app-0123abcd.bin"), assetBytes);
  writeFileSync(path.join(root, "secret.txt"), "outside static root");

  server = createServer(createApp(publicDir));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

test("GET / serves index.html", async () => {
  const res = await send("GET", "/");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.equal(res.body.toString(), indexHtml);
});

test("HEAD / answers without a body", async () => {
  const res = await send("HEAD", "/");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.equal(res.body.length, 0);
});

test("deep client routes fall back to index.html", async () => {
  for (const route of ["/docs", "/some/deep/route", "/route.with.dot/x?y=1"]) {
    const res = await send("GET", route);
    assert.equal(res.status, 200, route);
    assert.equal(res.body.toString(), indexHtml, route);
  }
});

test("static assets are served byte for byte", async () => {
  const res = await send("GET", "/assets/app-0123abcd.bin");
  assert.equal(res.status, 200);
  assert.ok(res.body.equals(assetBytes));
});

test("non-GET requests do not get the SPA shell", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await send(method, "/some/deep/route");
    assert.equal(res.status, 404, method);
    assert.notEqual(res.body.toString(), indexHtml, method);
  }
});

test("files outside the static root are not served", async () => {
  for (const route of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"]) {
    const res = await send("GET", route);
    assert.ok(!res.body.toString().includes("outside static root"), route);
  }
});

test("limits repeated static and fallback requests before filesystem access", async () => {
  const limited = createServer(createApp(path.join(root, "public"), 2));
  await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
  try {
    const destination = (limited.address() as AddressInfo).port;
    assert.equal((await send("GET", "/assets/app-0123abcd.bin", destination, { "x-forwarded-for": "198.51.100.1" })).status, 200);
    assert.equal((await send("GET", "/some/deep/route", destination, { "x-forwarded-for": "198.51.100.2" })).status, 200);
    const rejected = await send("GET", "/some/deep/route", destination, { "x-forwarded-for": "198.51.100.3" });
    assert.equal(rejected.status, 429);
    assert.notEqual(rejected.body.toString(), indexHtml);
  } finally {
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  }
});
