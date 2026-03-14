#!/usr/bin/env npx tsx
/**
 * Real MCP integration test — spawns each server as a child process,
 * sends JSON-RPC messages over stdin, reads responses from stdout.
 * This simulates exactly what Claude Desktop / Claude Code does.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import * as readline from "node:readline";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

function section(name: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"=".repeat(60)}`);
}

// ============================================================================
// MCP Client — spawn a server and send/receive JSON-RPC
// ============================================================================

class MCPTestClient {
  private proc: ChildProcess;
  private responses: Map<number | string, any> = new Map();
  private pendingResolvers: Map<number | string, (v: any) => void> = new Map();
  private rl: readline.Interface;
  private stderrLog: string[] = [];

  constructor(serverPath: string, env?: Record<string, string>) {
    this.proc = spawn("npx", ["tsx", serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/Users/houssemchihoub/axon-protocol",
      env: { ...process.env, ...env },
    });

    this.rl = readline.createInterface({
      input: this.proc.stdout!,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          const resolver = this.pendingResolvers.get(msg.id);
          if (resolver) {
            resolver(msg);
            this.pendingResolvers.delete(msg.id);
          }
          this.responses.set(msg.id, msg);
        }
      } catch {}
    });

    this.proc.stderr?.on("data", (chunk) => {
      this.stderrLog.push(chunk.toString());
    });
  }

  send(msg: any): void {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  async request(msg: any, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolvers.delete(msg.id);
        reject(new Error(`Timeout waiting for response to id=${msg.id} method=${msg.method}`));
      }, timeoutMs);

      this.pendingResolvers.set(msg.id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });

      this.send(msg);
    });
  }

  async initialize(): Promise<any> {
    const initResp = await this.request({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "axon-test", version: "1.0" },
      },
    });

    // Send initialized notification
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 1500));
    return initResp;
  }

  async listTools(): Promise<any> {
    return this.request({ jsonrpc: "2.0", id: 100, method: "tools/list" });
  }

  async callTool(name: string, args: any, id?: number): Promise<any> {
    return this.request({
      jsonrpc: "2.0",
      id: id ?? Math.floor(Math.random() * 10000) + 200,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  getStderr(): string {
    return this.stderrLog.join("");
  }

  async close(): Promise<void> {
    this.proc.stdin!.end();
    this.rl.close();
    return new Promise((resolve) => {
      this.proc.on("exit", () => resolve());
      setTimeout(() => {
        this.proc.kill("SIGTERM");
        setTimeout(resolve, 500);
      }, 2000);
    });
  }
}

// ============================================================================
// Test: Filesystem Server
// ============================================================================

async function testFilesystem() {
  section("Filesystem Server — Real MCP");

  // Setup test directory
  const testDir = "/tmp/axon-mcp-fs-test";
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(`${testDir}/subdir`, { recursive: true });
  writeFileSync(`${testDir}/hello.txt`, "Hello from AXON!\nSecond line.");
  writeFileSync(`${testDir}/subdir/nested.json`, '{"key":"value"}');

  const client = new MCPTestClient(
    "servers/filesystem/src/mcp-stdio.ts",
    { AXON_FS_ROOT: testDir },
  );

  try {
    const init = await client.initialize();
    assert(init.result?.serverInfo?.name === "axon-filesystem", "filesystem: initialize returns server name");

    // tools/list
    const toolsList = await client.listTools();
    const tools = toolsList.result?.tools ?? [];
    assert(tools.length === 10, `filesystem: tools/list returns 10 tools (got ${tools.length})`);
    const toolNames = tools.map((t: any) => t.name);
    assert(toolNames.includes("list_directory"), "filesystem: has list_directory tool");
    assert(toolNames.includes("read_file"), "filesystem: has read_file tool");

    // list_directory
    const listResp = await client.callTool("list_directory", {});
    assert(!listResp.result?.isError, "filesystem: list_directory succeeded");
    const listText = listResp.result?.content?.[0]?.text ?? "";
    assert(listText.includes("hello.txt") || listText.includes("subdir"), `filesystem: list_directory shows files`);

    // read_file
    const readResp = await client.callTool("read_file", { path: "hello.txt" });
    assert(!readResp.result?.isError, "filesystem: read_file succeeded");
    const readText = readResp.result?.content?.[0]?.text ?? "";
    assert(readText.includes("Hello from AXON"), `filesystem: read_file returns content`);

    // write_file
    const writeResp = await client.callTool("write_file", { path: "new.txt", content: "Created via MCP!" });
    assert(!writeResp.result?.isError, "filesystem: write_file succeeded");
    assert(existsSync(`${testDir}/new.txt`), "filesystem: write_file created file on disk");
    assert(readFileSync(`${testDir}/new.txt`, "utf8") === "Created via MCP!", "filesystem: file content matches");

    // search_files
    const searchResp = await client.callTool("search_files", { pattern: "*.txt" });
    assert(!searchResp.result?.isError, "filesystem: search_files succeeded");

    // find_text
    const findResp = await client.callTool("find_text", { query: "AXON" });
    assert(!findResp.result?.isError, "filesystem: find_text succeeded");
    const findText = findResp.result?.content?.[0]?.text ?? "";
    assert(findText.includes("hello.txt") || findText.includes("AXON"), "filesystem: find_text found match");

    // get_file_info
    const infoResp = await client.callTool("get_file_info", { path: "hello.txt" });
    assert(!infoResp.result?.isError, "filesystem: get_file_info succeeded");

    // copy
    const copyResp = await client.callTool("copy", { source: "hello.txt", destination: "hello-copy.txt" });
    assert(!copyResp.result?.isError, "filesystem: copy succeeded");
    assert(existsSync(`${testDir}/hello-copy.txt`), "filesystem: copy created file on disk");

    // delete
    const deleteResp = await client.callTool("delete", { path: "hello-copy.txt" });
    assert(!deleteResp.result?.isError, "filesystem: delete succeeded");
    assert(!existsSync(`${testDir}/hello-copy.txt`), "filesystem: delete removed file");

  } finally {
    await client.close();
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Test: Git Repo Server
// ============================================================================

async function testGitRepo() {
  section("Git Repo Server — Real MCP");

  const { execFileSync } = await import("child_process");
  const testRepo = "/tmp/axon-mcp-git-test";
  if (existsSync(testRepo)) rmSync(testRepo, { recursive: true });
  mkdirSync(testRepo, { recursive: true });
  execFileSync("git", ["init"], { cwd: testRepo });
  execFileSync("git", ["config", "user.email", "test@axon.dev"], { cwd: testRepo });
  execFileSync("git", ["config", "user.name", "AXON Test"], { cwd: testRepo });
  writeFileSync(`${testRepo}/README.md`, "# AXON Test Repo\n");
  execFileSync("git", ["add", "."], { cwd: testRepo });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: testRepo });

  const client = new MCPTestClient(
    "servers/git-repo/src/mcp-stdio.ts",
    { AXON_GIT_REPO: testRepo },
  );

  try {
    await client.initialize();

    const toolsList = await client.listTools();
    assert(toolsList.result?.tools?.length === 10, `git-repo: 10 tools registered`);

    // git_status
    const statusResp = await client.callTool("git_status", {});
    assert(!statusResp.result?.isError, "git-repo: git_status succeeded");
    const statusText = statusResp.result?.content?.[0]?.text ?? "";
    assert(statusText.includes("clean") || statusText.includes("branch") || statusText.length > 0, "git-repo: git_status returns data");

    // git_log
    const logResp = await client.callTool("git_log", { count: 5 });
    assert(!logResp.result?.isError, "git-repo: git_log succeeded");
    const logText = logResp.result?.content?.[0]?.text ?? "";
    assert(logText.includes("Initial commit") || logText.includes("initial"), "git-repo: git_log shows commit");

    // git_diff (make a change first)
    writeFileSync(`${testRepo}/README.md`, "# AXON Test Repo\n\nModified for MCP test.\n");
    const diffResp = await client.callTool("git_diff", {});
    assert(!diffResp.result?.isError, "git-repo: git_diff succeeded");
    const diffText = diffResp.result?.content?.[0]?.text ?? "";
    assert(diffText.includes("Modified") || diffText.includes("diff"), "git-repo: git_diff shows changes");

    // git_branch list
    const branchResp = await client.callTool("git_branch", { action: "list" });
    assert(!branchResp.result?.isError, "git-repo: git_branch list succeeded");

    // git_blame
    const blameResp = await client.callTool("git_blame", { file: "README.md" });
    assert(!blameResp.result?.isError, "git-repo: git_blame succeeded");

  } finally {
    await client.close();
    rmSync(testRepo, { recursive: true, force: true });
  }
}

// ============================================================================
// Test: System Monitor Server
// ============================================================================

async function testSystemMonitor() {
  section("System Monitor Server — Real MCP");

  const client = new MCPTestClient("servers/system-monitor/src/mcp-stdio.ts");

  try {
    await client.initialize();

    const toolsList = await client.listTools();
    assert(toolsList.result?.tools?.length === 7, `system-monitor: 7 tools registered`);

    // get_system_info
    const sysResp = await client.callTool("get_system_info", {});
    assert(!sysResp.result?.isError, "system-monitor: get_system_info succeeded");
    const sysText = sysResp.result?.content?.[0]?.text ?? "";
    assert(sysText.includes("darwin") || sysText.includes("platform") || sysText.includes("Darwin"), "system-monitor: reports platform");

    // get_cpu_usage
    const cpuResp = await client.callTool("get_cpu_usage", {});
    assert(!cpuResp.result?.isError, "system-monitor: get_cpu_usage succeeded");

    // get_memory_usage
    const memResp = await client.callTool("get_memory_usage", {});
    assert(!memResp.result?.isError, "system-monitor: get_memory_usage succeeded");
    const memText = memResp.result?.content?.[0]?.text ?? "";
    assert(memText.includes("total") || memText.includes("used") || memText.includes("free"), "system-monitor: memory has usage data");

    // get_disk_usage
    const diskResp = await client.callTool("get_disk_usage", {});
    assert(!diskResp.result?.isError, "system-monitor: get_disk_usage succeeded");

    // list_processes
    const procResp = await client.callTool("list_processes", { limit: 5 });
    assert(!procResp.result?.isError, "system-monitor: list_processes succeeded");

    // get_network_info
    const netResp = await client.callTool("get_network_info", {});
    assert(!netResp.result?.isError, "system-monitor: get_network_info succeeded");

  } finally {
    await client.close();
  }
}

// ============================================================================
// Test: Clipboard Server
// ============================================================================

async function testClipboard() {
  section("Clipboard Server — Real MCP");

  const client = new MCPTestClient(
    "servers/clipboard/src/mcp-stdio.ts",
    { AXON_CLIPBOARD_HISTORY: "/tmp/axon-mcp-clipboard.json" },
  );

  try {
    await client.initialize();

    const toolsList = await client.listTools();
    assert(toolsList.result?.tools?.length === 6, `clipboard: 6 tools registered`);

    // set_clipboard
    const setResp = await client.callTool("set_clipboard", { content: "AXON MCP clipboard test" });
    assert(!setResp.result?.isError, "clipboard: set_clipboard succeeded");

    // get_clipboard
    const getResp = await client.callTool("get_clipboard", {});
    assert(!getResp.result?.isError, "clipboard: get_clipboard succeeded");
    const clipText = getResp.result?.content?.[0]?.text ?? "";
    assert(clipText.includes("AXON") || clipText.includes("clipboard"), "clipboard: get_clipboard returns content");

    // get_history
    const histResp = await client.callTool("get_history", {});
    assert(!histResp.result?.isError, "clipboard: get_history succeeded");

    // clear_history
    const clearResp = await client.callTool("clear_history", {});
    assert(!clearResp.result?.isError, "clipboard: clear_history succeeded");

  } finally {
    await client.close();
    if (existsSync("/tmp/axon-mcp-clipboard.json")) rmSync("/tmp/axon-mcp-clipboard.json");
  }
}

// ============================================================================
// Test: SSH Keys Server
// ============================================================================

async function testSSHKeys() {
  section("SSH Keys Server — Real MCP");

  const client = new MCPTestClient("servers/ssh-keys/src/mcp-stdio.ts");

  try {
    await client.initialize();

    const toolsList = await client.listTools();
    assert(toolsList.result?.tools?.length === 7, `ssh-keys: 7 tools registered`);

    // list_keys
    const keysResp = await client.callTool("list_keys", {});
    assert(!keysResp.result?.isError, "ssh-keys: list_keys succeeded");
    const keysText = keysResp.result?.content?.[0]?.text ?? "";
    // Should list SSH keys or say none found
    assert(keysText.length > 0, "ssh-keys: list_keys returns data");

    // list_hosts
    const hostsResp = await client.callTool("list_hosts", {});
    assert(!hostsResp.result?.isError, "ssh-keys: list_hosts succeeded");

  } finally {
    await client.close();
  }
}

// ============================================================================
// Test: ENV Vault Server
// ============================================================================

async function testEnvVault() {
  section("ENV Vault Server — Real MCP");

  const testDir = "/tmp/axon-mcp-env-test";
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  writeFileSync(`${testDir}/.env`, `DATABASE_URL=postgres://user:secret@localhost:5432/db
API_KEY=sk_test_abc123def456
NORMAL_VAR=hello
PORT=3000
`);
  writeFileSync(`${testDir}/.env.production`, `DATABASE_URL=postgres://prod:prod_secret@prod:5432/proddb
API_KEY=sk_live_xyz789
PORT=8080
`);

  const client = new MCPTestClient(
    "servers/env-vault/src/mcp-stdio.ts",
    { AXON_VAULT_ROOT: testDir },
  );

  try {
    await client.initialize();

    const toolsList = await client.listTools();
    assert(toolsList.result?.tools?.length === 7, `env-vault: 7 tools registered`);

    // scan_env_files
    const scanResp = await client.callTool("scan_env_files", {});
    assert(!scanResp.result?.isError, "env-vault: scan_env_files succeeded");
    const scanText = scanResp.result?.content?.[0]?.text ?? "";
    assert(scanText.includes(".env") || scanText.includes("env"), "env-vault: scan found .env files");

    // read_env (should mask values!)
    const readResp = await client.callTool("read_env", { path: ".env" });
    assert(!readResp.result?.isError, "env-vault: read_env succeeded");
    const readText = readResp.result?.content?.[0]?.text ?? "";
    assert(readText.includes("DATABASE_URL") || readText.includes("API_KEY"), "env-vault: read_env shows keys");
    // SECURITY: values should be masked
    assert(!readText.includes("sk_test_abc123def456"), "env-vault: read_env MASKS the API key value");

    // get_env_value
    const getResp = await client.callTool("get_env_value", { path: ".env", key: "PORT" });
    assert(!getResp.result?.isError, "env-vault: get_env_value succeeded");
    const getValText = getResp.result?.content?.[0]?.text ?? "";
    assert(getValText.includes("3000"), "env-vault: get_env_value returns correct value");

    // set_env_value
    const setResp = await client.callTool("set_env_value", { path: ".env", key: "NEW_VAR", value: "mcp_test" });
    assert(!setResp.result?.isError, "env-vault: set_env_value succeeded");
    const envContent = readFileSync(`${testDir}/.env`, "utf8");
    assert(envContent.includes("NEW_VAR=mcp_test"), "env-vault: set_env_value wrote to disk");

    // detect_secrets
    const detectResp = await client.callTool("detect_secrets", {});
    assert(!detectResp.result?.isError, "env-vault: detect_secrets succeeded");

    // compare_envs
    const compareResp = await client.callTool("compare_envs", { path1: ".env", path2: ".env.production" });
    assert(!compareResp.result?.isError, "env-vault: compare_envs succeeded");
    const compareText = compareResp.result?.content?.[0]?.text ?? "";
    assert(compareText.includes("NEW_VAR") || compareText.includes("different") || compareText.includes("only"), "env-vault: compare shows differences");

    // delete_env_value
    const delResp = await client.callTool("delete_env_value", { path: ".env", key: "NEW_VAR" });
    assert(!delResp.result?.isError, "env-vault: delete_env_value succeeded");
    const afterDelete = readFileSync(`${testDir}/.env`, "utf8");
    assert(!afterDelete.includes("NEW_VAR"), "env-vault: delete_env_value removed from disk");

  } finally {
    await client.close();
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Test: Network Scanner Server
// ============================================================================

async function testNetworkScanner() {
  section("Network Scanner Server — Real MCP");

  const client = new MCPTestClient("servers/network-scanner/src/mcp-stdio.ts");

  try {
    await client.initialize();

    const toolsList = await client.listTools();
    assert(toolsList.result?.tools?.length === 7, `network-scanner: 7 tools registered`);

    // get_network_interfaces
    const ifResp = await client.callTool("get_network_interfaces", {});
    assert(!ifResp.result?.isError, "network-scanner: get_network_interfaces succeeded");
    const ifText = ifResp.result?.content?.[0]?.text ?? "";
    assert(ifText.includes("lo0") || ifText.includes("en0") || ifText.includes("127.0.0.1") || ifText.length > 10, "network-scanner: shows interfaces");

    // dns_lookup
    const dnsResp = await client.callTool("dns_lookup", { host: "google.com" });
    assert(!dnsResp.result?.isError, "network-scanner: dns_lookup succeeded");
    const dnsText = dnsResp.result?.content?.[0]?.text ?? "";
    assert(dnsText.includes(".") || dnsText.includes("address"), "network-scanner: dns_lookup returned IP");

    // ping_host
    const pingResp = await client.callTool("ping_host", { host: "127.0.0.1", count: 1 });
    assert(!pingResp.result?.isError, "network-scanner: ping localhost succeeded");

    // scan_ports (scan localhost 80-82, fast)
    const portResp = await client.callTool("scan_ports", { host: "127.0.0.1", startPort: 80, endPort: 82 }, 300);
    assert(!portResp.result?.isError, "network-scanner: scan_ports succeeded");

    // check_url
    const urlResp = await client.callTool("check_url", { url: "https://httpbin.org/status/200" }, 301);
    assert(!urlResp.result?.isError, "network-scanner: check_url succeeded");

  } finally {
    await client.close();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║     AXON Protocol — Real MCP Integration Tests             ║");
  console.log("║     (spawns servers as child processes, sends JSON-RPC)     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const start = Date.now();

  await testFilesystem();
  await testGitRepo();
  await testSystemMonitor();
  await testClipboard();
  await testSSHKeys();
  await testEnvVault();
  await testNetworkScanner();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Results: ${passed} passed, ${failed} failed (${elapsed}s)                    `);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
