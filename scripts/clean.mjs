import { rm } from "node:fs/promises";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
// `bin/native/` is build output too, and it is packaged verbatim, so a stale executable there
// would ship inside the VSIX.
await rm(new URL("../bin", import.meta.url), { recursive: true, force: true });
