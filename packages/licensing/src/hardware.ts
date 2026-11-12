// The id of the PC a key is for: a hash of stable machine identifiers (Windows MachineGuid and the system disk's volume
// serial), so reinstalling on the same PC keeps the same id and the same key. Read out as "AB12-CD34-EF56-7890-1A2B".
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";

export const HARDWARE_ID_PATTERN = /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/;
/** The hash prefix every hardware id so far was made with. Changing it changes every PC's id. */
const SALT = "dinepos-hw";

/** "ab12-cd34-ef56-7890-1a2b " → "AB12-CD34-EF56-7890-1A2B", or null when it is not a hardware id. */
export function normaliseHardwareId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const id = input.trim().toUpperCase();
  return HARDWARE_ID_PATTERN.test(id) ? id : null;
}

/** 20 hex digits of SHA-256 of the identifiers, in groups of four (easy to read out over the phone). */
export function formatHardwareId(identifiers: readonly string[]): string {
  const hex = createHash("sha256").update(`${SALT}:${identifiers.join("|")}`).digest("hex").slice(0, 20).toUpperCase();
  return hex.match(/.{4}/g)!.join("-");
}

/** An outlet whose server runs in the cloud: the machine's identifiers plus the outlet id, one key per outlet. */
export function hostedHardwareId(outletId: string, identifiers: readonly string[] = machineIdentifiers()): string {
  return formatHardwareId([...identifiers, `hosted:${outletId}`]);
}

const run = (file: string, args: string[]): string => {
  try {
    return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

/** This machine's raw identifiers. */
export function machineIdentifiers(): string[] {
  if (platform() === "win32") {
    const guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]))?.[1] ?? "";
    const serial = /([0-9A-F]{4}-[0-9A-F]{4})/i.exec(run("cmd", ["/c", "vol", process.env.SystemDrive ?? "C:"]))?.[1] ?? "";
    return [guid, serial];
  }
  let machineId = "";
  try {
    machineId = readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    // not Linux
  }
  return [machineId || hostname()];
}

let cached: string | null = null;
/** This machine's hardware id (computed once). */
export function hardwareId(): string {
  cached ??= formatHardwareId(machineIdentifiers());
  return cached;
}
