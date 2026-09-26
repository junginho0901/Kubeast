module github.com/junginho0901/kubeast/tool-server

go 1.26.0

require github.com/junginho0901/kubeast/services/pkg v0.0.0

require github.com/golang-jwt/jwt/v5 v5.2.1 // indirect

replace github.com/junginho0901/kubeast/services/pkg => ../pkg
