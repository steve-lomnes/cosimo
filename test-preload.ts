/**
 * Test preload. With COSIMO_TEST_DB=sqld, starts a local `sqld` with namespaces (unless
 * COSIMO_TEST_SQLD_URL / COSIMO_TEST_SQLD_ADMIN point at one already, as in CI).
 */
import { setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun applies a preload's `setDefaultTimeout` only to the first test file and ignores `timeout`
// in bunfig.toml, so the package.json test scripts pass `--timeout 30000`. This call still covers
// a single-file `bun test <file>`.
setDefaultTimeout(30_000);

if (process.env.COSIMO_TEST_DB === "sqld" && !process.env.COSIMO_TEST_SQLD_URL) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = mkdtempSync(join(tmpdir(), "cosimo-sqld-"));
  const proc = Bun.spawn(
    [
      process.env.SQLD_BIN ?? "sqld",
      "--db-path",
      join(dir, "data"),
      "--enable-namespaces",
      // A full run creates ~150 namespaces. Past sqld's default of 100 loaded, it evicts, and
      // eviction can unload a namespace it just created, so the next request is a 404.
      "--max-active-namespaces",
      "1000",
      "--http-listen-addr",
      `127.0.0.1:${port}`,
      "--admin-listen-addr",
      `127.0.0.1:${port + 1}`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  process.env.COSIMO_TEST_SQLD_URL = `http://localhost:${port}`;
  process.env.COSIMO_TEST_SQLD_ADMIN = `http://127.0.0.1:${port + 1}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  process.on("exit", () => {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  });
}
