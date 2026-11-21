# Prints the sign-in token a password sign-in or refresh answer sets, from its response headers (curl -D):
#   curl -s -o /dev/null -D - -X POST … "$GATEWAY/api/v1/auth/login" | awk -f scripts/session-token.awk
# auth-service names the cookie by AUTH_COOKIE_NAME (kubeast.token when unset). Read in this order, the first one set
# printed: __Host-$AUTH_COOKIE_NAME and $AUTH_COOKIE_NAME when that variable is set here, then __Host-kubeast.token and
# kubeast.token. Prints an empty line when none is set.
BEGIN {
  e = ENVIRON["AUTH_COOKIE_NAME"]
  if (e != "") { want[++wants] = "__Host-" e; want[++wants] = e }
  want[++wants] = "__Host-kubeast.token"; want[++wants] = "kubeast.token"
}
{ sub(/\r$/, "") }
tolower(substr($0, 1, 11)) == "set-cookie:" {
  c = substr($0, 12); sub(/^[ \t]+/, "", c); sub(/;.*/, "", c)
  n = index(c, "="); k = substr(c, 1, n - 1); v = substr(c, n + 1)
  if (v != "") got[k] = v
}
END {
  for (i = 1; i <= wants; i++) if (want[i] in got) { print got[want[i]]; exit }
  print ""
}
