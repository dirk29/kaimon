// Hand a file to the browser on the machine the user sits at.
//
// The extension runs where the workspace is (extensionKind "workspace"): on a
// remote host, the browser is on ANOTHER machine, so a temp file and a file://
// URI would name a path that does not exist there. A local server works for
// both: VS Code forwards a localhost port to the client (asExternalUri), as it
// does for any dev server, and on a local window the URI comes back unchanged.
//
// It serves ONE file, once. Not the "permanently running local web server" the
// finish list ruled out (future.md, step 6): it listens on 127.0.0.1 only,
// behind a random path another local user cannot guess, and closes after the
// first load or after two minutes, whichever comes first.
import * as crypto from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";
import * as vscode from "vscode";

const LIFETIME_MS = 120_000;
// The browser may still be reading when the response ends; give it a moment
// before the connection is cut.
const GRACE_MS = 5_000;

// For VIEWING only. Saving needs none of this: VS Code's save dialog reaches
// the client's disk itself ("Show Local").
export async function open(name: string, body: string, type: string): Promise<void> {
  const path = `/${crypto.randomBytes(16).toString("hex")}/${encodeURIComponent(name)}`;
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(body, () => setTimeout(stop, GRACE_MS));
  });
  const stop = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(stop, LIFETIME_MS);
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const { port } = server.address() as AddressInfo;
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}${path}`));
  if (!(await vscode.env.openExternal(uri))) {
    stop();
  }
}
