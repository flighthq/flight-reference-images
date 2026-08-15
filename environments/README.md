# Capture environments

Environment records describe the reproducible host used to bless and verify images. Their filename and `id` are the SHA-256 of the canonical descriptor payload, prefixed with `sha256-`.

An execution profile is either a container image pinned by digest or a native execution class whose portability was demonstrated by calibration. A native profile records the architecture and the highest vector instruction set present in the measured hosts; a capture must not claim that environment on a host outside that boundary. Fonts lists only capture dependencies, so it is empty for a corpus that renders no text.

Add a descriptor only after repeated captures agree across independent clean hosts. Record untested boundaries in the linked comparison policy instead of encoding an unmeasured Docker, host, or tolerance claim as fact.
