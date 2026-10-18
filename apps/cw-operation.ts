import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { bounded, limit, parseRequest, parseResponse, type Method, type Request, type Response } from "../packages/device-operation/src/protocol.js";

export async function runOperationClient(argv: readonly string[]): Promise<number> {
  if (!process.send || !process.connected || (argv.length && (argv.length !== 2 || argv[0] !== "--demo" || !["E", "TEST"].includes(argv[1]!)))) return 2;
  let sequence = 0;
  const pending = new Map<string, { req: Request; resolve: (response: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const receive = (raw: unknown): void => {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return;
    const entry = pending.get(id); if (!entry) return;
    clearTimeout(entry.timer); pending.delete(id);
    try { entry.resolve(parseResponse(raw, entry.req)); } catch { entry.reject(new Error("invalid host response")); }
  };
  const disconnect = (): void => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("control channel lost")); } pending.clear(); };
  process.on("message", receive); process.once("disconnect", disconnect);
  const rpc = async (method: Method, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const req: Request = { deviceOperationVersion: 1, id: randomUUID(), sequence: ++sequence, method, params };
    parseRequest(req, false); bounded(req);
    const reply = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(req.id); reject(new Error("timeout; query the existing operation ID, do not retry")); }, limit(method) + 250);
      pending.set(req.id, { req, resolve, reject, timer });
      process.send!(req, error => { if (error) { clearTimeout(timer); pending.delete(req.id); reject(error); } });
    });
    process.stdout.write(JSON.stringify({ method, ...reply }) + "\n");
    if (!reply.ok) throw new Error(reply.error!.code);
    return reply.result as Record<string, unknown>;
  };
  const resultId = (result: Record<string, unknown>, key: string, field: string): string => {
    const object = result[key] as Record<string, unknown>;
    if (typeof object?.[field] !== "string") throw new Error("invalid service ID");
    return object[field];
  };
  let proposalId: string | undefined, contextId: string | undefined, approvalId: string | undefined, operationId: string | undefined;
  const propose = async (text: string): Promise<void> => {
    proposalId = resultId(await rpc("proposal.create", { text }), "proposal", "proposalId");
    approvalId = undefined;
    contextId = resultId(await rpc("context.refresh"), "context", "contextId");
  };
  const approve = async (): Promise<void> => {
    if (!proposalId || !contextId) throw new Error("no proposal/context");
    approvalId = resultId(await rpc("proposal.approve", { proposalId, contextId }), "approval", "approvalId");
  };
  const execute = async (): Promise<void> => {
    if (!proposalId || !approvalId) throw new Error("no approval");
    operationId = randomUUID();
    const consumedApprovalId = approvalId;
    approvalId = undefined;
    await rpc("cw.execute", { proposalId, approvalId: consumedApprovalId, operationId });
  };
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  let executing: Promise<void> | undefined;
  const lost = (): void => lines.close(); process.once("disconnect", lost);
  try {
    await rpc("device.describe");
    if (argv.length) { await propose(argv[1]!); await approve(); await execute(); await rpc("operation.get", { operationId }); return 0; }
    process.stdout.write("SIMULATION ONLY: status | propose E/TEST | approve | execute | stop | get | quit\n");
    for await (const line of lines) {
      try {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === "quit") break;
        if (parts[0] === "status") await rpc("device.status");
        else if (parts[0] === "propose" && parts.length === 2) await propose(parts[1]!);
        else if (parts[0] === "approve") await approve();
        else if (parts[0] === "execute") {
          if (executing) throw new Error("execute in progress");
          executing = execute().catch(error => { process.stderr.write(String(error) + "\n"); }).finally(() => { executing = undefined; });
        }
        else if (parts[0] === "stop" && operationId) await rpc("cw.stop", { operationId, stopId: randomUUID() });
        else if (parts[0] === "get" && operationId) await rpc("operation.get", { operationId });
        else throw new Error("unknown command");
      } catch (error) { process.stderr.write(String(error) + "\n"); }
    }
    return 0;
  } finally {
    lines.close(); process.off("disconnect", lost); process.off("message", receive); process.off("disconnect", disconnect); disconnect();
    if (process.connected) process.disconnect();
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runOperationClient(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(String(error) + "\n"); if (process.connected) process.disconnect(); process.exitCode = 1;
  });
}
