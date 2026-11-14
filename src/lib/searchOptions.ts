// MiniSearch options shared by the prep script (which builds the index) and the app (which loads it).
// Both sides must use exactly the same options.

export type SearchDoc = {
  id: number;
  policyId: string;
  address: string;
  page: number;
  kind: "body" | "glossary" | "references";
  text: string;
  label: string;
};

export const SEARCH_OPTIONS = {
  fields: ["text", "label"],
  storeFields: ["policyId", "address", "page", "kind"],
  searchOptions: {
    boost: { text: 2, label: 1 },
    prefix: false,
    fuzzy: false,
  },
};
