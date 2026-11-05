import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";

/** WSL <-> Windows stdio bridge. Both TCP listeners/endpoints remain IPv4 loopback. */
export async function windowsChromeRelay(port: number, powershell: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid DevTools port");
  const sockets = new Set<Socket>();
  const children = new Set<ReturnType<typeof spawn>>();
  let stopped = false;
  const server = createServer((socket) => {
    if (stopped) { socket.destroy(); return; }
    sockets.add(socket);
    const script = `$ErrorActionPreference='Stop'; $c=New-Object System.Net.Sockets.TcpClient('127.0.0.1',${port}); try { $s=$c.GetStream(); $a=[Console]::OpenStandardInput().CopyToAsync($s); $b=$s.CopyToAsync([Console]::OpenStandardOutput()); [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($a,$b)) | Out-Null } finally { $c.Dispose() }`;
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "ignore"] });
    children.add(child);
    socket.pipe(child.stdin!);
    child.stdout!.pipe(socket);
    child.stdin!.on("error", () => socket.destroy());
    child.on("error", () => socket.destroy());
    child.on("exit", () => { children.delete(child); socket.destroy(); });
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); child.kill(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: (server.address() as { port: number }).port,
    close() {
      stopped = true;
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill();
      server.close();
    },
  };
}
