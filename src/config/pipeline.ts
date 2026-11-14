// Pipeline settings (ARCHITECTURE.md §6).

export const PIPELINE = {
  bundles: 3, // Step 9: checklist bundles per questionnaire
  maxPolicyTokensPerCall: 60_000,
  longPolicyTokens: 25_000, // above this, send excerpts instead of the whole policy
  maxChunksPerGroup: 3,
  concurrency: 6, // parallel API calls
  keywordHitsPerItem: 2,
  maxGroupSize: 7, // questions per group (Steps 11–15)
  commonTermPolicies: 15, // an exact search term found in more policies than this is too common to use
  itemsPerBundle: 60, // Step 9: fewer bundles are used when there are few items
  rescueKeywordHits: 3, // Step 14: extra keyword hits read before an item is called "not found"
  promptVersion: "v1", // bump to invalidate saved calls
};
