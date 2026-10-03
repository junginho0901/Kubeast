// Resource types that have no list verb (virtual / review resources): never
// offered in the picker and never queried.
export const NON_LISTABLE = new Set([
  'bindings', 'localsubjectaccessreviews', 'selfsubjectaccessreviews',
  'selfsubjectrulesreviews', 'subjectaccessreviews', 'tokenreviews',
  'localresourceaccessreviews', 'resourceaccessreviews',
  'tokenrequests', 'selfsubjectreviews',
])
