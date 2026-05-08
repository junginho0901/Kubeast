// Write tool handler 모음. main.go 에서 추출 (Phase 3.6.f).
//
// 12개 write 도구: apply / create / create_from_url / delete / patch /
// annotate / remove_annotation / label / remove_label / scale / rollout /
// execute_command. 모두 args 파서 + manifestFromArgs/patchFromArgs +
// runKubectl(WithInput) 만 사용.

package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
)

func handleApplyManifest(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	manifest, err := manifestFromArgs(args)
	if err != nil {
		return "", err
	}
	return runKubectlWithInput(ctx, headers, manifest, "apply", "-f", "-")
}

func handleCreateResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	manifest, err := manifestFromArgs(args)
	if err != nil {
		return "", err
	}
	return runKubectlWithInput(ctx, headers, manifest, "create", "-f", "-")
}

func handleCreateResourceFromURL(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	url := argString(args, "url", "")
	if url == "" {
		url = argString(args, "manifest_url", "")
	}
	if url == "" {
		return "", wrapBadRequest("url parameter is required")
	}
	return runKubectl(ctx, headers, "create", "-f", url)
}

func handleDeleteResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	if resourceType == "" {
		return "", wrapBadRequest("resource_type parameter is required")
	}
	resourceName := argString(args, "resource_name", "")
	all := argBool(args, "all")
	if resourceName == "" && !all {
		return "", wrapBadRequest("resource_name parameter is required unless all=true")
	}
	namespace := argString(args, "namespace", "")
	grace := argInt(args, "grace_period", -1)
	force := argBool(args, "force")
	wait := argBool(args, "wait")
	ignoreNotFound := argBool(args, "ignore_not_found")

	cmdArgs := []string{"delete", resourceType}
	if resourceName != "" {
		cmdArgs = append(cmdArgs, resourceName)
	}
	if all {
		cmdArgs = append(cmdArgs, "--all")
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if grace >= 0 {
		cmdArgs = append(cmdArgs, "--grace-period", strconv.Itoa(grace))
	}
	if force {
		cmdArgs = append(cmdArgs, "--force")
	}
	if wait {
		cmdArgs = append(cmdArgs, "--wait=true")
	}
	if ignoreNotFound {
		cmdArgs = append(cmdArgs, "--ignore-not-found=true")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handlePatchResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	patchContent, err := patchFromArgs(args)
	if err != nil {
		return "", err
	}
	namespace := argString(args, "namespace", "")
	patchType := argString(args, "patch_type", "")

	cmdArgs := []string{"patch", resourceType, resourceName, "-p", patchContent}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if patchType != "" {
		cmdArgs = append(cmdArgs, "--type", patchType)
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleAnnotateResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	annotations := argStringMap(args, "annotations")
	if len(annotations) == 0 {
		return "", wrapBadRequest("annotations parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"annotate", resourceType, resourceName}
	for k, v := range annotations {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s=%s", k, v))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleRemoveAnnotation(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	keys := argStringSlice(args, "keys")
	if len(keys) == 0 {
		return "", wrapBadRequest("keys parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"annotate", resourceType, resourceName}
	for _, k := range keys {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s-", k))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleLabelResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	labels := argStringMap(args, "labels")
	if len(labels) == 0 {
		return "", wrapBadRequest("labels parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"label", resourceType, resourceName}
	for k, v := range labels {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s=%s", k, v))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleRemoveLabel(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	keys := argStringSlice(args, "keys")
	if len(keys) == 0 {
		return "", wrapBadRequest("keys parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"label", resourceType, resourceName}
	for _, k := range keys {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s-", k))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleScaleResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	replicas := argInt(args, "replicas", -1)
	if replicas < 0 {
		return "", wrapBadRequest("replicas parameter is required")
	}
	namespace := argString(args, "namespace", "")

	cmdArgs := []string{"scale", resourceType, resourceName, "--replicas", strconv.Itoa(replicas)}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleRollout(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	action := argString(args, "action", "")
	if action == "" {
		return "", wrapBadRequest("action parameter is required")
	}
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	namespace := argString(args, "namespace", "")
	revision := argInt(args, "revision", 0)
	timeout := argString(args, "timeout", "")

	cmdArgs := []string{"rollout", action, fmt.Sprintf("%s/%s", resourceType, resourceName)}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if revision > 0 {
		cmdArgs = append(cmdArgs, "--revision", strconv.Itoa(revision))
	}
	if timeout != "" {
		cmdArgs = append(cmdArgs, "--timeout", timeout)
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleExecuteCommand(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	podName := argString(args, "pod_name", "")
	if podName == "" {
		return "", wrapBadRequest("pod_name parameter is required")
	}
	namespace := argString(args, "namespace", "default")
	container := argString(args, "container", "")
	command := argStringSlice(args, "command")
	if len(command) == 0 {
		command = argStringSlice(args, "cmd")
	}
	if len(command) == 0 {
		return "", wrapBadRequest("command parameter is required")
	}

	cmdArgs := []string{"exec", podName, "-n", namespace}
	if container != "" {
		cmdArgs = append(cmdArgs, "-c", container)
	}
	cmdArgs = append(cmdArgs, "--")
	cmdArgs = append(cmdArgs, command...)
	return runKubectl(ctx, headers, cmdArgs...)
}
