// These hashes identify the exact calculation implementation and complete numerical
// reference suite reviewed for B9. The source-hash test requires a deliberate update
// whenever either changes; existing decisions then fail closed until reviewed again.
export const ZAKAT_ENGINE_VERSION = 'sha256:cbafb11dd8262300cb6a3b7300bacf1a006ef29706b9e6a84c21cdd1fa2434cb';
export const ZAKAT_REFERENCE_SUITE_DIGEST = 'sha256:541da6bdf138e9ed59bdfe28ae5a74812e0a6e83d763f4fc25047d777601fa63';

export const currentB9Facts = () => ({
  engineVersion: ZAKAT_ENGINE_VERSION,
  referenceSuiteDigest: ZAKAT_REFERENCE_SUITE_DIGEST,
});
