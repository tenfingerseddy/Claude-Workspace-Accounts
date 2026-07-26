import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export function normalizeWindowsPath(input: string): string {
  if (!input.trim()) {
    return "";
  }

  const normalized = path.win32.normalize(input.trim()).replace(/[\\/]+$/, "");
  if (/^[a-zA-Z]:$/.test(normalized)) {
    return `${normalized.toLowerCase()}\\`;
  }
  return normalized.toLowerCase();
}

export async function canonicalizeWindowsPath(input: string): Promise<string> {
  try {
    return normalizeWindowsPath(await realpath(input));
  } catch {
    return normalizeWindowsPath(path.resolve(input));
  }
}

export function pathContains(parent: string, child: string): boolean {
  const normalizedParent = normalizeWindowsPath(parent);
  const normalizedChild = normalizeWindowsPath(child);
  if (!normalizedParent || !normalizedChild) {
    return false;
  }
  return normalizedChild === normalizedParent
    || normalizedChild.startsWith(`${normalizedParent}\\`);
}

export function workspaceHash(normalizedPath: string): string {
  return createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);
}

export function redactHomePath(input: string, homeDir: string): string {
  const normalizedInput = normalizeWindowsPath(input);
  const normalizedHome = normalizeWindowsPath(homeDir);
  if (pathContains(normalizedHome, normalizedInput)) {
    return `%USERPROFILE%${input.slice(homeDir.length)}`;
  }
  return input;
}

export function safeProfileId(displayName: string, existing: ReadonlySet<string>): string {
  const base = displayName
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 32) || "profile";

  if (!existing.has(base)) {
    return base;
  }

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to allocate a unique profile ID.");
}

export function profileMarker(displayName: string): string {
  const match = displayName.trim().match(/[\p{L}\p{N}]/u);
  return match?.[0]?.toLocaleUpperCase() ?? "?";
}
