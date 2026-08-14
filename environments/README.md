# Capture environments

Environment records describe the reproducible host used to bless and verify images. Their filename and `id` are the SHA-256 of the canonical descriptor payload, prefixed with `sha256-`.

No environment is pre-blessed. Add the first descriptor only after repeated captures agree across independent clean hosts. This keeps the open Flight capture-environment decision visible instead of encoding an unmeasured Docker or SwiftShader claim as fact.
