//go:build tools

// Package tools pins the command-line tools that CI builds. Dependabot (gomod)
// updates the versions in go.mod; scripts/build-tools.sh builds exactly those,
// verified by go.sum. The imports are direct so Dependabot treats them as
// direct dependencies (it skips go.mod `tool` directives, which are indirect).
package tools

import (
	_ "github.com/rhysd/actionlint/cmd/actionlint"
	_ "helm.sh/helm/v4/cmd/helm"
	_ "sigs.k8s.io/kind"
)
