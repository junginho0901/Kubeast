// The longest names the server takes, in characters (auth-service nameMax and userNameMax, ai-service NAME_MAX,
// session-service sessionTitleMax): a name a person reads (a cluster's display name, a role, a team, an AI model's
// name, a conversation's title) and a person's name. A field's maxLength counts UTF-16 units, so it is never looser.
export const NAME_MAX = 100
export const USER_NAME_MAX = 255
