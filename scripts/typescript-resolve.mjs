// Lets Node run Pit's TypeScript sources directly: `node --import ./scripts/typescript-resolve.mjs file.ts`.
//
// Node strips erasable TypeScript syntax natively (on by default since 22.18), but Pit's sources
// import siblings as `./module.js`, the NodeNext convention for files authored as `module.ts`.
// This resolve hook maps such a relative `.js` specifier to the `.ts` file when no `.js` file
// exists. `tsconfig.json` enables `erasableSyntaxOnly` so every source stays strippable.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(target))) {
        const typescript = new URL(`${target.href.slice(0, -".js".length)}.ts`);
        if (existsSync(fileURLToPath(typescript))) {
          return nextResolve(typescript.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
