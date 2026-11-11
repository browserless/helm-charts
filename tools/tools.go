//go:build tools

// Package tools is not a program and is never built. Its go.mod lists the Helm,
// kind and actionlint versions that CI uses, so that Dependabot (gomod)
// proposes updates; scripts/install-tools.ts downloads those versions' official
// release binaries. The imports are direct so Dependabot treats them as direct
// dependencies (it skips go.mod `tool` directives, which are indirect).
package tools

import (
	_ "github.com/rhysd/actionlint/cmd/actionlint"
	_ "helm.sh/helm/v4/cmd/helm"
	_ "sigs.k8s.io/kind"
)
