# LocalMail embeddings

The package always returns a normalized 384-float vector. Tests and normal
offline development use a deterministic fallback. To enable the approved
local ONNX model, install the optional runtime in the workspace and set:

```sh
pnpm add -w @xenova/transformers
EMBEDDINGS_USE_ONNX=true pnpm --filter @localmail/workers dev
```

The first query/`embed-message` job downloads and caches
`Xenova/all-MiniLM-L6-v2` (384 dimensions); subsequent runs are local. No
hosted embeddings service is used.
