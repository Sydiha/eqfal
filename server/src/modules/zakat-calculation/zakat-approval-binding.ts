// These hashes identify the exact calculation implementation and complete numerical
// reference suite reviewed for B9. The source-hash test requires a deliberate update
// whenever either changes; existing decisions then fail closed until reviewed again.
export const ZAKAT_ENGINE_VERSION = 'sha256:15d681f44408dabae020c73db0965c4066baca63057abcbfb9c9fd729d28edb0';
export const ZAKAT_REFERENCE_SUITE_DIGEST = 'sha256:541da6bdf138e9ed59bdfe28ae5a74812e0a6e83d763f4fc25047d777601fa63';

export const currentB9Facts = () => ({
  engineVersion: ZAKAT_ENGINE_VERSION,
  referenceSuiteDigest: ZAKAT_REFERENCE_SUITE_DIGEST,
});
