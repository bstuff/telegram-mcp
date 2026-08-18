#!/usr/bin/env node
// npm entry point: a plain-JS dispatcher, so that on an old Node the user gets
// a readable message instead of the syntax error type stripping would produce
// the moment a .ts file is parsed.
//
// The subcommand token is cut out of process.argv before the import, so the
// underlying scripts keep reading process.argv.slice(2) exactly as before.

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `@bstuff/telegram-mcp needs Node >= 22.18 to run TypeScript directly, but this is ${process.versions.node}. Upgrade Node and try again.`
  );
  process.exit(1);
}

const sub = process.argv[2];
const rest = process.argv.slice(3);

const HELP = `telegram-mcp — MCP server over a personal Telegram account

Usage:
  telegram-mcp                 start the MCP server (stdio) — point your MCP client here
  telegram-mcp login           sign in by phone number and store the session
  telegram-mcp login --import  paste an existing session string instead
  telegram-mcp check           verify that the stored session still works
  telegram-mcp watch [flags]   block until a matching message arrives (watch --help)

Credentials: TELEGRAM_API_ID / TELEGRAM_API_HASH in the environment or in
~/.telegram-mcp/.env; the session string is stored in ~/.telegram-mcp/session.`;

const run = (script, argv) => {
  process.argv = [process.argv[0], process.argv[1], ...argv];
  return import(script);
};

switch (sub) {
  case undefined:
  case "serve":
    await run("./telegram-mcp.ts", rest);
    break;
  case "login":
    await run("./login.ts", rest);
    break;
  case "check":
    await run("./login.ts", ["--check", ...rest]);
    break;
  case "watch":
    await run("./watch.ts", rest);
    break;
  case "--version":
  case "-v":
  case "-V": {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    break;
  }
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${sub}\n\n${HELP}`);
    process.exit(1);
}
