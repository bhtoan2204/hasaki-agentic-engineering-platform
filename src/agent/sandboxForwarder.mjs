// Runs INSIDE an agent sandbox (no network namespace interfaces but lo): forwards 127.0.0.1:<port> to the host egress
// proxy's unix socket, then runs the command. The proxy outside decides what may be reached.
import net from "node:net";
import { spawn } from "node:child_process";

const [socket, port, separator, command, ...args] = process.argv.slice(2);
if (separator !== "--" || !command) {
  console.error("usage: sandboxForwarder <socket> <port> -- <command> [args]");
  process.exit(2);
}
const server = net.createServer((client) => {
  const upstream = net.connect(socket);
  client.pipe(upstream).pipe(client);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
server.listen(Number(port), "127.0.0.1", () => {
  const child = spawn(command, args, { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (e) => {
    console.error(`sandbox: ${e.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    server.close();
    process.exit(code ?? (signal ? 128 : 1));
  });
});
