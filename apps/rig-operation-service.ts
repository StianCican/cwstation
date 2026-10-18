import { openFakeFixture } from "../packages/device-operation/src/fixture-journal.js";
import { FakeOperationService } from "../packages/device-operation/src/fake-service.js";
import { parseRequest, response } from "../packages/device-operation/src/protocol.js";

export async function runFakeOperationService(argv: readonly string[]): Promise<number> {
  if (!process.send || !process.connected || argv.length !== 1 || !argv[0]) return 2;
  const service = new FakeOperationService(await openFakeFixture(argv[0]));
  const send = (value: unknown): void => { if (process.connected) process.send!(value, () => undefined); };
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const result = await service.close();
    send({ version: 1, event: "stopped", ...result });
    process.exitCode = result.portReleased && result.recordsFlushed ? 0 : 3;
    if (process.connected) process.disconnect();
  };
  process.on("message", (raw: unknown) => {
    // Only this inherited parent handle is a control ingress; there is no listener/socket.
    let req;
    try { req = parseRequest(raw, true); }
    catch { void close(); return; }
    void service.handle(req).then(async result => {
      send(result);
      if (req.method === "device.close") await close();
    }, error => { send(response(req, null, error)); });
  });
  process.once("disconnect", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  send({ version: 1, event: "ready", serviceInstanceId: service.serviceInstanceId, clockNs: process.hrtime.bigint().toString() });
  return 0;
}
