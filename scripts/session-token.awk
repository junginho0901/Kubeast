# Prints the sign-in token a password sign-in or refresh answer sets, from its response headers (curl -D):
#   curl -s -o /dev/null -D - -X POST … "$GATEWAY/api/v1/auth/login" | awk -f scripts/session-token.awk
# The cookie is kubeast.token, or __Host-kubeast.token on an https install; both are read, the __Host- one first.
# Prints an empty line when neither is set.
{ sub(/\r$/, "") }
tolower(substr($0, 1, 11)) == "set-cookie:" {
  c = substr($0, 12); sub(/^[ \t]+/, "", c); sub(/;.*/, "", c)
  n = index(c, "="); k = substr(c, 1, n - 1); v = substr(c, n + 1)
  if (v == "") next
  if (k == "__Host-kubeast.token") host = v
  else if (k == "kubeast.token") plain = v
}
END { print (host != "" ? host : plain) }
