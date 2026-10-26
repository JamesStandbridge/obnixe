/** Largest protocol frame, in bytes of its JSON text; frames are ASCII, so this also bounds the text length. */
export const maxFrameBytes = 1024 * 1024;

/** Largest relay message: one frame plus its room envelope and the JSON escaping of the frame text. */
export const maxRelayMessageBytes = maxFrameBytes + 64 * 1024;
