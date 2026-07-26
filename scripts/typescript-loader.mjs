import { access } from "node:fs/promises";

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith(".ts")
    && specifier.startsWith(".")
    && specifier.endsWith(".js")) {
    const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    try {
      await access(candidate);
      return { url: candidate.href, shortCircuit: true };
    } catch {
      // Fall through to normal resolution.
    }
  }
  return nextResolve(specifier, context);
}
