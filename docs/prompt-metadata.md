# Prompt metadata budget

The TypeScript tool metadata is intentionally kept compact because it is included in model context on every turn.

| Version | Characters | Approx. tokens (characters / 4) |
| --- | ---: | ---: |
| Before consolidation | 8,748 | 2,187 |
| After consolidation | 4,297 | 1,075 |

The after value includes the tool description, prompt snippet, prompt guidelines, code parameter description, and params description. The test suite enforces a 6,500-character ceiling while checking that the calling forms, capability names, saved functions, composition, parallelism, and failure behavior remain discoverable.

Recalculate with:

```sh
node --import tsx --input-type=module - <<'NODE'
import {
  CODE_DESCRIPTION,
  PARAMS_DESCRIPTION,
  PROMPT_GUIDELINES,
  PROMPT_SNIPPET,
  createToolDescription,
} from "./src/tool-metadata.ts";

const chars = createToolDescription(50 * 1024).length
  + PROMPT_SNIPPET.length
  + PROMPT_GUIDELINES.join("\n").length
  + CODE_DESCRIPTION.length
  + PARAMS_DESCRIPTION.length;
console.log({ chars, approximateTokens: Math.ceil(chars / 4) });
NODE
```

